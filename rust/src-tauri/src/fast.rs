//! Accelerated transfers for large files.
//!
//! The SFTP path in `sftp.rs` is correct but strictly serial: one 512 KB chunk
//! per round trip, which caps throughput at `512KB / RTT` no matter how fast
//! the link is. That is fine for config files and fatal for a 300 GB disk image.
//!
//! This module streams instead. The remote runs `tail -c +N | zstd -1 -c` (or
//! the reverse for uploads) on a plain exec channel, so bytes flow continuously
//! with no per-chunk acknowledgement. Compression is decided by sampling the
//! source, because a SQL dump shrinks several times over on the wire while an
//! already-packed archive would only waste CPU on both ends.
//!
//! Everything here is best effort: a host that lacks the tools, or a transfer
//! that comes up short, falls back to the SFTP path in `sftp.rs`.

use crate::ssh::{run_command, Client};
use russh::client::Handle;
use std::collections::HashMap;
use std::io::{Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Single-quote a path for `sh -c`.
fn shq(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/* ---------- host capability probe ---------- */

#[derive(Clone, Copy, Debug, Default)]
pub struct Caps {
    pub zstd: bool,
    /// GNU dd — needed for `oflag=seek_bytes` and `conv=sparse`.
    pub gnu_dd: bool,
    pub tail: bool,
}

impl Caps {
    /// Without `tail` we cannot start a download at an offset, and without GNU
    /// dd we cannot resume an upload — so neither direction can stream.
    pub fn can_stream(&self) -> bool {
        self.tail && self.gnu_dd
    }
}

#[derive(Default)]
pub struct CapsCache(pub tokio::sync::Mutex<HashMap<i64, Caps>>);

const PROBE: &str = "command -v zstd >/dev/null 2>&1 && echo Z; \
     dd --version 2>/dev/null | head -1 | grep -qi coreutils && echo D; \
     tail --version >/dev/null 2>&1 && echo T";

pub async fn caps(cache: &CapsCache, host_id: i64, h: &Handle<Client>) -> Caps {
    if let Some(c) = cache.0.lock().await.get(&host_id) {
        return *c;
    }
    let out = run_command(h, PROBE).await.unwrap_or_default();
    let c = Caps {
        zstd: out.contains('Z'),
        gnu_dd: out.contains('D'),
        tail: out.contains('T'),
    };
    cache.0.lock().await.insert(host_id, c);
    c
}

/// Mark a host as unable to stream, so we stop retrying the fast path on it
/// for the rest of the session.
pub async fn disable(cache: &CapsCache, host_id: i64) {
    cache.0.lock().await.insert(host_id, Caps::default());
}

/* ---------- compression decision ---------- */

/// How far the sample has to shrink before compressing earns its CPU.
const WORTH_IT: f64 = 0.85;
const SAMPLE_MB: u64 = 4;

/// Sample 4 MB from ~10% into a remote file and see how well it compresses.
/// Sampling beats guessing from the extension: a `.vhdx` may be mostly zero
/// runs or may be packed solid, and only the bytes know which.
pub async fn remote_ratio(h: &Handle<Client>, path: &str, size: u64) -> f64 {
    let skip_mb = (size / 10) / (1024 * 1024);
    let cmd = format!(
        "dd if={} bs=1048576 skip={} count={} 2>/dev/null | zstd -1 -c | wc -c",
        shq(path),
        skip_mb,
        SAMPLE_MB
    );
    let Some(out) = run_command(h, &cmd).await else {
        return 1.0;
    };
    let Ok(n) = out.trim().parse::<u64>() else {
        return 1.0;
    };
    let sampled = (SAMPLE_MB * 1024 * 1024).min(size.saturating_sub(skip_mb * 1024 * 1024));
    if sampled == 0 || n == 0 {
        return 1.0;
    }
    n as f64 / sampled as f64
}

/// Same idea for a local file, compressed in process.
pub async fn local_ratio(path: &str, size: u64) -> f64 {
    let p = path.to_string();
    tokio::task::spawn_blocking(move || {
        let Ok(mut f) = std::fs::File::open(&p) else {
            return 1.0;
        };
        let skip = (size / 10) / (1024 * 1024) * 1024 * 1024;
        if f.seek(SeekFrom::Start(skip)).is_err() {
            return 1.0;
        }
        let mut buf = vec![0u8; (SAMPLE_MB * 1024 * 1024) as usize];
        let n = match std::io::Read::read(&mut f, &mut buf) {
            Ok(n) if n > 0 => n,
            _ => return 1.0,
        };
        match zstd::bulk::compress(&buf[..n], 1) {
            Ok(c) => c.len() as f64 / n as f64,
            Err(_) => 1.0,
        }
    })
    .await
    .unwrap_or(1.0)
}

pub fn worth_compressing(ratio: f64) -> bool {
    ratio < WORTH_IT
}

/* ---------- remote command builders ---------- */

/// Read `path` from byte `offset` onward, optionally compressed.
fn read_cmd(path: &str, offset: u64, compress: bool) -> String {
    // `tail -c +N` is 1-based and seeks rather than scanning, so resuming a
    // 300 GB file at 280 GB costs nothing.
    let base = format!("tail -c +{} -- {}", offset + 1, shq(path));
    if compress {
        format!("{} | zstd -1 -c", base)
    } else {
        base
    }
}

/// Write stdin into `path` starting at `offset`.
///
/// `conv=sparse` keeps zero runs as holes, which matters for dynamically
/// expanding disk images: a 300 GB VHDX that is mostly empty stays small on the
/// destination filesystem instead of being written out in full.
fn write_cmd(path: &str, offset: u64, compress: bool) -> String {
    let q = shq(path);
    let dd = format!(
        "dd of={} bs=1M seek={} oflag=seek_bytes conv=notrunc,sparse status=none",
        q, offset
    );
    let body = if compress {
        format!("zstd -d -c | {}", dd)
    } else {
        dd
    };
    if offset == 0 {
        // fresh transfer: clear any previous partial file first
        format!(": > {}; {}", q, body)
    } else {
        body
    }
}

/* ---------- plumbing ---------- */

/// A `Write` that forwards each buffer into an async channel, letting the
/// synchronous zstd codec run on a blocking thread while the SSH side stays
/// async. The bounded channel provides backpressure in both directions.
struct ChanWriter(mpsc::Sender<Vec<u8>>);

impl Write for ChanWriter {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0
            .blocking_send(b.to_vec())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "receiver gone"))?;
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Counts bytes on their way through, so progress reflects *uncompressed*
/// bytes even when the wire is carrying compressed ones.
struct CountWriter<W: Write> {
    inner: W,
    n: Arc<AtomicU64>,
}

impl<W: Write> Write for CountWriter<W> {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(b)?;
        self.n.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

const PIPE_CHUNKS: usize = 8;
const READ_BUF: usize = 1024 * 1024;

type Stream = russh::ChannelStream<russh::client::Msg>;

async fn open_exec(h: &Handle<Client>, cmd: &str) -> Result<Stream, String> {
    let ch = h.channel_open_session().await.map_err(es)?;
    // No PTY: a PTY would apply CRLF translation and silently corrupt binaries.
    ch.exec(true, format!("sh -c {}", shq(cmd)).into_bytes())
        .await
        .map_err(es)?;
    Ok(ch.into_stream())
}

/// Split a stream for writing, draining the read half in the background.
///
/// A write-only exec channel deadlocks: SSH flow control delivers the window
/// adjustments that let us keep writing on the same channel we are ignoring, so
/// once the initial window is spent nothing ever refills it. Draining stdout
/// concurrently keeps the window moving, and the drain finishing is also our
/// signal that the remote command has exited.
fn split_drain(stream: Stream) -> (tokio::io::WriteHalf<Stream>, tokio::task::JoinHandle<()>) {
    let (mut rd, wr) = tokio::io::split(stream);
    let drain = tokio::spawn(async move {
        let mut b = vec![0u8; 8192];
        while let Ok(n) = rd.read(&mut b).await {
            if n == 0 {
                break;
            }
        }
    });
    (wr, drain)
}

/// Size of a remote file, or None if it is missing or unreadable.
pub async fn remote_size(h: &Handle<Client>, path: &str) -> Option<u64> {
    let out = run_command(h, &format!("stat -c %s -- {} 2>/dev/null", shq(path))).await?;
    out.trim().parse::<u64>().ok()
}

/* ---------- download: remote -> local ---------- */

pub async fn download(
    h: &Handle<Client>,
    remote: &str,
    local: &str,
    offset: u64,
    compress: bool,
    done: Arc<AtomicU64>,
) -> Result<(), String> {
    let mut stream = open_exec(h, &read_cmd(remote, offset, compress)).await?;
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(PIPE_CHUNKS);

    let lp = local.to_string();
    let counter = done.clone();
    let writer = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(&lp)
            .map_err(es)?;
        if offset == 0 {
            f.set_len(0).map_err(es)?;
        }
        f.seek(SeekFrom::Start(offset)).map_err(es)?;
        let sink = CountWriter { inner: f, n: counter };
        if compress {
            let mut dec = zstd::stream::write::Decoder::new(sink).map_err(es)?;
            while let Some(chunk) = rx.blocking_recv() {
                dec.write_all(&chunk).map_err(es)?;
            }
            dec.flush().map_err(es)?;
        } else {
            let mut sink = sink;
            while let Some(chunk) = rx.blocking_recv() {
                sink.write_all(&chunk).map_err(es)?;
            }
            sink.flush().map_err(es)?;
        }
        Ok(())
    });

    let mut buf = vec![0u8; READ_BUF];
    loop {
        let n = stream.read(&mut buf).await.map_err(es)?;
        if n == 0 {
            break;
        }
        if tx.send(buf[..n].to_vec()).await.is_err() {
            break; // writer died; its error is the useful one
        }
    }
    drop(tx);
    writer.await.map_err(es)??;
    Ok(())
}

