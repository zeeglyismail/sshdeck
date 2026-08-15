// SSHDeck desktop — M2: SSH terminals (russh) + host store + monitoring stats,
// alongside the M1 local ConPTY terminals. See rust/CLAUDE.md.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod crypto;
mod db;
mod ssh;

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

use crypto::Crypto;
use db::Db;
use ssh::{ConnectSpec, SshSessions, TermMsg};

// ---------- local PTY (M1) ----------

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
}

#[derive(Default)]
struct Ptys(Arc<Mutex<HashMap<u32, Session>>>);

#[tauri::command]
fn pty_spawn(app: AppHandle, state: State<Ptys>, id: u32, shell: Option<String>) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let program = shell.unwrap_or_else(|| {
        if cfg!(windows) { "powershell.exe".into() } else { "bash".into() }
    });
    let cmd = CommandBuilder::new(program);
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    state.0.lock().unwrap().insert(id, Session { writer, master: pair.master });
    let app_out = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => { let _ = app_out.emit(&format!("pty-out-{id}"), buf[..n].to_vec()); }
            }
        }
        let _ = child.wait();
        let _ = app_out.emit(&format!("pty-exit-{id}"), ());
    });
    Ok(())
}

#[tauri::command]
fn pty_write(state: State<Ptys>, id: u32, data: String) {
    if let Some(s) = state.0.lock().unwrap().get_mut(&id) {
        let _ = s.writer.write_all(data.as_bytes());
    }
}

