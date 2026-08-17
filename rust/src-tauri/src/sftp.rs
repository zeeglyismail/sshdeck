use crate::ssh::{pooled, Client, SshPool};
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileAttributes;
use serde::Serialize;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub async fn open_sftp(handle: &Handle<Client>) -> Result<SftpSession, String> {
    let ch = handle.channel_open_session().await.map_err(es)?;
    ch.request_subsystem(true, "sftp").await.map_err(es)?;
    SftpSession::new(ch.into_stream()).await.map_err(es)
}

fn mode_str(mode: u32, is_dir: bool) -> String {
    let chars = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'];
    let mut out = String::from(if is_dir { "d" } else { "-" });
    for (i, c) in chars.iter().enumerate() {
        out.push(if mode & (1 << (8 - i)) != 0 { *c } else { '-' });
    }
    out
}

fn attr_is_dir(attrs: &FileAttributes) -> bool {
    attrs.permissions.map_or(false, |p| p & 0o170000 == 0o040000)
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    is_dir: bool,
    size: u64,
    mtime: u64,
    perm: String,
}

#[derive(Serialize)]
pub struct ListResult {
    path: String,
    entries: Vec<Entry>,
}

#[tauri::command]
pub async fn sftp_list(
    app: AppHandle,
    pool: State<'_, SshPool>,
    host_id: i64,
    path: String,
) -> Result<ListResult, String> {
    let spec = crate::build_spec(&app, host_id)?;
    let handle = pooled(&pool, host_id, spec).await?;
    let sftp = open_sftp(&handle).await?;
    let real = sftp.canonicalize(&path).await.map_err(es)?;
    let dir = sftp.read_dir(&real).await.map_err(es)?;
    let mut entries = Vec::new();
    for e in dir {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let attrs = e.metadata();
        let mut is_dir = attr_is_dir(&attrs);
        // resolve symlinks so linked dirs open as dirs
        if !is_dir && attrs.permissions.map_or(false, |p| p & 0o170000 == 0o120000) {
            if let Ok(m) = sftp.metadata(format!("{real}/{name}")).await {
                is_dir = attr_is_dir(&m);
            }
        }
        entries.push(Entry {
            name,
            is_dir,
            size: attrs.size.unwrap_or(0),
            mtime: attrs.mtime.unwrap_or(0) as u64,
            perm: mode_str(attrs.permissions.unwrap_or(0) & 0o777, is_dir),
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(ListResult { path: real, entries })
}

#[tauri::command]
pub async fn sftp_mkdir(app: AppHandle, pool: State<'_, SshPool>, host_id: i64, path: String) -> Result<(), String> {
    let spec = crate::build_spec(&app, host_id)?;
    let h = pooled(&pool, host_id, spec).await?;
    let sftp = open_sftp(&h).await?;
    sftp.create_dir(&path).await.map_err(es)
}

#[tauri::command]
pub async fn sftp_rename(app: AppHandle, pool: State<'_, SshPool>, host_id: i64, path: String, new_path: String) -> Result<(), String> {
    let spec = crate::build_spec(&app, host_id)?;
    let h = pooled(&pool, host_id, spec).await?;
    let sftp = open_sftp(&h).await?;
    sftp.rename(&path, &new_path).await.map_err(es)
}

#[tauri::command]
pub async fn sftp_chmod(app: AppHandle, pool: State<'_, SshPool>, host_id: i64, path: String, mode: String) -> Result<(), String> {
    let spec = crate::build_spec(&app, host_id)?;
    let h = pooled(&pool, host_id, spec).await?;
    let sftp = open_sftp(&h).await?;
    let bits = u32::from_str_radix(&mode, 8).map_err(|_| "bad octal mode".to_string())?;
    let attrs = FileAttributes { permissions: Some(bits), ..Default::default() };
    sftp.set_metadata(&path, attrs).await.map_err(es)
}

async fn rm_recursive(sftp: &SftpSession, path: String, is_dir: bool) -> Result<(), String> {
    if !is_dir {
        return sftp.remove_file(&path).await.map_err(es);
    }
    // iterative: collect deepest-first, then delete
    let mut stack = vec![path.clone()];
    let mut dirs = Vec::new();
    while let Some(p) = stack.pop() {
        dirs.push(p.clone());
        let entries = sftp.read_dir(&p).await.map_err(es)?;
        for e in entries {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let full = format!("{p}/{name}");
            if attr_is_dir(&e.metadata()) {
                stack.push(full);
            } else {
                sftp.remove_file(&full).await.map_err(es)?;
            }
        }
    }
    for d in dirs.iter().rev() {
        sftp.remove_dir(d).await.map_err(es)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_delete(app: AppHandle, pool: State<'_, SshPool>, host_id: i64, path: String, is_dir: bool) -> Result<(), String> {
    let spec = crate::build_spec(&app, host_id)?;
    let h = pooled(&pool, host_id, spec).await?;
    let sftp = open_sftp(&h).await?;
    rm_recursive(&sftp, path, is_dir).await
}

/* ---------- transfers with progress events ---------- */

#[derive(Serialize, Clone)]
pub struct Prog {
    pub id: u32,
    pub desc: String,
    pub done: u64,
    pub total: Option<u64>,
    pub status: String,
    pub error: Option<String>,
}

pub struct Transfers(pub Mutex<Vec<Prog>>, pub AtomicU32);

impl Default for Transfers {
    fn default() -> Self {
        Transfers(Mutex::new(Vec::new()), AtomicU32::new(0))
    }
}

fn push_prog(app: &AppHandle, list: &Transfers, p: Prog) {
    let mut v = list.0.lock().unwrap();
    if let Some(slot) = v.iter_mut().find(|x| x.id == p.id) {
        *slot = p;
    } else {
        v.push(p);
    }
    let _ = app.emit("transfers", v.clone());
}

async fn copy_file(
    src: &SftpSession,
    dst: &SftpSession,
    from: &str,
    to: &str,
    app: &AppHandle,
    list: &Transfers,
    prog: &mut Prog,
) -> Result<(), String> {
    let mut rf = src.open(from).await.map_err(es)?;
    let mut wf = dst.create(to).await.map_err(es)?;
    let mut buf = vec![0u8; 512 * 1024];
    loop {
        let n = rf.read(&mut buf).await.map_err(es)?;
        if n == 0 {
            break;
        }
        wf.write_all(&buf[..n]).await.map_err(es)?;
        prog.done += n as u64;
        push_prog(app, list, prog.clone());
    }
    wf.shutdown().await.ok();
    Ok(())
}

async fn copy_dir(
    src: &SftpSession,
    dst: &SftpSession,
    from: String,
    to: String,
    app: &AppHandle,
    list: &Transfers,
    prog: &mut Prog,
) -> Result<(), String> {
    dst.create_dir(&to).await.ok();
    let mut stack = vec![(from, to)];
    while let Some((f, t)) = stack.pop() {
        let entries = src.read_dir(&f).await.map_err(es)?;
        for e in entries {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let sf = format!("{f}/{name}");
            let st = format!("{t}/{name}");
            if attr_is_dir(&e.metadata()) {
                dst.create_dir(&st).await.ok();
                stack.push((sf, st));
            } else {
                copy_file(src, dst, &sf, &st, app, list, prog).await?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn transfer_start(
    app: AppHandle,
    pool: State<'_, SshPool>,
    transfers: State<'_, Transfers>,
    src_host_id: i64,
    src_path: String,
    dst_host_id: i64,
    dst_dir: String,
    is_dir: bool,
    src_label: String,
    dst_label: String,
) -> Result<(), String> {
    let id = transfers.1.fetch_add(1, Ordering::SeqCst) + 1;
    let src_spec = crate::build_spec(&app, src_host_id)?;
    let dst_spec = crate::build_spec(&app, dst_host_id)?;
    let src_h = pooled(&pool, src_host_id, src_spec).await?;
    let dst_h = pooled(&pool, dst_host_id, dst_spec).await?;

    let name = src_path.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
    let dest = format!("{}/{}", dst_dir.trim_end_matches('/'), name);
    let desc = format!("{src_label}:{src_path} â†’ {dst_label}:{dst_dir}");

    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let list = app2.state::<Transfers>();
        let mut prog = Prog { id, desc, done: 0, total: None, status: "running".into(), error: None };
        push_prog(&app2, &list, prog.clone());
        let result: Result<(), String> = async {
            let src = open_sftp(&src_h).await?;
            let dst = open_sftp(&dst_h).await?;
            if is_dir {
                copy_dir(&src, &dst, src_path.clone(), dest.clone(), &app2, &list, &mut prog).await
            } else {
                if let Ok(m) = src.metadata(&src_path).await {
                    prog.total = m.size;
                }
                copy_file(&src, &dst, &src_path, &dest, &app2, &list, &mut prog).await
            }
        }
        .await;
        match result {
            Ok(()) => prog.status = "done".into(),
            Err(e) => {
                prog.status = "error".into();
                prog.error = Some(e);
            }
        }
        push_prog(&app2, &list, prog);
    });
    Ok(())
}

#[tauri::command]
pub fn transfers_clear(app: AppHandle, transfers: State<'_, Transfers>) {
    let mut v = transfers.0.lock().unwrap();
    v.retain(|t| t.status == "running");
    let _ = app.emit("transfers", v.clone());
}

/* ---------- local upload / download ---------- */

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    pool: State<'_, SshPool>,
    transfers: State<'_, Transfers>,
    host_id: i64,
    remote_path: String,
    local_path: String,
    host_label: String,
) -> Result<(), String> {
    let id = transfers.1.fetch_add(1, Ordering::SeqCst) + 1;
    let spec = crate::build_spec(&app, host_id)?;
    let handle = pooled(&pool, host_id, spec).await?;
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let list = app2.state::<Transfers>();
        let mut prog = Prog {
            id,
            desc: format!("{host_label}:{remote_path} â†’ {local_path}"),
            done: 0, total: None, status: "running".into(), error: None,
        };
        push_prog(&app2, &list, prog.clone());
        let result: Result<(), String> = async {
            let sftp = open_sftp(&handle).await?;
            if let Ok(m) = sftp.metadata(&remote_path).await {
                prog.total = m.size;
            }
            let mut rf = sftp.open(&remote_path).await.map_err(es)?;
            let mut wf = tokio::fs::File::create(&local_path).await.map_err(es)?;
            let mut buf = vec![0u8; 512 * 1024];
            loop {
                let n = rf.read(&mut buf).await.map_err(es)?;
                if n == 0 {
                    break;
                }
                wf.write_all(&buf[..n]).await.map_err(es)?;
                prog.done += n as u64;
                push_prog(&app2, &list, prog.clone());
            }
            wf.flush().await.ok();
            Ok(())
        }
        .await;
        match result {
            Ok(()) => prog.status = "done".into(),
            Err(e) => { prog.status = "error".into(); prog.error = Some(e); }
        }
        push_prog(&app2, &list, prog);
    });
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    pool: State<'_, SshPool>,
    transfers: State<'_, Transfers>,
    host_id: i64,
    local_path: String,
    remote_dir: String,
    host_label: String,
) -> Result<(), String> {
    let id = transfers.1.fetch_add(1, Ordering::SeqCst) + 1;
    let spec = crate::build_spec(&app, host_id)?;
    let handle = pooled(&pool, host_id, spec).await?;
    let name = std::path::Path::new(&local_path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or("bad local path")?;
    let dest = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let list = app2.state::<Transfers>();
        let mut prog = Prog {
            id,
            desc: format!("{local_path} â†’ {host_label}:{remote_dir}"),
            done: 0, total: None, status: "running".into(), error: None,
        };
        push_prog(&app2, &list, prog.clone());
        let result: Result<(), String> = async {
            let meta = tokio::fs::metadata(&local_path).await.map_err(es)?;
            prog.total = Some(meta.len());
            let sftp = open_sftp(&handle).await?;
            let mut rf = tokio::fs::File::open(&local_path).await.map_err(es)?;
            let mut wf = sftp.create(&dest).await.map_err(es)?;
            let mut buf = vec![0u8; 512 * 1024];
            loop {
                let n = rf.read(&mut buf).await.map_err(es)?;
                if n == 0 {
                    break;
                }
                wf.write_all(&buf[..n]).await.map_err(es)?;
                prog.done += n as u64;
                push_prog(&app2, &list, prog.clone());
            }
            wf.shutdown().await.ok();
            Ok(())
        }
        .await;
        match result {
            Ok(()) => prog.status = "done".into(),
            Err(e) => { prog.status = "error".into(); prog.error = Some(e); }
        }
        // if this came from an OS drag & drop, delete the temp spool now that the
        // transfer is finished — the frontend can't, this task is detached
        crate::stash::cleanup_if_spool(&local_path);
        push_prog(&app2, &list, prog);
    });
    Ok(())
}
