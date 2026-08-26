//! One place every part of the app reports problems to.
//!
//! Errors used to land wherever they happened — an alert, a transfer row, or
//! nowhere at all — so a failure you did not catch live was gone. Everything now
//! writes here: connects, transfers, SFTP operations, tunnels, and the frontend
//! itself. The buffer is in memory only; nothing is written to disk unless the
//! owner explicitly saves it, because these messages contain host names and
//! paths.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

/// Enough to cover a long session without growing without bound. At roughly
/// 150 bytes an entry this is well under a megabyte.
const CAP: usize = 3000;

pub const ERROR: &str = "error";
pub const WARN: &str = "warn";
pub const INFO: &str = "info";

#[derive(Serialize, Clone)]
pub struct Entry {
    pub id: u64,
    /// milliseconds since the epoch, formatted by the UI in local time
    pub ts: u64,
    pub level: String,
    /// which part of the app this came from: ssh, transfer, sftp, tunnel, ui …
    pub src: String,
    pub msg: String,
}

#[derive(Default)]
pub struct Logs {
    pub buf: Mutex<VecDeque<Entry>>,
    pub seq: AtomicU64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn push(app: &AppHandle, level: &str, src: &str, msg: impl Into<String>) {
    let logs = app.state::<Logs>();
    let entry = Entry {
        id: logs.seq.fetch_add(1, Ordering::SeqCst) + 1,
        ts: now_ms(),
        level: level.to_string(),
        src: src.to_string(),
        msg: msg.into(),
    };
    {
        let mut b = logs.buf.lock().unwrap();
        while b.len() >= CAP {
            b.pop_front();
        }
        b.push_back(entry.clone());
    }
    let _ = app.emit("log", entry);
}

pub fn error(app: &AppHandle, src: &str, msg: impl Into<String>) {
    push(app, ERROR, src, msg);
}

pub fn warn(app: &AppHandle, src: &str, msg: impl Into<String>) {
    push(app, WARN, src, msg);
}

pub fn info(app: &AppHandle, src: &str, msg: impl Into<String>) {
    push(app, INFO, src, msg);
}

/// All four commands are `async` deliberately. A synchronous Tauri command runs
/// on the main thread, which is also the window message loop — and one that
/// emits an event from there can wedge the entire window, which presents as the
/// app freezing with no click response at all.
#[tauri::command]
pub async fn logs_list(logs: State<'_, Logs>) -> Result<Vec<Entry>, ()> {
    Ok(logs.buf.lock().unwrap().iter().cloned().collect())
}

#[tauri::command]
pub async fn logs_clear(app: AppHandle, logs: State<'_, Logs>) -> Result<(), ()> {
    logs.buf.lock().unwrap().clear();
    let _ = app.emit("logs-reset", ());
    Ok(())
}

/// The frontend reports its own failures through here, so a JS error and a
/// backend error end up in the same list in the right order.
#[tauri::command]
pub async fn log_add(app: AppHandle, level: String, src: String, msg: String) -> Result<(), ()> {
    push(&app, &level, &src, msg);
    Ok(())
}

#[tauri::command]
pub async fn logs_save(logs: State<'_, Logs>, path: String) -> Result<usize, String> {
    let lines: Vec<String> = logs
        .buf
        .lock()
        .unwrap()
        .iter()
        .map(|e| format!("{} [{}] {}: {}", stamp(e.ts), e.level, e.src, e.msg))
        .collect();
    let n = lines.len();
    std::fs::write(&path, lines.join("\n") + "\n").map_err(|e| e.to_string())?;
    Ok(n)
}

/// `YYYY-MM-DD HH:MM:SS` in UTC, computed directly so the build stays
/// dependency-free — a date crate is not worth it for one format string.
fn stamp(ms: u64) -> String {
    let secs = ms / 1000;
    let (mut days, rem) = ((secs / 86400) as i64, secs % 86400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let mut year = 1970;
    loop {
        let len = if leap(year) { 366 } else { 365 };
        if days < len {
            break;
        }
        days -= len;
        year += 1;
    }
    let ml = [31, if leap(year) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 0;
    while days >= ml[month] {
        days -= ml[month];
        month += 1;
    }
    format!(
        "{year:04}-{:02}-{:02} {h:02}:{mi:02}:{s:02}",
        month + 1,
        days + 1
    )
}

fn leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
