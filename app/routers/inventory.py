from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import auth, crypto, db, log
from ..ssh_manager import manager, get_host

logger = log.get("inventory")
router = APIRouter(prefix="/api", tags=["inventory"])


@router.get("/state")
def state(user=Depends(auth.current_user)):
    uid = user["id"]
    folders = [dict(r) for r in db.q(
        "SELECT id, name FROM folders WHERE user_id=? ORDER BY name", (uid,))]
    hosts = [dict(r) for r in db.q(
        "SELECT id, folder_id, label, hostname, port, username, auth_type, key_id, identity_id, "
        "(password_enc IS NOT NULL) AS has_password "
        "FROM hosts WHERE user_id=? ORDER BY label", (uid,))]
    keys = [dict(r) for r in db.q(
        "SELECT id, name FROM keys WHERE user_id=? ORDER BY name", (uid,))]
    identities = [dict(r) for r in db.q(
        "SELECT id, name, username FROM identities WHERE user_id=? ORDER BY name", (uid,))]
    return {"username": user["username"], "folders": folders, "hosts": hosts,
            "keys": keys, "identities": identities}


class FolderIn(BaseModel):
    name: str


@router.post("/folders")
def create_folder(body: FolderIn, user=Depends(auth.current_user)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    existing = db.one("SELECT id FROM folders WHERE user_id=? AND name=?", (user["id"], name))
    if existing:
        return {"id": existing["id"]}
    return {"id": db.x("INSERT INTO folders(user_id, name) VALUES(?,?)", (user["id"], name))}


@router.put("/folders/{folder_id}")
def rename_folder(folder_id: int, body: FolderIn, user=Depends(auth.current_user)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name required")
    db.x("UPDATE folders SET name=? WHERE id=? AND user_id=?", (name, folder_id, user["id"]))
    return {"ok": True}


@router.delete("/folders/{folder_id}")
def delete_folder(folder_id: int, user=Depends(auth.current_user)):
    db.x("UPDATE hosts SET folder_id=NULL WHERE folder_id=? AND user_id=?", (folder_id, user["id"]))
    db.x("DELETE FROM folders WHERE id=? AND user_id=?", (folder_id, user["id"]))
    return {"ok": True}


class HostIn(BaseModel):
    label: str
    hostname: str
    port: int = 22
    username: str = ""
    auth_type: str = "password"   # password | key | identity
    password: str | None = None
    key_id: int | None = None
    identity_id: int | None = None
    folder_id: int | None = None


@router.post("/hosts")
def create_host(body: HostIn, user=Depends(auth.current_user)):
    hid = db.x(
        "INSERT INTO hosts(user_id, folder_id, label, hostname, port, username, "
        "auth_type, password_enc, key_id, identity_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (user["id"], body.folder_id, body.label.strip() or body.hostname,
         body.hostname.strip(), body.port, body.username.strip(),
         body.auth_type, crypto.enc(body.password), body.key_id, body.identity_id))
    logger.info("host added: %s (%s@%s:%s) by user=%s",
                body.label, body.username, body.hostname, body.port, user["username"])
    return {"id": hid}


@router.put("/hosts/{host_id}")
def update_host(host_id: int, body: HostIn, user=Depends(auth.current_user)):
    host = get_host(user["id"], host_id)
    # blank password in the form means "keep existing"
    pw_enc = crypto.enc(body.password) if body.password else host["password_enc"]
    db.x("UPDATE hosts SET folder_id=?, label=?, hostname=?, port=?, username=?, "
         "auth_type=?, password_enc=?, key_id=?, identity_id=? WHERE id=? AND user_id=?",
         (body.folder_id, body.label.strip() or body.hostname, body.hostname.strip(),
          body.port, body.username.strip(), body.auth_type, pw_enc, body.key_id,
          body.identity_id, host_id, user["id"]))
    manager.drop(user["id"], host_id)
    return {"ok": True}


class MoveIn(BaseModel):
    folder_id: int | None = None


@router.post("/hosts/{host_id}/move")
def move_host(host_id: int, body: MoveIn, user=Depends(auth.current_user)):
    get_host(user["id"], host_id)
    db.x("UPDATE hosts SET folder_id=? WHERE id=? AND user_id=?",
         (body.folder_id, host_id, user["id"]))
    return {"ok": True}


@router.post("/hosts/{host_id}/duplicate")
def duplicate_host(host_id: int, user=Depends(auth.current_user)):
    """Copy a host including its stored credential — for quick edit-and-save."""
    h = get_host(user["id"], host_id)
    hid = db.x(
        "INSERT INTO hosts(user_id, folder_id, label, hostname, port, username, "
        "auth_type, password_enc, key_id, identity_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (user["id"], h["folder_id"], h["label"] + " (copy)", h["hostname"], h["port"],
         h["username"], h["auth_type"], h["password_enc"], h["key_id"], h["identity_id"]))
    return {"id": hid}


@router.post("/hosts/{host_id}/disconnect")
def disconnect_host(host_id: int, user=Depends(auth.current_user)):
    """Release only the SFTP session; terminals keep their connection."""
    get_host(user["id"], host_id)
    manager.drop_sftp(user["id"], host_id)
    logger.info("sftp session released host_id=%s by user=%s", host_id, user["username"])
    return {"ok": True}


@router.delete("/hosts/{host_id}")
def delete_host(host_id: int, user=Depends(auth.current_user)):
    manager.drop(user["id"], host_id)
    db.x("DELETE FROM hosts WHERE id=? AND user_id=?", (host_id, user["id"]))
    return {"ok": True}
