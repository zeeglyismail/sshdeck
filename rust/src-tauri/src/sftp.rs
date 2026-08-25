use crate::fast;
use crate::ssh::{pooled, Client, SshPool};
use russh::client::Handle;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::FileAttributes;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;
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
    /// bytes/second over the last tick, for the UI's rate and ETA
    pub speed: u64,
    /// "sftp" | "fast" | "fast+zstd" — shown as a badge so it is obvious
    /// which path a transfer actually took
    pub method: String,
    /// a failed or paused transfer that can pick up where it left off
    pub resumable: bool,
    /// wall clock spent so far, so the UI can show an average rate once done
    pub elapsed_ms: u64,
}

/// Everything needed to restart a transfer at an offset.
#[derive(Clone)]
pub enum Resume {
    Download { host_id: i64, remote: String, local: String, label: String },
    Upload { host_id: i64, local: String, remote: String, label: String, dir: String },
    Between {
        src_host_id: i64,
        src_path: String,
        dst_host_id: i64,
        dst_dir: String,
        dest: String,
        src_label: String,
        dst_label: String,
    },
}

#[derive(Default)]
pub struct Transfers {
    pub list: Mutex<Vec<Prog>>,
    pub seq: AtomicU32,
    pub resume: Mutex<HashMap<u32, Resume>>,
    /// per transfer pause flags, checked inside the copy loops
    pub cancel: Mutex<HashMap<u32, fast::Cancel>>,
    /// destinations currently being written, so two transfers cannot fight
    /// over the same path
    pub dests: Mutex<HashSet<String>>,
}

fn push_prog(app: &AppHandle, list: &Transfers, p: Prog) {
    let mut v = list.list.lock().unwrap();
    if let Some(slot) = v.iter_mut().find(|x| x.id == p.id) {
        *slot = p;
    } else {
        v.push(p);
    }
    let _ = app.emit("transfers", v.clone());
}

fn new_prog(id: u32, desc: String) -> Prog {
    Prog {
        id,
        desc,
        done: 0,
        total: None,
        status: "running".into(),
        error: None,
        speed: 0,
        method: "sftp".into(),
        resumable: false,
        elapsed_ms: 0,
    }
}

/// Claim a destination path. Returns false if another live transfer already
/// owns it. Dropping the same file twice used to leave both writes racing on
/// one path, which killed the channel mid stream.
fn claim_dest(t: &Transfers, key: &str) -> bool {
    t.dests.lock().unwrap().insert(key.to_string())
}

fn release_dest(app: &AppHandle, key: &str) {
    app.state::<Transfers>().dests.lock().unwrap().remove(key);
}

/* ---------- progress ticker ----------
 *
 * Transfers used to emit a `transfers` event per 512 KB chunk. On a 300 GB
 * file that is 600k events into the webview, which drowns the UI long before
 * the copy finishes. Instead every path just bumps an atomic counter, and one
 * timer turns that into a few events a second, plus a live rate for the ETA.
 */

const TICK_MS: u64 = 400;

fn start_ticker(app: &AppHandle, id: u32, done: Arc<AtomicU64>, t0: Instant) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last = done.load(Ordering::Relaxed);
        let mut ema = 0f64;
        while !flag.load(Ordering::Relaxed) {
            tokio::time::sleep(std::time::Duration::from_millis(TICK_MS)).await;
            if flag.load(Ordering::Relaxed) {
                break;
            }
            let cur = done.load(Ordering::Relaxed);
            let inst = (cur.saturating_sub(last)) as f64 * 1000.0 / TICK_MS as f64;
            last = cur;
            // smoothed, so a tick that lands during a stall does not blank the
            // rate and ETA out of the row
            ema = if ema == 0.0 { inst } else { ema * 0.6 + inst * 0.4 };
            let list = app.state::<Transfers>();
            let mut v = list.list.lock().unwrap();
            if let Some(p) = v.iter_mut().find(|x| x.id == id) {
                p.done = cur;
                p.speed = ema as u64;
                p.elapsed_ms = t0.elapsed().as_millis() as u64;
            }
            let _ = app.emit("transfers", v.clone());
        }
    });
    stop
}

