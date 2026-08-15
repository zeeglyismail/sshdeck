//! Port forwarding: local (-L), remote (-R) and dynamic SOCKS5 (-D), all riding
//! the pooled SSH connection of a saved host. Listeners bind on the user's own
//! machine (or, for remote, on the server) — no container port range needed.

use crate::ssh::{pooled, Client, SshPool};
use russh::client::{Handle, Msg};
use russh::{Channel, ChannelMsg};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[derive(Serialize, Clone)]
pub struct TunnelRow {
    pub id: i64,
    pub host_id: i64,
    pub host_label: String,
    pub name: String,
    pub kind: String,        // local | remote | socks
    pub listen_port: u16,
    pub dest_host: String,
    pub dest_port: u16,
    pub active: bool,
    pub error: Option<String>,
}

/// running tunnels: id -> stop signal
#[derive(Default)]
pub struct Active(pub Mutex<HashMap<i64, watch::Sender<bool>>>);

pub fn ensure_schema(conn: &rusqlite::Connection) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS tunnels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            host_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'local',
            listen_port INTEGER NOT NULL,
            dest_host TEXT NOT NULL DEFAULT 'localhost',
            dest_port INTEGER NOT NULL DEFAULT 0
        );",
    )
    .expect("tunnels schema");
}

#[tauri::command]
pub fn tunnels_list(db: State<crate::db::Db>, active: State<Active>) -> Vec<TunnelRow> {
    let conn = db.0.lock().unwrap();
    let act = active.0.lock().unwrap();
    let mut st = conn
        .prepare(
            "SELECT t.id, t.host_id, h.label, t.name, t.kind, t.listen_port, t.dest_host, t.dest_port \
             FROM tunnels t JOIN hosts h ON h.id = t.host_id ORDER BY t.name",
        )
        .unwrap();
    st.query_map([], |r| {
        let id: i64 = r.get(0)?;
        Ok(TunnelRow {
            id,
            host_id: r.get(1)?,
            host_label: r.get(2)?,
            name: r.get(3)?,
            kind: r.get(4)?,
            listen_port: r.get(5)?,
            dest_host: r.get(6)?,
            dest_port: r.get(7)?,
            active: act.contains_key(&id),
            error: None,
        })
    })
    .unwrap()
    .filter_map(Result::ok)
    .collect()
}

#[tauri::command]
pub fn tunnel_save(
    db: State<crate::db::Db>,
    host_id: i64,
    name: String,
    kind: String,
    listen_port: u16,
    dest_host: String,
    dest_port: u16,
) -> Result<i64, String> {
    if !matches!(kind.as_str(), "local" | "remote" | "socks") {
        return Err("kind must be local, remote or socks".into());
    }
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO tunnels(host_id, name, kind, listen_port, dest_host, dest_port) VALUES(?1,?2,?3,?4,?5,?6)",
        rusqlite::params![host_id, name, kind, listen_port, dest_host, dest_port],
    )
    .map_err(es)?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn tunnel_delete(db: State<crate::db::Db>, active: State<Active>, id: i64) -> Result<(), String> {
    if let Some(tx) = active.0.lock().unwrap().remove(&id) {
        let _ = tx.send(true);
    }
    db.0.lock().unwrap().execute("DELETE FROM tunnels WHERE id=?1", [id]).map_err(es)?;
    Ok(())
}

#[tauri::command]
pub fn tunnel_stop(app: AppHandle, active: State<Active>, id: i64) {
    if let Some(tx) = active.0.lock().unwrap().remove(&id) {
        let _ = tx.send(true);
    }
    let _ = app.emit("tunnels-changed", ());
}

#[tauri::command]
pub async fn tunnel_start(app: AppHandle, pool: State<'_, SshPool>, active: State<'_, Active>, id: i64) -> Result<(), String> {
    let (host_id, kind, listen_port, dest_host, dest_port): (i64, String, u16, String, u16) = {
        let db = app.state::<crate::db::Db>();
        let conn = db.0.lock().unwrap();
        conn.query_row(
            "SELECT host_id, kind, listen_port, dest_host, dest_port FROM tunnels WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .map_err(|_| "Tunnel not found".to_string())?
    };
    if active.0.lock().unwrap().contains_key(&id) {
        return Ok(());
    }
    let spec = crate::build_spec(&app, host_id)?;
    let handle = pooled(&pool, host_id, spec).await?;
    let (stop_tx, stop_rx) = watch::channel(false);

    match kind.as_str() {
        "local" => {
            let listener = TcpListener::bind(("127.0.0.1", listen_port))
                .await
                .map_err(|e| format!("cannot listen on 127.0.0.1:{listen_port}: {e} — on Windows this is often the ephemeral-port range (try a port ≥ 49152, or run as admin: netsh int ipv4 set dynamicport tcp start=49152 num=16384)"))?;
            active.0.lock().unwrap().insert(id, stop_tx);
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                run_local(listener, handle, dest_host, dest_port, stop_rx).await;
                app2.state::<Active>().0.lock().unwrap().remove(&id);
                let _ = app2.emit("tunnels-changed", ());
            });
        }
        "socks" => {
            let listener = TcpListener::bind(("127.0.0.1", listen_port))
                .await
                .map_err(|e| format!("cannot listen on 127.0.0.1:{listen_port}: {e} — on Windows this is often the ephemeral-port range (try a port ≥ 49152, or run as admin: netsh int ipv4 set dynamicport tcp start=49152 num=16384)"))?;
            active.0.lock().unwrap().insert(id, stop_tx);
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                run_socks(listener, handle, stop_rx).await;
                app2.state::<Active>().0.lock().unwrap().remove(&id);
                let _ = app2.emit("tunnels-changed", ());
            });
        }
        "remote" => {
            // dedicated connection whose handler pushes forwarded channels to us
            drop(handle);
            let spec = crate::build_spec(&app, host_id)?;
            let (fwd_tx, fwd_rx) = tokio::sync::mpsc::unbounded_channel();
            let mut h = crate::ssh::connect_with(&spec, Client { forwarded: Some(fwd_tx) }).await?;
            h.tcpip_forward("0.0.0.0", listen_port as u32)
                .await
                .map_err(|e| format!(
                    "server refused to listen on port {listen_port} ({e}). Usually that port is already                      in use ON THE SERVER, or sshd has GatewayPorts/AllowTcpForwarding off.                      Tip: to reach a service running on the server from this PC you want a LOCAL tunnel,                      not remote."))?;
            active.0.lock().unwrap().insert(id, stop_tx);
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                run_remote(h, fwd_rx, dest_host, dest_port, listen_port, stop_rx).await;
                app2.state::<Active>().0.lock().unwrap().remove(&id);
                let _ = app2.emit("tunnels-changed", ());
            });
        }
        _ => return Err("unknown tunnel kind".into()),
    }
    let _ = app.emit("tunnels-changed", ());
    Ok(())
}

