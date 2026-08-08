from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from .. import auth, db, log

logger = log.get("account")
router = APIRouter(prefix="/api", tags=["account"])


class Credentials(BaseModel):
    username: str
    password: str


@router.post("/signup")
def signup(body: Credentials, request: Request):
    username = body.username.strip()
    if not username or len(body.password) < 4:
        raise HTTPException(400, "Username required, password min 4 chars")
    if db.one("SELECT id FROM users WHERE username=?", (username,)):
        raise HTTPException(409, "Username already taken")
    uid = db.x("INSERT INTO users(username, pw_hash) VALUES(?,?)",
               (username, auth.hash_pw(body.password)))
    request.session["uid"] = uid
    logger.info("new user signed up: %s (id=%s)", username, uid)
    return {"ok": True}


@router.post("/login")
def login(body: Credentials, request: Request):
    user = db.one("SELECT * FROM users WHERE username=?", (body.username.strip(),))
    if not user or not auth.check_pw(body.password, user["pw_hash"]):
        logger.warning("failed login attempt for username=%r", body.username.strip())
        raise HTTPException(401, "Invalid username or password")
    request.session["uid"] = user["id"]
    logger.info("user logged in: %s", user["username"])
    return {"ok": True}


@router.post("/logout")
def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@router.get("/me")
def me(user=Depends(auth.current_user)):
    return {"id": user["id"], "username": user["username"]}
