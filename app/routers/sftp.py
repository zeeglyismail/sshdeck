import posixpath
import stat as statmod

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import auth, log
from ..ssh_manager import manager, get_host

logger = log.get("sftp")
router = APIRouter(prefix="/api/sftp", tags=["sftp"])

CHUNK = 1024 * 512


def _mode_str(mode: int, is_dir: bool) -> str:
    chars = "rwxrwxrwx"
    out = "d" if is_dir else "-"
    for i in range(9):
        out += chars[i] if mode & (1 << (8 - i)) else "-"
    return out


@router.get("/{host_id}/list")
async def sftp_list(host_id: int, path: str = ".", user=Depends(auth.current_user)):
    host = get_host(user["id"], host_id)
    try:
        sftp = await manager.sftp(user["id"], host)
        path = await sftp.realpath(path)
        entries = []
        for e in await sftp.readdir(path):
            if e.filename in (".", ".."):
                continue
            mode = e.attrs.permissions or 0
            is_dir = statmod.S_ISDIR(mode)
            if statmod.S_ISLNK(mode):
                try:
                    st = await sftp.stat(posixpath.join(path, e.filename))
                    is_dir = statmod.S_ISDIR(st.permissions or 0)
                except Exception:
                    pass
            entries.append({
                "name": e.filename,
                "is_dir": is_dir,
                "size": e.attrs.size or 0,
                "mtime": e.attrs.mtime or 0,
                "perm": _mode_str(mode & 0o777, is_dir),
            })
        entries.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
        return {"path": path, "entries": entries}
    except Exception as e:
        logger.error("list failed host=%s path=%s: %s", host["label"], path, e)
        raise HTTPException(502, f"SFTP error: {e}")


@router.get("/{host_id}/download")
async def sftp_download(host_id: int, path: str, user=Depends(auth.current_user)):
    host = get_host(user["id"], host_id)
    sftp = await manager.sftp(user["id"], host)
    try:
        attrs = await sftp.stat(path)
        f = await sftp.open(path, "rb")
    except Exception as e:
        logger.error("download failed host=%s path=%s: %s", host["label"], path, e)
        raise HTTPException(502, f"SFTP error: {e}")

    async def gen():
        try:
            while True:
                chunk = await f.read(CHUNK)
                if not chunk:
                    break
                yield chunk
        finally:
            await f.close()

    name = posixpath.basename(path)
    headers = {"Content-Disposition": f'attachment; filename="{name}"'}
    if attrs.size is not None:
        headers["Content-Length"] = str(attrs.size)
    logger.info("download start host=%s path=%s size=%s user=%s",
                host["label"], path, attrs.size, user["username"])
    return StreamingResponse(gen(), media_type="application/octet-stream", headers=headers)


@router.post("/{host_id}/upload")
async def sftp_upload(host_id: int, path: str = Form(...), file: UploadFile = File(...),
                      user=Depends(auth.current_user)):
    host = get_host(user["id"], host_id)
    sftp = await manager.sftp(user["id"], host)
    dest = posixpath.join(path, file.filename)
    try:
        f = await sftp.open(dest, "wb")
        while True:
            chunk = await file.read(CHUNK)
            if not chunk:
                break
            await f.write(chunk)
        await f.close()
    except Exception as e:
        logger.error("upload failed host=%s dest=%s: %s", host["label"], dest, e)
        raise HTTPException(502, f"Upload failed: {e}")
    logger.info("upload done host=%s dest=%s user=%s", host["label"], dest, user["username"])
    return {"ok": True}


class PathOp(BaseModel):
    path: str
    new_path: str | None = None
    mode: str | None = None
    is_dir: bool = False


@router.post("/{host_id}/mkdir")
async def sftp_mkdir(host_id: int, body: PathOp, user=Depends(auth.current_user)):
    host = get_host(user["id"], host_id)
    sftp = await manager.sftp(user["id"], host)
    try:
        await sftp.mkdir(body.path)
    except Exception as e:
        raise HTTPException(502, f"mkdir failed: {e}")
    return {"ok": True}


@router.post("/{host_id}/rename")
async def sftp_rename(host_id: int, body: PathOp, user=Depends(auth.current_user)):
    host = get_host(user["id"], host_id)
    sftp = await manager.sftp(user["id"], host)
    try:
        await sftp.rename(body.path, body.new_path)
    except Exception as e:
        raise HTTPException(502, f"rename failed: {e}")
    return {"ok": True}


@router.post("/{host_id}/chmod")
async def sftp_chmod(host_id: int, body: PathOp, user=Depends(auth.current_user)):
    host = get_host(user["id"], host_id)
    sftp = await manager.sftp(user["id"], host)
    try:
        await sftp.chmod(body.path, int(body.mode, 8))
    except Exception as e:
        raise HTTPException(502, f"chmod failed: {e}")
    return {"ok": True}


@router.post("/{host_id}/delete")
async def sftp_delete(host_id: int, body: PathOp, user=Depends(auth.current_user)):
    host = get_host(user["id"], host_id)
    sftp = await manager.sftp(user["id"], host)

    async def rm(path, is_dir):
        if is_dir:
            for e in await sftp.readdir(path):
                if e.filename in (".", ".."):
                    continue
                mode = e.attrs.permissions or 0
                await rm(posixpath.join(path, e.filename), statmod.S_ISDIR(mode))
            await sftp.rmdir(path)
        else:
            await sftp.remove(path)

    try:
        await rm(body.path, body.is_dir)
    except Exception as e:
        logger.error("delete failed host=%s path=%s: %s", host["label"], body.path, e)
        raise HTTPException(502, f"delete failed: {e}")
    logger.info("deleted host=%s path=%s user=%s", host["label"], body.path, user["username"])
    return {"ok": True}
