from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import auth, crypto, db, log
from ..ssh_manager import manager

logger = log.get("credentials")
router = APIRouter(prefix="/api", tags=["credentials"])


# ---------- identities (username + password templates) ----------

class IdentityIn(BaseModel):
    name: str
    username: str
    password: str | None = None


@router.post("/identities")
def create_identity(body: IdentityIn, user=Depends(auth.current_user)):
    if not body.name.strip() or not body.username.strip() or not body.password:
        raise HTTPException(400, "Name, username and password required")
    iid = db.x("INSERT INTO identities(user_id, name, username, password_enc) VALUES(?,?,?,?)",
               (user["id"], body.name.strip(), body.username.strip(), crypto.enc(body.password)))
    logger.info("identity created: %s by user=%s", body.name, user["username"])
    return {"id": iid}


@router.put("/identities/{ident_id}")
def update_identity(ident_id: int, body: IdentityIn, user=Depends(auth.current_user)):
    ident = db.one("SELECT * FROM identities WHERE id=? AND user_id=?", (ident_id, user["id"]))
    if not ident:
        raise HTTPException(404, "Identity not found")
    pw_enc = crypto.enc(body.password) if body.password else ident["password_enc"]
    db.x("UPDATE identities SET name=?, username=?, password_enc=? WHERE id=? AND user_id=?",
         (body.name.strip(), body.username.strip(), pw_enc, ident_id, user["id"]))
    # connections made with the old credentials may be stale
    for h in db.q("SELECT id FROM hosts WHERE identity_id=? AND user_id=?", (ident_id, user["id"])):
        manager.drop(user["id"], h["id"])
    return {"ok": True}


@router.delete("/identities/{ident_id}")
def delete_identity(ident_id: int, user=Depends(auth.current_user)):
    used = db.one("SELECT id FROM hosts WHERE identity_id=? AND user_id=?", (ident_id, user["id"]))
    if used:
        raise HTTPException(409, "Identity is used by a saved host")
    db.x("DELETE FROM identities WHERE id=? AND user_id=?", (ident_id, user["id"]))
    return {"ok": True}


# ---------- SSH keys ----------

class KeyIn(BaseModel):
    name: str
    private_key: str
    passphrase: str | None = None


@router.post("/keys")
def create_key(body: KeyIn, user=Depends(auth.current_user)):
    kid = db.x("INSERT INTO keys(user_id, name, private_enc, passphrase_enc) VALUES(?,?,?,?)",
               (user["id"], body.name.strip(), crypto.enc(body.private_key),
                crypto.enc(body.passphrase)))
    logger.info("ssh key added: %s by user=%s", body.name, user["username"])
    return {"id": kid}


@router.delete("/keys/{key_id}")
def delete_key(key_id: int, user=Depends(auth.current_user)):
    used = db.one("SELECT id FROM hosts WHERE key_id=? AND user_id=?", (key_id, user["id"]))
    if used:
        raise HTTPException(409, "Key is used by a saved host")
    db.x("DELETE FROM keys WHERE id=? AND user_id=?", (key_id, user["id"]))
    return {"ok": True}