/* ---------- upload: local -> remote ---------- */

pub async fn upload(
    h: &Handle<Client>,
    local: &str,
    remote: &str,
    offset: u64,
    compress: bool,
    done: Arc<AtomicU64>,
) -> Result<(), String> {
    let stream = open_exec(h, &write_cmd(remote, offset, compress)).await?;
    let (mut stream, drain) = split_drain(stream);
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(PIPE_CHUNKS);

    let lp = local.to_string();
    let counter = done.clone();
    let reader = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut f = std::fs::File::open(&lp).map_err(es)?;
        f.seek(SeekFrom::Start(offset)).map_err(es)?;
        let mut buf = vec![0u8; READ_BUF];
        if compress {
            let mut enc = zstd::stream::write::Encoder::new(ChanWriter(tx), 1).map_err(es)?;
            loop {
                let n = std::io::Read::read(&mut f, &mut buf).map_err(es)?;
                if n == 0 {
                    break;
                }
                enc.write_all(&buf[..n]).map_err(es)?;
                counter.fetch_add(n as u64, Ordering::Relaxed);
            }
            enc.finish().map_err(es)?;
        } else {
            let mut w = ChanWriter(tx);
            loop {
                let n = std::io::Read::read(&mut f, &mut buf).map_err(es)?;
                if n == 0 {
                    break;
                }
                w.write_all(&buf[..n]).map_err(es)?;
                counter.fetch_add(n as u64, Ordering::Relaxed);
            }
        }
        Ok(())
    });

    while let Some(chunk) = rx.recv().await {
        stream.write_all(&chunk).await.map_err(es)?;
    }
    reader.await.map_err(es)??;
    stream.flush().await.ok();
    // EOF tells the remote `dd` the file is complete
    stream.shutdown().await.map_err(es)?;
    // wait for the remote command to exit before we trust the result
    let _ = drain.await;
    Ok(())
}

/* ---------- host to host ---------- */

/// Pipe source straight into destination. With compression on, the bytes stay
/// compressed for the whole journey, so this machine spends no CPU on the codec
/// and the relay only carries the compressed volume.
pub async fn host_to_host(
    src: &Handle<Client>,
    dst: &Handle<Client>,
    src_path: &str,
    dst_path: &str,
    offset: u64,
    compress: bool,
    done: Arc<AtomicU64>,
) -> Result<(), String> {
    let mut rs = open_exec(src, &read_cmd(src_path, offset, compress)).await?;
    let (mut ws, drain) = split_drain(open_exec(dst, &write_cmd(dst_path, offset, compress)).await?);
    let mut buf = vec![0u8; READ_BUF];
    loop {
        let n = rs.read(&mut buf).await.map_err(es)?;
        if n == 0 {
            break;
        }
        ws.write_all(&buf[..n]).await.map_err(es)?;
        done.fetch_add(n as u64, Ordering::Relaxed);
    }
    ws.flush().await.ok();
    ws.shutdown().await.map_err(es)?;
    let _ = drain.await;
    Ok(())
}
