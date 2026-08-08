import json

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse, Response

from .. import auth, crypto, db, log, mobaconf

logger = log.get("portability")
router = APIRouter(prefix="/api", tags=["portability"])


@router.post("/import/mobaconf")
async def import_mobaconf(file: UploadFile = File(...), user=Depends(auth.current_user)):
    text = (await file.read()).decode("utf-8", errors="replace")
    sessions = mobaconf.parse(text)
    uid = user["id"]
    imported = skipped = 0
    for s in sessions:
        folder_id = None
        if s["folder"]:
            row = db.one("SELECT id FROM folders WHERE user_id=? AND name=?", (uid, s["folder"]))
            folder_id = row["id"] if row else db.x(
                "INSERT INTO folders(user_id, name) VALUES(?,?)", (uid, s["folder"]))
        dup = db.one("SELECT id FROM hosts WHERE user_id=? AND hostname=? AND port=? AND username=?",
                     (uid, s["hostname"], s["port"], s["username"]))
        if dup:
            skipped += 1
            continue
        db.x("INSERT INTO hosts(user_id, folder_id, label, hostname, port, username, auth_type) "
             "VALUES(?,?,?,?,?,?, 'password')",
             (uid, folder_id, s["label"], s["hostname"], s["port"], s["username"]))
        imported += 1
    logger.info("mobaconf import by user=%s: %s imported, %s skipped",
                user["username"], imported, skipped)
    return {"imported": imported, "skipped": skipped,
            "note": "Passwords are not in mobaconf exports in usable form - set them per host."}


@router.get("/export/sshdeck")
def export_sshdeck(user=Depends(auth.current_user)):
    """Full backup: folders, identities, keys, hosts — secrets DECRYPTED.
    Restorable on any SSHDeck instance regardless of its encryption key."""
    uid = user["id"]
    folders = {f["id"]: f["name"] for f in db.q(
        "SELECT * FROM folders WHERE user_id=?", (uid,))}
    idents = {i["id"]: i for i in db.q(
        "SELECT * FROM identities WHERE user_id=?", (uid,))}
    keys = {k["id"]: k for k in db.q("SELECT * FROM keys WHERE user_id=?", (uid,))}
    data = {
        "app": "sshdeck", "version": 1,
        "folders": sorted(folders.values()),
        "identities": [{"name": i["name"], "username": i["username"],
                        "password": crypto.dec(i["password_enc"])} for i in idents.values()],
        "keys": [{"name": k["name"], "private_key": crypto.dec(k["private_enc"]),
                  "passphrase": crypto.dec(k["passphrase_enc"])} for k in keys.values()],
        "hosts": [{
            "label": h["label"], "hostname": h["hostname"], "port": h["port"],
            "username": h["username"], "auth_type": h["auth_type"],
            "password": crypto.dec(h["password_enc"]),
            "folder": folders.get(h["folder_id"]),
            "key": keys[h["key_id"]]["name"] if h["key_id"] in keys else None,
            "identity": idents[h["identity_id"]]["name"] if h["identity_id"] in idents else None,
        } for h in db.q("SELECT * FROM hosts WHERE user_id=?", (uid,))],
    }
    logger.info("full backup exported by user=%s (%s hosts)", user["username"], len(data["hosts"]))
    return Response(json.dumps(data, indent=2), media_type="application/json",
                    headers={"Content-Disposition": 'attachment; filename="sshdeck-backup.json"'})


@router.post("/import/sshdeck")
async def import_sshdeck(file: UploadFile = File(...), user=Depends(auth.current_user)):
    """Restore a sshdeck-backup.json — merges by name, skips duplicates."""
    uid = user["id"]
    try:
        data = json.loads((await file.read()).decode("utf-8"))
        assert data.get("app") == "sshdeck"
    except Exception:
        raise HTTPException(400, "Not a valid sshdeck-backup.json")

    def folder_id_of(name):
        if not name:
            return None
        row = db.one("SELECT id FROM folders WHERE user_id=? AND name=?", (uid, name))
        return row["id"] if row else db.x(
            "INSERT INTO folders(user_id, name) VALUES(?,?)", (uid, name))

    for name in data.get("folders", []):
        folder_id_of(name)

    ident_ids, key_ids = {}, {}
    for i in data.get("identities", []):
        row = db.one("SELECT id FROM identities WHERE user_id=? AND name=?", (uid, i["name"]))
        ident_ids[i["name"]] = row["id"] if row else db.x(
            "INSERT INTO identities(user_id, name, username, password_enc) VALUES(?,?,?,?)",
            (uid, i["name"], i["username"], crypto.enc(i.get("password"))))
    for k in data.get("keys", []):
        row = db.one("SELECT id FROM keys WHERE user_id=? AND name=?", (uid, k["name"]))
        key_ids[k["name"]] = row["id"] if row else db.x(
            "INSERT INTO keys(user_id, name, private_enc, passphrase_enc) VALUES(?,?,?,?)",
            (uid, k["name"], crypto.enc(k.get("private_key")), crypto.enc(k.get("passphrase"))))

    imported = skipped = 0
    for h in data.get("hosts", []):
        dup = db.one("SELECT id FROM hosts WHERE user_id=? AND hostname=? AND port=? AND username=?",
                     (uid, h["hostname"], h.get("port", 22), h.get("username", "")))
        if dup:
            skipped += 1
            continue
        db.x("INSERT INTO hosts(user_id, folder_id, label, hostname, port, username, "
             "auth_type, password_enc, key_id, identity_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
             (uid, folder_id_of(h.get("folder")), h.get("label") or h["hostname"],
              h["hostname"], h.get("port", 22), h.get("username", ""),
              h.get("auth_type", "password"), crypto.enc(h.get("password")),
              key_ids.get(h.get("key")), ident_ids.get(h.get("identity"))))
        imported += 1
    logger.info("full backup imported by user=%s: %s hosts, %s skipped",
                user["username"], imported, skipped)
    return {"imported": imported, "skipped": skipped,
            "identities": len(ident_ids), "keys": len(key_ids)}


@router.get("/export/mobaconf")
def export_mobaconf(user=Depends(auth.current_user)):
    uid = user["id"]
    groups = []
    root = db.q("SELECT * FROM hosts WHERE user_id=? AND folder_id IS NULL ORDER BY label", (uid,))
    groups.append(("", [dict(r) for r in root]))
    for f in db.q("SELECT * FROM folders WHERE user_id=? ORDER BY name", (uid,)):
        hosts = db.q("SELECT * FROM hosts WHERE user_id=? AND folder_id=? ORDER BY label",
                     (uid, f["id"]))
        groups.append((f["name"], [dict(r) for r in hosts]))
    text = mobaconf.export(groups)
    return PlainTextResponse(text, headers={
        "Content-Disposition": 'attachment; filename="sshdeck-export.mobaconf"'})
