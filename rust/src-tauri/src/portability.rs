//! Import of the web app's `sshdeck-backup.json` (v1/v2) and factory reset.

use crate::crypto::Crypto;
use crate::db::Db;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Deserialize)]
struct BackupIdentity {
    name: String,
    username: String,
    password: Option<String>,
}
#[derive(Deserialize)]
struct BackupKey {
    name: String,
    private_key: Option<String>,
    passphrase: Option<String>,
}
#[derive(Deserialize)]
struct BackupHost {
    label: Option<String>,
    hostname: String,
    #[serde(default = "d22")]
    port: u16,
    #[serde(default)]
    username: String,
    #[serde(default = "d_pw")]
    auth_type: String,
    password: Option<String>,
    folder: Option<String>,
    key: Option<String>,
    identity: Option<String>,
}
fn d22() -> u16 { 22 }
fn d_pw() -> String { "password".into() }

#[derive(Deserialize)]
struct Backup {
    app: String,
    #[serde(default)]
    folders: Vec<String>,
    #[serde(default)]
    identities: Vec<BackupIdentity>,
    #[serde(default)]
    keys: Vec<BackupKey>,
    #[serde(default)]
    hosts: Vec<BackupHost>,
}

#[derive(Serialize)]
pub struct ImportResult {
    hosts: usize,
    skipped: usize,
    folders: usize,
    identities: usize,
    keys: usize,
}

/// "Parent/Child" (or "Parent\Child") → folder id, creating each level as needed
pub(crate) fn folder_id_for_path(conn: &rusqlite::Connection, path: &str) -> Option<i64> {
    let mut parent: Option<i64> = None;
    let mut any = false;
    for name in path.replace('\\', "/").split('/').filter(|p| !p.is_empty()) {
        any = true;
        let existing: Option<i64> = conn
            .query_row(
                "SELECT id FROM folders WHERE name=?1 AND parent_id IS ?2",
                rusqlite::params![name, parent],
                |r| r.get(0),
            )
            .ok();
        parent = Some(match existing {
            Some(id) => id,
            None => {
                conn.execute("INSERT INTO folders(name, parent_id) VALUES(?1, ?2)", rusqlite::params![name, parent]).ok();
                conn.last_insert_rowid()
            }
        });
    }
    if any { parent } else { None }
}

#[tauri::command]
pub fn import_backup(db: State<Db>, crypto: State<Crypto>, path: String) -> Result<ImportResult, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read file: {e}"))?;
    let b: Backup = serde_json::from_str(&text).map_err(|e| format!("not a valid backup: {e}"))?;
    if b.app != "sshdeck" {
        return Err("not an SSHDeck backup".into());
    }
    let conn = db.0.lock().unwrap();
    let mut res = ImportResult { hosts: 0, skipped: 0, folders: 0, identities: 0, keys: 0 };

    for p in &b.folders {
        if folder_id_for_path(&conn, p).is_some() { res.folders += 1; }
    }
    let mut ident_ids = std::collections::HashMap::new();
    for i in &b.identities {
        let id: i64 = match conn.query_row("SELECT id FROM identities WHERE name=?1", [&i.name], |r| r.get(0)) {
            Ok(id) => id,
            Err(_) => {
                conn.execute(
                    "INSERT INTO identities(name, username, password_enc) VALUES(?1,?2,?3)",
                    rusqlite::params![i.name, i.username, crypto.enc(i.password.as_deref().unwrap_or(""))],
                ).map_err(|e| e.to_string())?;
                res.identities += 1;
                conn.last_insert_rowid()
            }
        };
        ident_ids.insert(i.name.clone(), id);
    }
    let mut key_ids = std::collections::HashMap::new();
    for k in &b.keys {
        let id: i64 = match conn.query_row("SELECT id FROM keys WHERE name=?1", [&k.name], |r| r.get(0)) {
            Ok(id) => id,
            Err(_) => {
                let pass_enc = k.passphrase.as_deref().filter(|p| !p.is_empty()).map(|p| crypto.enc(p));
                conn.execute(
                    "INSERT INTO keys(name, private_enc, passphrase_enc) VALUES(?1,?2,?3)",
                    rusqlite::params![k.name, crypto.enc(k.private_key.as_deref().unwrap_or("")), pass_enc],
                ).map_err(|e| e.to_string())?;
                res.keys += 1;
                conn.last_insert_rowid()
            }
        };
        key_ids.insert(k.name.clone(), id);
    }
    for h in &b.hosts {
        let dup: Option<i64> = conn
            .query_row(
                "SELECT id FROM hosts WHERE hostname=?1 AND port=?2 AND username=?3",
                rusqlite::params![h.hostname, h.port, h.username],
                |r| r.get(0),
            )
            .ok();
        if dup.is_some() { res.skipped += 1; continue; }
        let folder_id = h.folder.as_deref().and_then(|p| folder_id_for_path(&conn, p));
        let pw_enc = h.password.as_deref().filter(|p| !p.is_empty()).map(|p| crypto.enc(p));
        conn.execute(
            "INSERT INTO hosts(folder_id, label, hostname, port, username, auth_type, password_enc, key_id, identity_id) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            rusqlite::params![
                folder_id,
                h.label.clone().unwrap_or_else(|| h.hostname.clone()),
                h.hostname, h.port, h.username, h.auth_type, pw_enc,
                h.key.as_ref().and_then(|n| key_ids.get(n)).copied(),
                h.identity.as_ref().and_then(|n| ident_ids.get(n)).copied(),
            ],
        ).map_err(|e| e.to_string())?;
        res.hosts += 1;
    }
    Ok(res)
}

/// Factory reset. Windows won't delete a file the process still has open (the
/// SQLite handle), so we drop a marker and let the NEXT process wipe the data dir
/// before it opens the DB — see `apply_pending_reset`.
#[tauri::command]
pub fn factory_reset(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("RESET"), b"1").map_err(|e| format!("cannot arm reset: {e}"))?;
    app.restart();
}

/// Called at startup before the DB is opened: if a RESET marker exists, wipe
/// every data file (db, wal/shm, encryption key) and the marker itself.
pub fn apply_pending_reset(dir: &std::path::Path) {
    let marker = dir.join("RESET");
    if !marker.exists() {
        return;
    }
    for name in ["sshdeck.db", "sshdeck.db-wal", "sshdeck.db-shm", "secret.key", "RESET"] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}
