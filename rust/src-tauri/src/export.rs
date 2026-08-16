//! Export/import parity with the web app's Settings page:
//! full backup JSON (v2), MobaXterm bookmarks export, MobaXterm import.

use crate::crypto::Crypto;
use crate::db::Db;
use crate::portability::folder_id_for_path;
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// id -> "Parent/Child" for every folder
fn folder_paths(conn: &rusqlite::Connection) -> HashMap<i64, String> {
    let mut rows: HashMap<i64, (String, Option<i64>)> = HashMap::new();
    if let Ok(mut st) = conn.prepare("SELECT id, name, parent_id FROM folders") {
        if let Ok(iter) = st.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?))
        }) {
            for (id, name, parent) in iter.flatten() {
                rows.insert(id, (name, parent));
            }
        }
    }
    let mut out = HashMap::new();
    for id in rows.keys() {
        let mut parts = Vec::new();
        let mut cur = Some(*id);
        let mut guard = 0;
        while let Some(c) = cur {
            if guard > 64 {
                break;
            }
            guard += 1;
            match rows.get(&c) {
                Some((name, parent)) => {
                    parts.push(name.clone());
                    cur = *parent;
                }
                None => break,
            }
        }
        parts.reverse();
        out.insert(*id, parts.join("/"));
    }
    out
}

/// Full backup JSON — same schema/version as the web app (secrets decrypted).
#[tauri::command]
pub fn export_backup(db: State<Db>, crypto: State<Crypto>, path: String) -> Result<usize, String> {
    let conn = db.0.lock().unwrap();
    let paths = folder_paths(&conn);

    let mut idents: HashMap<i64, (String, String, String)> = HashMap::new();
    {
        let mut st = conn
            .prepare("SELECT id, name, username, password_enc FROM identities")
            .map_err(es)?;
        let iter = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(es)?;
        for (id, name, user, pw) in iter.flatten() {
            idents.insert(id, (name, user, crypto.dec(&pw).unwrap_or_default()));
        }
    }

    let mut keys: HashMap<i64, (String, String, Option<String>)> = HashMap::new();
    {
        let mut st = conn
            .prepare("SELECT id, name, private_enc, passphrase_enc FROM keys")
            .map_err(es)?;
        let iter = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(es)?;
        for (id, name, pk, pp) in iter.flatten() {
            keys.insert(
                id,
                (
                    name,
                    crypto.dec(&pk).unwrap_or_default(),
                    pp.as_deref().and_then(|e| crypto.dec(e)),
                ),
            );
        }
    }

    let mut hosts = Vec::new();
    {
        let mut st = conn
            .prepare(
                "SELECT folder_id, label, hostname, port, username, auth_type, password_enc, \
                 key_id, identity_id FROM hosts ORDER BY label",
            )
            .map_err(es)?;
        let iter = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, Option<i64>>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, u16>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                ))
            })
            .map_err(es)?;
        for (folder_id, label, hostname, port, username, auth_type, pw, key_id, ident_id) in
            iter.flatten()
        {
            hosts.push(serde_json::json!({
                "label": label,
                "hostname": hostname,
                "port": port,
                "username": username,
                "auth_type": auth_type,
                "password": pw.as_deref().and_then(|e| crypto.dec(e)),
                "folder": folder_id.and_then(|f| paths.get(&f).cloned()),
                "key": key_id.and_then(|k| keys.get(&k).map(|v| v.0.clone())),
                "identity": ident_id.and_then(|i| idents.get(&i).map(|v| v.0.clone())),
            }));
        }
    }

    let mut folder_list: Vec<String> = paths.values().cloned().collect();
    folder_list.sort();
    let count = hosts.len();
    let data = serde_json::json!({
        "app": "sshdeck",
        "version": 2,
        "folders": folder_list,
        "identities": idents.values()
            .map(|(n, u, p)| serde_json::json!({"name": n, "username": u, "password": p}))
            .collect::<Vec<_>>(),
        "keys": keys.values()
            .map(|(n, k, p)| serde_json::json!({"name": n, "private_key": k, "passphrase": p}))
            .collect::<Vec<_>>(),
        "hosts": hosts,
    });
    std::fs::write(&path, serde_json::to_string_pretty(&data).map_err(es)?)
        .map_err(|e| format!("cannot write file: {e}"))?;
    Ok(count)
}