/// Publish the final state of a transfer and stop its ticker.
#[allow(clippy::too_many_arguments)]
fn finish(
    app: &AppHandle,
    stop: &Arc<AtomicBool>,
    mut prog: Prog,
    done: &Arc<AtomicU64>,
    t0: Instant,
    result: Result<(), String>,
    dest_key: &str,
) {
    stop.store(true, Ordering::Relaxed);
    prog.done = done.load(Ordering::Relaxed);
    prog.speed = 0;
    prog.elapsed_ms = t0.elapsed().as_millis() as u64;
    match result {
        Ok(()) => {
            prog.status = "done".into();
            prog.resumable = false;
        }
        Err(ref e) if e == fast::PAUSED => {
            prog.status = "paused".into();
            prog.resumable = true;
        }
        Err(e) => {
            prog.status = "error".into();
            // only worth offering a resume if we actually moved something
            prog.resumable = prog.done > 0;
            prog.error = Some(e);
        }
    }
    let list = app.state::<Transfers>();
    list.cancel.lock().unwrap().remove(&prog.id);
    push_prog(app, &list, prog);
    release_dest(app, dest_key);
}

/// Register a fresh pause flag for this transfer and hand it to the copy loops.
fn arm_cancel(app: &AppHandle, id: u32) -> fast::Cancel {
    let c: fast::Cancel = Arc::new(AtomicBool::new(false));
    app.state::<Transfers>().cancel.lock().unwrap().insert(id, c.clone());
    c
}

/* ---------- fast-path decision ---------- */

/// Anything at or above this uses the streaming path. Below it the exec-channel
/// setup (a round trip plus a process spawn) is a measurable share of the
/// transfer and SFTP is already fine.
const FAST_MIN: u64 = 64 * 1024 * 1024;

struct Plan {
    fast: bool,
    compress: bool,
    method: String,
}

impl Plan {
    fn sftp() -> Self {
        Plan { fast: false, compress: false, method: "sftp".into() }
    }
    fn stream(compress: bool) -> Self {
        Plan {
            fast: true,
            compress,
            method: if compress { "fast+zstd".into() } else { "fast".into() },
        }
    }
}

async fn plan_for(
    caps: &fast::Caps,
    size: u64,
    enabled: bool,
    min_bytes: u64,
    ratio: impl std::future::Future<Output = f64>,
) -> Plan {
    if !enabled || size < min_bytes || !caps.can_stream() {
        return Plan::sftp();
    }
    if !caps.zstd {
        return Plan::stream(false);
    }
    Plan::stream(fast::worth_compressing(ratio.await))
}

/* ---------- SFTP path (fallback / small files) ---------- */

async fn copy_file(
    src: &SftpSession,
    dst: &SftpSession,
    from: &str,
    to: &str,
    done: &Arc<AtomicU64>,
    cancel: &fast::Cancel,
) -> Result<(), String> {
    let mut rf = src.open(from).await.map_err(es)?;
    let mut wf = dst.create(to).await.map_err(es)?;
    let mut buf = vec![0u8; 512 * 1024];
    loop {
        if fast::stopped(cancel) {
            wf.shutdown().await.ok();
            return Err(fast::PAUSED.into());
        }
        let n = rf.read(&mut buf).await.map_err(es)?;
        if n == 0 {
            break;
        }
        wf.write_all(&buf[..n]).await.map_err(es)?;
        done.fetch_add(n as u64, Ordering::Relaxed);
    }
    wf.shutdown().await.ok();
    Ok(())
}

async fn copy_dir(
    src: &SftpSession,
    dst: &SftpSession,
    from: String,
    to: String,
    done: &Arc<AtomicU64>,
    cancel: &fast::Cancel,
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
                copy_file(src, dst, &sf, &st, done, cancel).await?;
            }
        }
    }
    Ok(())
}

/* ---------- host to host ---------- */

