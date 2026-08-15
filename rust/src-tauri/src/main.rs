// SSHDeck desktop — Milestone 1: Tauri shell + local terminals (ConPTY).
// SSH (russh), SFTP, tunnels and the rest arrive in later milestones — see rust/CLAUDE.md.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

struct Session {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
}

#[derive(Default, Clone)]
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
                Ok(n) => {
                    let _ = app_out.emit(&format!("pty-out-{id}"), buf[..n].to_vec());
                }
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

fn main() {
    tauri::Builder::default()
        .manage(Ptys::default())
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, pty_kill])
        .run(tauri::generate_context!())
        .expect("error while running SSHDeck");
}