/// Terminal settings tail copied from a real MobaXterm 25.x export.
const MOBA_TAIL: &str = "%%-1%-1%%%%%0%0%0%%%-1%-1%0%0%%1080%%0%0%1%%0%%%%0%-1%-1%0%%#Cascadia Code SemiBold%10%0%0%-1%15%230,225,220%43,43,43%255,255,255%5%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%0%#0# #-1";

/// MobaXterm-compatible bookmarks file (no passwords — Moba can't read ours).
#[tauri::command]
pub fn export_mobaconf(db: State<Db>, path: String) -> Result<usize, String> {
    let conn = db.0.lock().unwrap();
    let paths = folder_paths(&conn);
    let mut groups: Vec<(String, Option<i64>)> = vec![(String::new(), None)];
    let mut ids: Vec<(i64, String)> = paths.iter().map(|(k, v)| (*k, v.clone())).collect();
    ids.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));
    for (id, p) in ids {
        groups.push((p.replace('/', "\\"), Some(id))); // Moba nests with backslash
    }

    let mut out = String::new();
    let mut n = 0usize;
    for (idx, (name, fid)) in groups.iter().enumerate() {
        if idx == 0 {
            out.push_str("[Bookmarks]\r\n");
        } else {
            out.push_str(&format!("[Bookmarks_{idx}]\r\n"));
        }
        out.push_str(&format!("SubRep={name}\r\nImgNum=41\r\n"));
        let rows: Vec<(String, String, u16, String)> = match fid {
            Some(f) => {
                let mut st = conn
                    .prepare("SELECT label, hostname, port, username FROM hosts WHERE folder_id=?1 ORDER BY label")
                    .map_err(es)?;
                let iter = st
                    .query_map([f], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                    .map_err(es)?;
                iter.flatten().collect()
            }
            None => {
                let mut st = conn
                    .prepare("SELECT label, hostname, port, username FROM hosts WHERE folder_id IS NULL ORDER BY label")
                    .map_err(es)?;
                let iter = st
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                    .map_err(es)?;
                iter.flatten().collect()
            }
        };
        for (label, hostname, port, username) in rows {
            out.push_str(&format!(
                "{label}=#109#0%{hostname}%{port}%{username}{MOBA_TAIL}\r\n"
            ));
            n += 1;
        }
        out.push_str("\r\n");
    }
    std::fs::write(&path, out).map_err(|e| format!("cannot write file: {e}"))?;
    Ok(n)
}

#[derive(Serialize)]
pub struct MobaImport {
    imported: usize,
    skipped: usize,
}

/// Import MobaXterm bookmarks (`#109#` SSH entries; nested SubRep paths).
#[tauri::command]
pub fn import_mobaconf(db: State<Db>, path: String) -> Result<MobaImport, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("cannot read file: {e}"))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let conn = db.0.lock().unwrap();
    let mut res = MobaImport { imported: 0, skipped: 0 };
    let mut in_bookmarks = false;
    let mut folder = String::new();

    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            in_bookmarks = line.starts_with("[Bookmarks");
            folder.clear();
            continue;
        }
        if !in_bookmarks {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        if key == "SubRep" {
            folder = value.trim().to_string();
            continue;
        }
        if key == "ImgNum" || !value.starts_with("#109#") {
            continue; // not an SSH bookmark (RDP etc.)
        }
        let parts: Vec<&str> = value.split('%').collect();
        if parts.len() < 4 {
            continue;
        }
        let hostname = parts[1].trim();
        if hostname.is_empty() {
            continue;
        }
        let port: u16 = parts[2].trim().parse().unwrap_or(22);
        let username = parts[3].trim().trim_matches(|c| c == '[' || c == ']');
        let dup: Option<i64> = conn
            .query_row(
                "SELECT id FROM hosts WHERE hostname=?1 AND port=?2 AND username=?3",
                rusqlite::params![hostname, port, username],
                |r| r.get(0),
            )
            .ok();
        if dup.is_some() {
            res.skipped += 1;
            continue;
        }
        let folder_id = if folder.is_empty() {
            None
        } else {
            folder_id_for_path(&conn, &folder)
        };
        conn.execute(
            "INSERT INTO hosts(folder_id, label, hostname, port, username, auth_type) \
             VALUES(?1,?2,?3,?4,?5,'password')",
            rusqlite::params![folder_id, key.trim(), hostname, port, username],
        )
        .map_err(es)?;
        res.imported += 1;
    }
    Ok(res)
}