#[tauri::command]
pub async fn transfer_start(
    app: AppHandle,
    transfers: State<'_, Transfers>,
    src_host_id: i64,
    src_path: String,
    dst_host_id: i64,
    dst_dir: String,
    is_dir: bool,
    src_label: String,
    dst_label: String,
    fast_enabled: Option<bool>,
    fast_min_mb: Option<u64>,
) -> Result<(), String> {
    let id = transfers.seq.fetch_add(1, Ordering::SeqCst) + 1;
    let name = src_path.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string();
    let dest = format!("{}/{}", dst_dir.trim_end_matches('/'), name);
    transfers.resume.lock().unwrap().insert(
        id,
        Resume::Between {
            src_host_id,
            src_path: src_path.clone(),
            dst_host_id,
            dst_dir: dst_dir.clone(),
            dest: dest.clone(),
            src_label: src_label.clone(),
            dst_label: dst_label.clone(),
        },
    );
    let desc = format!("{src_label}:{src_path} \u{2192} {dst_label}:{dst_dir}");
    run_between(
        app, id, src_host_id, src_path, dst_host_id, dest, is_dir, desc, 0,
        opts(fast_enabled, fast_min_mb),
    )
    .await
}

fn opts(enabled: Option<bool>, min_mb: Option<u64>) -> (bool, u64) {
    (
        enabled.unwrap_or(true),
        min_mb.map(|m| m * 1024 * 1024).unwrap_or(FAST_MIN),
    )
}

#[allow(clippy::too_many_arguments)]
async fn run_between(
    app: AppHandle,
    id: u32,
    src_host_id: i64,
    src_path: String,
    dst_host_id: i64,
    dest: String,
    is_dir: bool,
    desc: String,
    offset: u64,
    (fast_on, min_bytes): (bool, u64),
) -> Result<(), String> {
    let pool = app.state::<SshPool>();
    let src_h = pooled(&pool, src_host_id, crate::build_spec(&app, src_host_id)?).await?;
    let dst_h = pooled(&pool, dst_host_id, crate::build_spec(&app, dst_host_id)?).await?;

    let dest_key = format!("{dst_host_id}:{dest}");
    if !claim_dest(&app.state::<Transfers>(), &dest_key) {
        return Err(format!("{dest} is already being written by another transfer"));
    }
    tauri::async_runtime::spawn(async move {
        let mut prog = new_prog(id, desc);
        prog.done = offset;
        let done = Arc::new(AtomicU64::new(offset));
        let cancel = arm_cancel(&app, id);
        let t0 = Instant::now();
        let cache = app.state::<fast::CapsCache>();

        let size = if is_dir { 0 } else { fast::remote_size(&src_h, &src_path).await.unwrap_or(0) };
        let plan = if is_dir {
            // directory trees stay on SFTP for now: the win there is bundling
            // many small files with tar, which is a separate change
            Plan::sftp()
        } else {
            let sc = fast::caps(&cache, src_host_id, &src_h).await;
            let dc = fast::caps(&cache, dst_host_id, &dst_h).await;
            let both = fast::Caps {
                zstd: sc.zstd && dc.zstd,
                gnu_dd: dc.gnu_dd,
                tail: sc.tail,
            };
            plan_for(&both, size, fast_on, min_bytes, fast::remote_ratio(&src_h, &src_path, size)).await
        };
        prog.total = if is_dir { None } else { Some(size) };
        prog.method = plan.method.clone();
        {
            let list = app.state::<Transfers>();
            push_prog(&app, &list, prog.clone());
        }
        let stop = start_ticker(&app, id, done.clone(), t0);

        let mut result = if plan.fast {
            fast::host_to_host(&src_h, &dst_h, &src_path, &dest, offset, plan.compress, done.clone(), cancel.clone()).await
        } else {
            Err("__sftp__".into())
        };
        if plan.fast && !is_paused(&result) {
            result = verify_remote(&dst_h, &dest, size, result).await;
        }

        // any fast-path failure falls back to SFTP rather than surfacing an error
        if plan.fast && result.is_err() && !is_paused(&result) {
            fast::disable(&cache, dst_host_id).await;
            done.store(0, Ordering::Relaxed);
            prog.method = "sftp".into();
            result = Err("__sftp__".into());
        }
        if is_sftp_retry(&result) {
            let list = app.state::<Transfers>();
            prog.method = "sftp".into();
            push_prog(&app, &list, prog.clone());
            result = async {
                let src = open_sftp(&src_h).await?;
                let dst = open_sftp(&dst_h).await?;
                if is_dir {
                    copy_dir(&src, &dst, src_path.clone(), dest.clone(), &done, &cancel).await
                } else {
                    copy_file(&src, &dst, &src_path, &dest, &done, &cancel).await
                }
            }
            .await;
        }
        finish(&app, &stop, prog, &done, t0, result, &dest_key);
    });
    Ok(())
}

