import asyncio
import posixpath
import stat as statmod
import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import auth, log
from ..ssh_manager import manager, get_host

logger = log.get("transfers")
router = APIRouter(prefix="/api", tags=["transfers"])

TRANSFERS: dict[str, dict] = {}


class TransferIn(BaseModel):
    src_host_id: int
    src_path: str
    dst_host_id: int
    dst_path: str          # destination directory
    is_dir: bool = False


async def _copy_file(ssftp, dsftp, src, dst, t):
    sf = await ssftp.open(src, "rb")
    try:
        df = await dsftp.open(dst, "wb")
        try:
            while True:
                chunk = await sf.read(1024 * 1024)
                if not chunk:
                    break
                await df.write(chunk)
                t["done"] += len(chunk)
        finally:
            await df.close()
    finally:
        await sf.close()


async def _copy_dir(ssftp, dsftp, src, dst, t):
    try:
        await dsftp.mkdir(dst)
    except Exception:
        pass  # already exists
    for e in await ssftp.readdir(src):
        if e.filename in (".", ".."):
            continue
        s = posixpath.join(src, e.filename)
        d = posixpath.join(dst, e.filename)
        if statmod.S_ISDIR(e.attrs.permissions or 0):
            await _copy_dir(ssftp, dsftp, s, d, t)
        else:
            await _copy_file(ssftp, dsftp, s, d, t)


async def _run_transfer(t, uid, src_host, dst_host, body: TransferIn):
    try:
        ssftp = await manager.sftp(uid, src_host)
        dsftp = await manager.sftp(uid, dst_host)
        name = posixpath.basename(body.src_path.rstrip("/"))
        dst = posixpath.join(body.dst_path, name)
        if body.is_dir:
            t["total"] = None
            await _copy_dir(ssftp, dsftp, body.src_path, dst, t)
        else:
            attrs = await ssftp.stat(body.src_path)
            t["total"] = attrs.size
            await _copy_file(ssftp, dsftp, body.src_path, dst, t)
        t["status"] = "done"
        logger.info("transfer done: %s (%s bytes)", t["desc"], t["done"])
    except Exception as e:
        t["status"] = "error"
        t["error"] = str(e)
        logger.error("transfer failed: %s — %s", t["desc"], e)


@router.post("/transfer")
async def start_transfer(body: TransferIn, user=Depends(auth.current_user)):
    uid = user["id"]
    src_host = get_host(uid, body.src_host_id)
    dst_host = get_host(uid, body.dst_host_id)
    tid = uuid.uuid4().hex[:12]
    t = {"id": tid, "uid": uid, "status": "running", "done": 0, "total": 0,
         "error": None,
         "desc": f'{src_host["label"]}:{body.src_path} → {dst_host["label"]}:{body.dst_path}'}
    TRANSFERS[tid] = t
    logger.info("transfer start: %s (user=%s)", t["desc"], user["username"])
    asyncio.create_task(_run_transfer(t, uid, src_host, dst_host, body))
    return {"id": tid}


@router.get("/transfers")
def list_transfers(user=Depends(auth.current_user)):
    mine = [
        {k: v for k, v in t.items() if k != "uid"}
        for t in TRANSFERS.values() if t["uid"] == user["id"]
    ]
    return {"transfers": mine}


@router.delete("/transfers/{tid}")
def clear_transfer(tid: str, user=Depends(auth.current_user)):
    t = TRANSFERS.get(tid)
    if t and t["uid"] == user["id"] and t["status"] != "running":
        TRANSFERS.pop(tid, None)
    return {"ok": True}
