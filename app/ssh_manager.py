import asyncio
from collections import defaultdict

import asyncssh

from . import crypto, db, log

logger = log.get("ssh")


class SSHManager:
    """Pools one SSH connection per (user, host); terminals, SFTP and stats
    multiplex channels over it."""

    def __init__(self):
        self._conns: dict[tuple, asyncssh.SSHClientConnection] = {}
        self._sftp: dict[tuple, asyncssh.SFTPClient] = {}
        self._locks: dict[tuple, asyncio.Lock] = defaultdict(asyncio.Lock)

    def _connect_args(self, host):
        kwargs = dict(
            host=host["hostname"],
            port=host["port"] or 22,
            username=host["username"],
            known_hosts=None,
            keepalive_interval=20,
            connect_timeout=15,
        )
        if host["auth_type"] == "identity" and host["identity_id"]:
            ident = db.one("SELECT * FROM identities WHERE id=? AND user_id=?",
                           (host["identity_id"], host["user_id"]))
            if not ident:
                raise RuntimeError("Saved identity not found")
            kwargs["username"] = ident["username"]
            kwargs["password"] = crypto.dec(ident["password_enc"])
        elif host["auth_type"] == "key" and host["key_id"]:
            key = db.one("SELECT * FROM keys WHERE id=? AND user_id=?",
                         (host["key_id"], host["user_id"]))
            if not key:
                raise RuntimeError("SSH key not found")
            pkey = asyncssh.import_private_key(
                crypto.dec(key["private_enc"]),
                passphrase=crypto.dec(key["passphrase_enc"]))
            kwargs["client_keys"] = [pkey]
        else:
            pw = crypto.dec(host["password_enc"])
            if pw is None:
                raise RuntimeError("No password stored for this host")
            kwargs["password"] = pw
        return kwargs

    def _alive(self, conn) -> bool:
        try:
            return conn is not None and not conn.is_closed()
        except Exception:
            return False

    async def get(self, uid: int, host) -> asyncssh.SSHClientConnection:
        key = (uid, host["id"])
        async with self._locks[key]:
            conn = self._conns.get(key)
            if self._alive(conn):
                return conn
            self._sftp.pop(key, None)
            try:
                conn = await asyncssh.connect(**self._connect_args(host))
            except Exception as e:
                logger.error("SSH connect failed %s@%s:%s — %s",
                             host["username"], host["hostname"], host["port"], e)
                raise
            logger.info("SSH connected %s@%s:%s (uid=%s)",
                        conn.get_extra_info("username") or host["username"],
                        host["hostname"], host["port"], uid)
            self._conns[key] = conn
            return conn

    async def sftp(self, uid: int, host) -> asyncssh.SFTPClient:
        key = (uid, host["id"])
        conn = await self.get(uid, host)
        async with self._locks[key]:
            client = self._sftp.get(key)
            if client is not None:
                try:
                    await client.stat(".")
                    return client
                except Exception:
                    self._sftp.pop(key, None)
            client = await conn.start_sftp_client()
            self._sftp[key] = client
            return client

    def drop_sftp(self, uid: int, host_id: int):
        """Close only the SFTP session — terminals on the same connection live on."""
        client = self._sftp.pop((uid, host_id), None)
        if client is not None:
            try:
                client.exit()
            except Exception:
                pass

    def drop(self, uid: int, host_id: int):
        key = (uid, host_id)
        self._sftp.pop(key, None)
        conn = self._conns.pop(key, None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


manager = SSHManager()


def get_host(uid: int, host_id: int):
    host = db.one("SELECT * FROM hosts WHERE id=? AND user_id=?", (host_id, uid))
    if not host:
        raise RuntimeError("Host not found")
    return host