fn is_paused(r: &Result<(), String>) -> bool {
    matches!(r, Err(e) if e == fast::PAUSED)
}

fn is_sftp_retry(r: &Result<(), String>) -> bool {
    matches!(r, Err(e) if e == "__sftp__")
}

/// A streamed transfer has no per-chunk acknowledgement, so confirm the
/// destination really ended up the size we expected before calling it done.
async fn verify_remote(
    h: &Handle<Client>,
    path: &str,
    expect: u64,
    result: Result<(), String>,
) -> Result<(), String> {
    result?;
    if expect == 0 {
        return Ok(());
    }
    match fast::remote_size(h, path).await {
        Some(n) if n == expect => Ok(()),
        Some(n) => Err(format!("size mismatch: got {n} of {expect} bytes")),
        None => Err("destination file missing after transfer".into()),
    }
}

#[tauri::command]
pub fn transfers_clear(app: AppHandle, transfers: State<'_, Transfers>) {
    // "clear finished" means exactly that: anything not still running goes,
    // failed and paused rows included. Keeping them back was just confusing.
    let keep: Vec<u32> = {
        let mut v = transfers.list.lock().unwrap();
        v.retain(|t| t.status == "running");
        v.iter().map(|t| t.id).collect()
    };
    transfers.resume.lock().unwrap().retain(|k, _| keep.contains(k));
    let v = transfers.list.lock().unwrap().clone();
    let _ = app.emit("transfers", v);
}

/// Stop a running transfer but keep it resumable. This is the pause button.
#[tauri::command]
pub fn transfer_pause(transfers: State<'_, Transfers>, id: u32) {
    if let Some(c) = transfers.cancel.lock().unwrap().get(&id) {
        c.store(true, Ordering::Relaxed);
    }
}

/// Drop a single transfer row without disturbing the others.
#[tauri::command]
pub fn transfer_forget(app: AppHandle, transfers: State<'_, Transfers>, id: u32) {
    transfers.list.lock().unwrap().retain(|t| t.id != id);
    transfers.resume.lock().unwrap().remove(&id);
    let v = transfers.list.lock().unwrap().clone();
    let _ = app.emit("transfers", v);
}

/// Restart a failed transfer from wherever the destination got to. For a
/// 300 GB image that died at 280 GB this is the difference between five
/// minutes and five hours.
#[tauri::command]
pub async fn transfer_resume(
    app: AppHandle,
    transfers: State<'_, Transfers>,
    id: u32,
    fast_enabled: Option<bool>,
    fast_min_mb: Option<u64>,
) -> Result<(), String> {
    let spec = transfers
        .resume
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("this transfer can no longer be resumed")?;
    let o = opts(fast_enabled, fast_min_mb);
    let pool = app.state::<SshPool>();
    match spec {
        Resume::Download { host_id, remote, local, label } => {
            let offset = tokio::fs::metadata(&local).await.map(|m| m.len()).unwrap_or(0);
            let desc = format!("{label}:{remote} \u{2192} {local}");
            run_download(app.clone(), id, host_id, remote, local, desc, offset, o).await
        }
        Resume::Upload { host_id, local, remote, label, dir } => {
            let h = pooled(&pool, host_id, crate::build_spec(&app, host_id)?).await?;
            let offset = fast::remote_size(&h, &remote).await.unwrap_or(0);
            let name = remote.rsplit('/').next().unwrap_or("").to_string();
            let desc = format!("{name} \u{2192} {label}:{dir}");
            run_upload(app.clone(), id, host_id, local, remote, dir, label, desc, offset, o).await
        }
        Resume::Between { src_host_id, src_path, dst_host_id, dst_dir, dest, src_label, dst_label } => {
            let h = pooled(&pool, dst_host_id, crate::build_spec(&app, dst_host_id)?).await?;
            let offset = fast::remote_size(&h, &dest).await.unwrap_or(0);
            let desc = format!("{src_label}:{src_path} \u{2192} {dst_label}:{dst_dir}");
            run_between(app.clone(), id, src_host_id, src_path, dst_host_id, dest, false, desc, offset, o).await
        }
    }
}

