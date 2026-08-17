//! Receiving OS-dropped files from the webview.
//!
//! The window runs with `dragDropEnabled: false` so in-app HTML5 dragging works
//! (files between panes, hosts onto folders, tab reorder). The cost is that files
//! dropped from Explorer arrive as browser `File` objects with **no path** — so the
//! frontend streams their bytes here in chunks, we spool them to a temp file, and
//! the normal `sftp_upload` path takes it from there (progress events included).

use base64::Engine;
use std::io::Write;
use std::path::PathBuf;

fn temp_root() -> PathBuf {
    std::env::temp_dir().join("sshdeck-drop")
}

/// Reject anything that isn't inside our temp spool dir.
fn guard(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let root = temp_root();
    if !p.starts_with(&root) {
        return Err("path outside the spool directory".into());
    }
    Ok(p)
}

/// Create (or truncate) a spool file for `name`; returns its path.
#[tauri::command]
pub fn stash_begin(name: String) -> Result<String, String> {
    let root = temp_root();
    std::fs::create_dir_all(&root).map_err(|e| format!("cannot create spool dir: {e}"))?;
    // keep only the file name — never let the webview pick a directory
    let base = std::path::Path::new(&name)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "dropped.bin".into());
    let unique = format!(
        "{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        base
    );
    let path = root.join(unique);
    std::fs::File::create(&path).map_err(|e| format!("cannot create spool file: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Append one base64 chunk to the spool file.
#[tauri::command]
pub fn stash_append(path: String, chunk: String) -> Result<(), String> {
    let p = guard(&path)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(chunk.as_bytes())
        .map_err(|e| format!("bad chunk: {e}"))?;
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&p)
        .map_err(|e| format!("cannot open spool file: {e}"))?;
    f.write_all(&bytes).map_err(|e| format!("cannot write spool file: {e}"))?;
    Ok(())
}

/// Delete a spool file once it has been uploaded.
#[tauri::command]
pub fn stash_cleanup(path: String) {
    if let Ok(p) = guard(&path) {
        let _ = std::fs::remove_file(p);
    }
}

/// Delete `path` **only** if it is one of our spool files. Called by the upload
/// task once it is finished — the frontend must not delete it itself, because
/// `sftp_upload` returns as soon as the background transfer is spawned.
pub fn cleanup_if_spool(path: &str) {
    if let Ok(p) = guard(path) {
        let _ = std::fs::remove_file(p);
    }
}

/// Remove leftovers from previous runs (called at startup).
pub fn sweep() {
    let _ = std::fs::remove_dir_all(temp_root());
}
