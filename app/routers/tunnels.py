from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import auth, db, log
from ..ssh_manager import manager, get_host

logger = log.get("tunnels")
router = APIRouter(prefix="/api", tags=["tunnels"])

# (user_id, tunnel_id) -> asyncssh SSHListener
ACTIVE: dict[tuple, object] = {}


class TunnelIn(BaseModel):
    host_id: int
    name: str
    listen_port: int
    dest_host: str = "localhost"
    dest_port: int


@router.get("/tunnels")
def list_tunnels(user=Depends(auth.current_user)):
    uid = user["id"]
    rows = db.q(
        "SELECT t.*, h.label AS host_label FROM tunnels t "
        "JOIN hosts h ON h.id = t.host_id WHERE t.user_id=? ORDER BY t.name", (uid,))
    return {"tunnels": [dict(r) | {"active": (uid, r["id"]) in ACTIVE} for r in rows]}


@router.post("/tunnels")
def create_tunnel(body: TunnelIn, user=Depends(auth.current_user)):
    get_host(user["id"], body.host_id)
    if not (1 <= body.listen_port <= 65535 and 1 <= body.dest_port <= 65535):
        raise HTTPException(400, "Ports must be 1-65535")
    tid = db.x("INSERT INTO tunnels(user_id, host_id, name, listen_port, dest_host, dest_port) "
               "VALUES(?,?,?,?,?,?)",
               (user["id"], body.host_id, body.name.strip() or f"tunnel-{body.listen_port}",
                body.listen_port, body.dest_host.strip() or "localhost", body.dest_port))
    return {"id": tid}


@router.delete("/tunnels/{tid}")
def delete_tunnel(tid: int, user=Depends(auth.current_user)):
    _stop(user["id"], tid)
    db.x("DELETE FROM tunnels WHERE id=? AND user_id=?", (tid, user["id"]))
    return {"ok": True}


@router.post("/tunnels/{tid}/start")
async def start_tunnel(tid: int, user=Depends(auth.current_user)):
    uid = user["id"]
    t = db.one("SELECT * FROM tunnels WHERE id=? AND user_id=?", (tid, uid))
    if not t:
        raise HTTPException(404, "Tunnel not found")
    if (uid, tid) in ACTIVE:
        return {"ok": True, "note": "already running"}
    host = get_host(uid, t["host_id"])
    try:
        conn = await manager.get(uid, host)
        listener = await conn.forward_local_port(
            "0.0.0.0", t["listen_port"], t["dest_host"], t["dest_port"])
    except OSError as e:
        raise HTTPException(409, f"Listen port {t['listen_port']} unavailable: {e}")
    except Exception as e:
        raise HTTPException(502, f"Tunnel failed: {e}")
    ACTIVE[(uid, tid)] = listener
    logger.info("tunnel started: %s :%s → %s:%s via %s (user=%s)",
                t["name"], t["listen_port"], t["dest_host"], t["dest_port"],
                host["label"], user["username"])
    return {"ok": True}


def _stop(uid: int, tid: int):
    listener = ACTIVE.pop((uid, tid), None)
    if listener is not None:
        try:
            listener.close()
        except Exception:
            pass
        return True
    return False


@router.post("/tunnels/{tid}/stop")
def stop_tunnel(tid: int, user=Depends(auth.current_user)):
    if _stop(user["id"], tid):
        logger.info("tunnel stopped: id=%s user=%s", tid, user["username"])
    return {"ok": True}