/* ---------- local download ---------- */

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    transfers: State<'_, Transfers>,
    host_id: i64,
    remote_path: String,
    local_path: String,
    host_label: String,
    fast_enabled: Option<bool>,
    fast_min_mb: Option<u64>,
) -> Result<(), String> {
    let id = transfers.seq.fetch_add(1, Ordering::SeqCst) + 1;
    transfers.resume.lock().unwrap().insert(
        id,
        Resume::Download {
            host_id,
            remote: remote_path.clone(),
            local: local_path.clone(),
            label: host_label.clone(),
        },
    );
    let desc = format!("{host_label}:{remote_path} \u{2192} {local_path}");
    run_download(app, id, host_id, remote_path, local_path, desc, 0, opts(fast_enabled, fast_min_mb)).await
}

#[allow(clippy::too_many_arguments)]
async fn run_download(
    app: AppHandle,
    id: u32,
    host_id: i64,
    remote_path: String,
    local_path: String,
    desc: String,
    offset: u64,
    (fast_on, min_bytes): (bool, u64),
) -> Result<(), String> {
    let pool = app.state::<SshPool>();
    let handle = pooled(&pool, host_id, crate::build_spec(&app, host_id)?).await?;
    let dest_key = format!("local:{local_path}");
    if !claim_dest(&app.state::<Transfers>(), &dest_key) {
        return Err(format!("{local_path} is already being written by another transfer"));
    }
    tauri::async_runtime::spawn(async move {
        let mut prog = new_prog(id, desc);
        prog.done = offset;
        let done = Arc::new(AtomicU64::new(offset));
        let cancel = arm_cancel(&app, id);
        let t0 = Instant::now();
        let cache = app.state::<fast::CapsCache>();

        let size = fast::remote_size(&handle, &remote_path).await.unwrap_or(0);
        let caps = fast::caps(&cache, host_id, &handle).await;
        let plan = plan_for(
            &caps, size, fast_on, min_bytes,
            fast::remote_ratio(&handle, &remote_path, size),
        )
        .await;
        prog.total = Some(size);
        prog.method = plan.method.clone();
        {
            let list = app.state::<Transfers>();
            push_prog(&app, &list, prog.clone());
        }
        let stop = start_ticker(&app, id, done.clone(), t0);

        let mut result = if plan.fast {
            let r = fast::download(&handle, &remote_path, &local_path, offset, plan.compress, done.clone(), cancel.clone()).await;
            if is_paused(&r) { r } else { verify_local(&local_path, size, r).await }
        } else {
            Err("__sftp__".into())
        };
        if plan.fast && result.is_err() && !is_paused(&result) {
            fast::disable(&cache, host_id).await;
            done.store(0, Ordering::Relaxed);
            result = Err("__sftp__".into());
        }
        if is_sftp_retry(&result) {
            prog.method = "sftp".into();
            let list = app.state::<Transfers>();
            push_prog(&app, &list, prog.clone());
            result = async {
                let sftp = open_sftp(&handle).await?;
                let mut rf = sftp.open(&remote_path).await.map_err(es)?;
                let mut wf = tokio::fs::File::create(&local_path).await.map_err(es)?;
                let mut buf = vec![0u8; 512 * 1024];
                loop {
                    if fast::stopped(&cancel) {
                        return Err(fast::PAUSED.into());
                    }
                    let n = rf.read(&mut buf).await.map_err(es)?;
                    if n == 0 {
                        break;
                    }
                    wf.write_all(&buf[..n]).await.map_err(es)?;
                    done.fetch_add(n as u64, Ordering::Relaxed);
                }
                wf.flush().await.ok();
                Ok(())
            }
            .await;
        }
        finish(&app, &stop, prog, &done, t0, result, &dest_key);
    });
    Ok(())
}