#[tauri::command]
fn pty_resize(state: State<Ptys>, id: u32, cols: u16, rows: u16) {
    if let Some(s) = state.0.lock().unwrap().get_mut(&id) {
        let _ = s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

#[tauri::command]
fn pty_kill(state: State<Ptys>, id: u32) {
    state.0.lock().unwrap().remove(&id);
}

// ---------- inventory (M2) ----------

#[tauri::command]
fn state_get(db: State<Db>) -> db::AppState {
    db::read_state(&db)
}

#[tauri::command]
fn folder_save(db: State<Db>, name: String) -> Result<i64, String> {
    let conn = db.0.lock().unwrap();
    conn.execute("INSERT OR IGNORE INTO folders(name) VALUES(?1)", [&name])
        .map_err(|e| e.to_string())?;
    let id = conn
        .query_row("SELECT id FROM folders WHERE name=?1", [&name], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(id)
}

#[tauri::command]
fn folder_delete(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute("UPDATE hosts SET folder_id=NULL WHERE folder_id=?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM folders WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn host_save(
    db: State<Db>,
    crypto: State<Crypto>,
    id: Option<i64>,
    folder_id: Option<i64>,
    label: String,
    hostname: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    key_id: Option<i64>,
    identity_id: Option<i64>,
) -> Result<i64, String> {
    let conn = db.0.lock().unwrap();
    let pw_enc: Option<String> = match &password {
        Some(p) if !p.is_empty() => Some(crypto.enc(p)),
        _ => match id {
            Some(hid) => conn
                .query_row("SELECT password_enc FROM hosts WHERE id=?1", [hid], |r| r.get(0))
                .unwrap_or(None),
            None => None,
        },
    };
    match id {
        Some(hid) => {
            conn.execute(
                "UPDATE hosts SET folder_id=?1, label=?2, hostname=?3, port=?4, username=?5, \
                 auth_type=?6, password_enc=?7, key_id=?8, identity_id=?9 WHERE id=?10",
                rusqlite::params![folder_id, label, hostname, port, username, auth_type, pw_enc, key_id, identity_id, hid],
            )
            .map_err(|e| e.to_string())?;
            Ok(hid)
        }
        None => {
            conn.execute(
                "INSERT INTO hosts(folder_id, label, hostname, port, username, auth_type, password_enc, key_id, identity_id) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![folder_id, label, hostname, port, username, auth_type, pw_enc, key_id, identity_id],
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

#[tauri::command]
fn host_delete(db: State<Db>, id: i64) -> Result<(), String> {
    db.0.lock().unwrap()
        .execute("DELETE FROM hosts WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn identity_save(
    db: State<Db>,
    crypto: State<Crypto>,
    id: Option<i64>,
    name: String,
    username: String,
    password: Option<String>,
) -> Result<i64, String> {
    let conn = db.0.lock().unwrap();
    match id {
        Some(iid) => {
            if let Some(p) = password.filter(|p| !p.is_empty()) {
                conn.execute(
                    "UPDATE identities SET name=?1, username=?2, password_enc=?3 WHERE id=?4",
                    rusqlite::params![name, username, crypto.enc(&p), iid],
                )
                .map_err(|e| e.to_string())?;
            } else {
                conn.execute(
                    "UPDATE identities SET name=?1, username=?2 WHERE id=?3",
                    rusqlite::params![name, username, iid],
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(iid)
        }
        None => {
            let p = password.ok_or("password required")?;
            conn.execute(
                "INSERT INTO identities(name, username, password_enc) VALUES(?1,?2,?3)",
                rusqlite::params![name, username, crypto.enc(&p)],
            )
            .map_err(|e| e.to_string())?;
            Ok(conn.last_insert_rowid())
        }
    }
}

#[tauri::command]
fn identity_delete(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    let used: i64 = conn
        .query_row("SELECT COUNT(*) FROM hosts WHERE identity_id=?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if used > 0 {
        return Err("Identity is used by a saved host".into());
    }
    conn.execute("DELETE FROM identities WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn key_save(
    db: State<Db>,
    crypto: State<Crypto>,
    name: String,
    private_key: String,
    passphrase: Option<String>,
) -> Result<i64, String> {
    let conn = db.0.lock().unwrap();
    let pass_enc = passphrase.filter(|p| !p.is_empty()).map(|p| crypto.enc(&p));
    conn.execute(
        "INSERT INTO keys(name, private_enc, passphrase_enc) VALUES(?1,?2,?3)",
        rusqlite::params![name, crypto.enc(&private_key), pass_enc],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
fn key_delete(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    let used: i64 = conn
        .query_row("SELECT COUNT(*) FROM hosts WHERE key_id=?1", [id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if used > 0 {
        return Err("Key is used by a saved host".into());
    }
    conn.execute("DELETE FROM keys WHERE id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- SSH sessions (M2) ----------

#[tauri::command]
fn ssh_spawn(
    app: AppHandle,
    db: State<Db>,
    crypto: State<Crypto>,
    sessions: State<SshSessions>,
    id: u32,
    host_id: i64,
) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    let (hostname, port, mut username, auth_type, password_enc, key_id, identity_id): (
        String, u16, String, String, Option<String>, Option<i64>, Option<i64>,
    ) = conn
        .query_row(
            "SELECT hostname, port, username, auth_type, password_enc, key_id, identity_id FROM hosts WHERE id=?1",
            [host_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .map_err(|_| "Host not found".to_string())?;

    let mut password = password_enc.as_deref().and_then(|e| crypto.dec(e));
    let mut key_pem = None;
    let mut key_pass = None;

    if auth_type == "identity" {
        let iid = identity_id.ok_or("No identity set for this host")?;
        let (iu, ipw): (String, String) = conn
            .query_row("SELECT username, password_enc FROM identities WHERE id=?1", [iid], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(|_| "Identity not found".to_string())?;
        username = iu;
        password = crypto.dec(&ipw);
    } else if auth_type == "key" {
        let kid = key_id.ok_or("No key set for this host")?;
        let (pk, pp): (String, Option<String>) = conn
            .query_row("SELECT private_enc, passphrase_enc FROM keys WHERE id=?1", [kid], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(|_| "Key not found".to_string())?;
        key_pem = crypto.dec(&pk);
        key_pass = pp.as_deref().and_then(|e| crypto.dec(e));
    }
    drop(conn);

    ssh::spawn_session(
        app,
        &sessions,
        id,
        ConnectSpec { hostname, port, username, password, key_pem, key_pass },
    );
    Ok(())
}

#[tauri::command]
fn ssh_write(sessions: State<SshSessions>, id: u32, data: String) {
    if let Some(tx) = sessions.0.lock().unwrap().get(&id) {
        let _ = tx.send(TermMsg::Data(data.into_bytes()));
    }
}

#[tauri::command]
fn ssh_resize(sessions: State<SshSessions>, id: u32, cols: u32, rows: u32) {
    if let Some(tx) = sessions.0.lock().unwrap().get(&id) {
        let _ = tx.send(TermMsg::Resize(cols, rows));
    }
}

#[tauri::command]
fn ssh_kill(sessions: State<SshSessions>, id: u32) {
    if let Some(tx) = sessions.0.lock().unwrap().remove(&id) {
        let _ = tx.send(TermMsg::Close);
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Ptys::default())
        .manage(SshSessions::default())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("app data dir");
            app.manage(db::open(data_dir.clone()));
            app.manage(Crypto::load(data_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty_spawn, pty_write, pty_resize, pty_kill,
            state_get, folder_save, folder_delete, host_save, host_delete,
            identity_save, identity_delete, key_save, key_delete,
            ssh_spawn, ssh_write, ssh_resize, ssh_kill
        ])
        .run(tauri::generate_context!())
        .expect("error while running SSHDeck");
}