/* ---------- local -L ---------- */

async fn run_local(listener: TcpListener, handle: Arc<Handle<Client>>, dest_host: String, dest_port: u16, mut stop: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            acc = listener.accept() => {
                let Ok((sock, peer)) = acc else { break };
                let h = handle.clone();
                let dh = dest_host.clone();
                tauri::async_runtime::spawn(async move {
                    match h.channel_open_direct_tcpip(dh, dest_port as u32, peer.ip().to_string(), peer.port() as u32).await {
                        Ok(ch) => bridge(sock, ch).await,
                        Err(_) => {}
                    }
                });
            }
        }
    }
}

/// pump bytes both ways between a TCP socket and an SSH channel
async fn bridge(mut sock: TcpStream, mut ch: Channel<Msg>) {
    let mut buf = vec![0u8; 32 * 1024];
    loop {
        tokio::select! {
            r = sock.read(&mut buf) => {
                match r {
                    Ok(0) | Err(_) => { let _ = ch.eof().await; break; }
                    Ok(n) => { if ch.data(&buf[..n]).await.is_err() { break; } }
                }
            }
            m = ch.wait() => {
                match m {
                    Some(ChannelMsg::Data { data }) => { if sock.write_all(&data).await.is_err() { break; } }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }
    }
    let _ = sock.shutdown().await;
}

/* ---------- dynamic SOCKS5 -D ---------- */

async fn run_socks(listener: TcpListener, handle: Arc<Handle<Client>>, mut stop: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            acc = listener.accept() => {
                let Ok((sock, _)) = acc else { break };
                let h = handle.clone();
                tauri::async_runtime::spawn(async move { let _ = socks_session(sock, h).await; });
            }
        }
    }
}

async fn socks_session(mut sock: TcpStream, handle: Arc<Handle<Client>>) -> Result<(), String> {
    // greeting
    let mut hdr = [0u8; 2];
    sock.read_exact(&mut hdr).await.map_err(es)?;
    if hdr[0] != 5 {
        return Err("not socks5".into());
    }
    let mut methods = vec![0u8; hdr[1] as usize];
    sock.read_exact(&mut methods).await.map_err(es)?;
    sock.write_all(&[5, 0]).await.map_err(es)?; // no auth
    // request
    let mut req = [0u8; 4];
    sock.read_exact(&mut req).await.map_err(es)?;
    if req[1] != 1 {
        sock.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await.ok();
        return Err("only CONNECT supported".into());
    }
    let host = match req[3] {
        1 => { let mut a = [0u8; 4]; sock.read_exact(&mut a).await.map_err(es)?; std::net::Ipv4Addr::from(a).to_string() }
        3 => { let mut l = [0u8; 1]; sock.read_exact(&mut l).await.map_err(es)?; let mut n = vec![0u8; l[0] as usize]; sock.read_exact(&mut n).await.map_err(es)?; String::from_utf8_lossy(&n).into_owned() }
        4 => { let mut a = [0u8; 16]; sock.read_exact(&mut a).await.map_err(es)?; std::net::Ipv6Addr::from(a).to_string() }
        _ => return Err("bad atyp".into()),
    };
    let mut p = [0u8; 2];
    sock.read_exact(&mut p).await.map_err(es)?;
    let port = u16::from_be_bytes(p);
    match handle.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0).await {
        Ok(ch) => {
            sock.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.map_err(es)?;
            bridge(sock, ch).await;
            Ok(())
        }
        Err(e) => {
            sock.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await.ok();
            Err(e.to_string())
        }
    }
}

/* ---------- remote -R ---------- */

/// Server listens on listen_port; each incoming connection arrives as a channel
/// (via Client::forwarded) which we bridge to dest_host:dest_port on OUR side.
async fn run_remote(
    handle: Handle<Client>,
    mut fwd_rx: tokio::sync::mpsc::UnboundedReceiver<Channel<Msg>>,
    dest_host: String,
    dest_port: u16,
    listen_port: u16,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            ch = fwd_rx.recv() => {
                let Some(ch) = ch else { break };
                let dh = dest_host.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(sock) = TcpStream::connect((dh.as_str(), dest_port)).await {
                        bridge(sock, ch).await;
                    }
                });
            }
        }
    }
    let _ = handle.cancel_tcpip_forward("0.0.0.0", listen_port as u32).await;
    let _ = handle.disconnect(russh::Disconnect::ByApplication, "tunnel stopped", "en").await;
}