async fn verify_local(path: &str, expect: u64, result: Result<(), String>) -> Result<(), String> {
    result?;
    if expect == 0 {
        return Ok(());
    }
    match tokio::fs::metadata(path).await {
        Ok(m) if m.len() == expect => Ok(()),
        Ok(m) => Err(format!("size mismatch: got {} of {} bytes", m.len(), expect)),
        Err(e) => Err(es(e)),
    }
}

/* ---------- local upload ---------- */

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    transfers: State<'_, Transfers>,
    host_id: i64,
    local_path: String,
    remote_dir: String,
    host_label: String,
    fast_enabled: Option<bool>,
    fast_min_mb: Option<u64>,
) -> Result<(), String> {
    let id = transfers.seq.fetch_add(1, Ordering::SeqCst) + 1;
    let name = std::path::Path::new(&local_path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .ok_or("bad local path")?;
    let dest = format!("{}/{}", remote_dir.trim_end_matches('/'), name);
    transfers.resume.lock().unwrap().insert(
        id,
        Resume::Upload {
            host_id,
            local: local_path.clone(),
            remote: dest.clone(),
            label: host_label.clone(),
            dir: remote_dir.clone(),
        },
    );
    // show the file name, not the drag-and-drop spool path
    let desc = format!("{name} \u{2192} {host_label}:{remote_dir}");
    run_upload(
        app, id, host_id, local_path, dest, remote_dir, host_label, desc, 0,
        opts(fast_enabled, fast_min_mb),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_upload(
    app: AppHandle,
    id: u32,
    host_id: i64,
    local_path: String,
    dest: String,
    _remote_dir: String,
    _host_label: String,
    desc: String,
    offset: u64,
    (fast_on, min_bytes): (bool, u64),
) -> Result<(), String> {
    let pool = app.state::<SshPool>();
    let handle = pooled(&pool, host_id, crate::build_spec(&app, host_id)?).await?;
    let dest_key = format!("{host_id}:{dest}");
    if !claim_dest(&app.state::<Transfers>(), &dest_key) {
        return Err(format!("{dest} is already being written by another transfer"));
    }
    tauri::async_runtime::spawn(async move {
        let mut prog = new_prog(id, desc);
        prog.done = offset;
        let done = Arc::new(AtomicU64::new(offset));
        let cancel = arm_cancel(&app, id);
        let t0 = Instant::now();
        let cache = app.state::<fast::CapsCache>();

        let size = tokio::fs::metadata(&local_path).await.map(|m| m.len()).unwrap_or(0);
        let caps = fast::caps(&cache, host_id, &handle).await;
        let plan = plan_for(&caps, size, fast_on, min_bytes, fast::local_ratio(&local_path, size)).await;
        prog.total = Some(size);
        prog.method = plan.method.clone();
        {
            let list = app.state::<Transfers>();
            push_prog(&app, &list, prog.clone());
        }
        let stop = start_ticker(&app, id, done.clone(), t0);

        let mut result = if plan.fast {
            let r = fast::upload(&handle, &local_path, &dest, offset, plan.compress, done.clone(), cancel.clone()).await;
            if is_paused(&r) { r } else { verify_remote(&handle, &dest, size, r).await }
        } else {
            Err("__sftp__".into())
        };
        if plan.fast && result.is_err() && !is_paused(&result) {
            fast::disable(&cache, host_id).await;
            done.store(0, Ordering::Relaxed);
            result = Err("__sftp__".into());
        }
        if is_sftp_retry(&result) {
            prog.method = "sftp".into();
            let list = app.state::<Transfers>();
            push_prog(&app, &list, prog.clone());
            result = async {
                let sftp = open_sftp(&handle).await?;
                let mut rf = tokio::fs::File::open(&local_path).await.map_err(es)?;
                let mut wf = sftp.create(&dest).await.map_err(es)?;
                let mut buf = vec![0u8; 512 * 1024];
                loop {
                    if fast::stopped(&cancel) {
                        return Err(fast::PAUSED.into());
                    }
                    let n = rf.read(&mut buf).await.map_err(es)?;
                    if n == 0 {
                        break;
                    }
                    wf.write_all(&buf[..n]).await.map_err(es)?;
                    done.fetch_add(n as u64, Ordering::Relaxed);
                }
                wf.shutdown().await.ok();
                Ok(())
            }
            .await;
        }
        let ok = result.is_ok();
        finish(&app, &stop, prog, &done, t0, result, &dest_key);
        // if this came from an OS drag and drop, drop the temp spool now that
        // the transfer is over — the frontend cannot, this task is detached.
        // On failure the spool is kept so the transfer stays resumable.
        if ok {
            crate::stash::cleanup_if_spool(&local_path);
        }
    });
    Ok(())
}


/* ---------- search (server-side `find`) ---------- */

#[derive(Serialize)]
pub struct FindHit {
    name: String,
    path: String,
    dir: String,
    is_dir: bool,
    size: u64,
    mtime: u64,
}

#[derive(Serialize)]
pub struct FindResult {
    hits: Vec<FindHit>,
    truncated: bool,
    note: Option<String>,
}

/// Single-quote a value for the remote shell.
fn shq(v: &str) -> String {
    format!("'{}'", v.replace('\'', "'\''"))
}

/// Explorer-style search: recursive, case-insensitive substring match, run by
/// `find` ON THE SERVER (walking the tree over SFTP would be far slower).
#[tauri::command]
pub async fn sftp_find(
    app: AppHandle,
    pool: State<'_, SshPool>,
    host_id: i64,
    path: String,
    query: String,
    limit: usize,
) -> Result<FindResult, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("nothing to search for".into());
    }
    // a bare word matches anywhere in the name; wildcards are honoured as typed
    let pattern = if q.contains('*') || q.contains('?') {
        q.to_string()
    } else {
        format!("*{q}*")
    };
    let cap = limit.clamp(1, 5000);
    // prune pseudo/virtual trees so a search from / doesn't crawl them, drop
    // permission errors, and never run longer than 60s
    // Each prune is its own branch so the command needs no shell grouping
    // (backslash-escaped parens): skips pseudo trees, .git and node_modules,
    // hides permission errors, and can never run longer than 60s.
    // Each prune is its own branch so no shell grouping (escaped parens) is needed:
    // skips pseudo trees, .git and node_modules, hides permission errors, hard 60s cap.
    let cmd = format!(
        "timeout 60 find {} -path /proc -prune -o -path /sys -prune -o -path /dev -prune -o -path /run -prune -o -name .git -prune -o -name node_modules -prune -o -iname {} -printf '%y\t%s\t%T@\t%p\n' 2>/dev/null | head -n {}",
        shq(&path),
        shq(&pattern),
        cap + 1
    );

    let spec = crate::build_spec(&app, host_id)?;
    let handle = pooled(&pool, host_id, spec).await?;
    let out = crate::ssh::run_command(&handle, &cmd)
        .await
        .ok_or("search failed (connection lost)")?;

    let mut hits = Vec::new();
    for line in out.lines() {
        let mut f = line.splitn(4, '\t');
        let (Some(ty), Some(size), Some(mtime), Some(full)) =
            (f.next(), f.next(), f.next(), f.next())
        else {
            continue;
        };
        let full = full.trim_end();
        if full.is_empty() {
            continue;
        }
        let (dir, name) = match full.rsplit_once('/') {
            Some((d, n)) => (if d.is_empty() { "/" } else { d }, n),
            None => ("/", full),
        };
        hits.push(FindHit {
            name: name.to_string(),
            path: full.to_string(),
            dir: dir.to_string(),
            is_dir: ty == "d",
            size: size.parse().unwrap_or(0),
            mtime: mtime.split('.').next().and_then(|s| s.parse().ok()).unwrap_or(0),
        });
    }

    let truncated = hits.len() > cap;
    hits.truncate(cap);
    // directories first, then by name — same ordering as the browser view
    hits.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let note = if truncated {
        Some(format!("showing the first {cap} matches — narrow the search"))
    } else {
        None
    };
    Ok(FindResult { hits, truncated, note })
}
