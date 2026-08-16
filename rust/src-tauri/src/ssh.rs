use russh::client::{self, Handle};
use russh::ChannelMsg;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

pub enum TermMsg {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

#[derive(Default)]
pub struct SshSessions(pub Mutex<HashMap<u32, mpsc::UnboundedSender<TermMsg>>>);

pub struct ConnectSpec {
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub key_pem: Option<String>,
    pub key_pass: Option<String>,
}

/// Handler. `forwarded` receives channels the SERVER opens toward us — that is
/// remote (-R) port forwarding traffic; None for connections that don't use it.
pub struct Client {
    pub forwarded: Option<mpsc::UnboundedSender<russh::Channel<client::Msg>>>,
}

impl Default for Client {
    fn default() -> Self {
        Client { forwarded: None }
    }
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true) // LAN tool: trust-on-use, host key pinning is on the roadmap
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if let Some(tx) = &self.forwarded {
            let _ = tx.send(channel);
        }
        Ok(())
    }
}

/// Pooled connections for SFTP / transfers — one shared connection per host,
/// separate from the per-terminal connections spawn_session makes.
#[derive(Default)]
pub struct SshPool(pub tokio::sync::Mutex<HashMap<i64, Arc<Handle<Client>>>>);

/// Drop the pooled connection for a host — releases SFTP/transfer sessions only;
/// terminals keep their own connections (parity with the web app's release button).
#[tauri::command]
pub async fn pool_release(pool: tauri::State<'_, SshPool>, host_id: i64) -> Result<(), String> {
    if let Some(h) = pool.0.lock().await.remove(&host_id) {
        let _ = h.disconnect(russh::Disconnect::ByApplication, "released", "en").await;
    }
    Ok(())
}

pub async fn pooled(pool: &SshPool, host_id: i64, spec: ConnectSpec) -> Result<Arc<Handle<Client>>, String> {
    let mut map = pool.0.lock().await;
    if let Some(h) = map.get(&host_id) {
        if !h.is_closed() {
            return Ok(h.clone());
        }
        map.remove(&host_id);
    }
    let h = Arc::new(connect(&spec).await?);
    map.insert(host_id, h.clone());
    Ok(h)
}

async fn connect(spec: &ConnectSpec) -> Result<Handle<Client>, String> {
    connect_with(spec, Client::default()).await
}

/// Connect + authenticate with a caller-supplied handler (used by remote tunnels
/// that need the forwarded-channel callback).
pub async fn connect_with(spec: &ConnectSpec, handler: Client) -> Result<Handle<Client>, String> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(std::time::Duration::from_secs(20)),
        ..Default::default()
    });
    let mut handle = client::connect(config, (spec.hostname.as_str(), spec.port), handler)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

    let user = spec.username.clone();
    if let Some(pem) = &spec.key_pem {
        let key = russh::keys::decode_secret_key(pem, spec.key_pass.as_deref())
            .map_err(|e| format!("bad private key: {e}"))?;
        let hash = handle
            .best_supported_rsa_hash()
            .await
            .map_err(|e| e.to_string())?
            .flatten();
        let r = handle
            .authenticate_publickey(
                user.clone(),
                russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await
            .map_err(|e| format!("key auth failed: {e}"))?;
        if r.success() {
            return Ok(handle);
        }
        return Err("key rejected by server".into());
    }

    let pw = spec.password.clone().unwrap_or_default();
    // 1) plain password (servers with PasswordAuthentication yes)
    let r = handle
        .authenticate_password(user.clone(), pw.clone())
        .await
        .map_err(|e| format!("auth failed: {e}"))?;
    if r.success() {
        return Ok(handle);
    }
    // 2) keyboard-interactive — Ubuntu default (PAM), what OpenSSH/asyncssh fall back to
    let mut resp = handle
        .authenticate_keyboard_interactive_start(user.clone(), None)
        .await
        .map_err(|e| format!("auth failed: {e}"))?;
    for _ in 0..8 {
        use client::KeyboardInteractiveAuthResponse as K;
        match resp {
            K::Success => return Ok(handle),
            K::Failure { .. } => break,
            K::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| pw.clone()).collect();
                resp = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(|e| format!("auth failed: {e}"))?;
            }
        }
    }
    Err("authentication rejected (password / keyboard-interactive)".into())
}

const STATS_CMD: &str = "head -1 /proc/stat; echo @@; \
grep -E '^(MemTotal|MemAvailable)' /proc/meminfo; echo @@; \
df -kP / | tail -1; echo @@; \
cat /proc/net/dev; echo @@; \
cut -d' ' -f1 /proc/uptime; echo @@; \
cut -d' ' -f1-3 /proc/loadavg; echo @@; \
who";

/// Spawn an interactive SSH terminal session; terminal I/O flows over
/// the same `pty-out-{id}` / `pty-exit-{id}` events the local PTY uses,
/// plus `stats-{id}` with the raw monitoring command output every second.
pub fn spawn_session(app: AppHandle, sessions: &SshSessions, id: u32, spec: ConnectSpec) {
    let (tx, mut rx) = mpsc::unbounded_channel::<TermMsg>();
    sessions.0.lock().unwrap().insert(id, tx);

    tauri::async_runtime::spawn(async move {
        let emit_err = |msg: &str| {
            let _ = app.emit(
                &format!("pty-out-{id}"),
                format!("\r\n\x1b[1;31m✗ {msg}\x1b[0m\r\n").into_bytes(),
            );
        };

        let handle = match connect(&spec).await {
            Ok(h) => Arc::new(h),
            Err(e) => {
                emit_err(&e);
                let _ = app.emit(&format!("pty-exit-{id}"), ());
                return;
            }
        };

        let mut channel = match handle.channel_open_session().await {
            Ok(c) => c,
            Err(e) => {
                emit_err(&e.to_string());
                let _ = app.emit(&format!("pty-exit-{id}"), ());
                return;
            }
        };
        let pty_ok = channel
            .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .and(channel.request_shell(false).await);
        if let Err(e) = pty_ok {
            emit_err(&e.to_string());
            let _ = app.emit(&format!("pty-exit-{id}"), ());
            return;
        }

        // stats loop on extra channels of the same connection
        let stats_handle = handle.clone();
        let stats_app = app.clone();
        let stats_task = tauri::async_runtime::spawn(async move {
            loop {
                match run_command(&stats_handle, STATS_CMD).await {
                    Some(text) => {
                        let _ = stats_app.emit(&format!("stats-{id}"), text);
                    }
                    None => break,
                }
                tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
            }
        });

        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { ref data }) => {
                            let _ = app.emit(&format!("pty-out-{id}"), data.to_vec());
                        }
                        Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                            let _ = app.emit(&format!("pty-out-{id}"), data.to_vec());
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(TermMsg::Data(bytes)) => { let _ = channel.data(&bytes[..]).await; }
                        Some(TermMsg::Resize(cols, rows)) => {
                            let _ = channel.window_change(cols, rows, 0, 0).await;
                        }
                        Some(TermMsg::Close) | None => break,
                    }
                }
            }
        }

        stats_task.abort();
        let _ = app.emit(&format!("pty-exit-{id}"), ());
    });
}

async fn run_command(handle: &Handle<Client>, cmd: &str) -> Option<String> {
    let mut channel = handle.channel_open_session().await.ok()?;
    channel.exec(true, cmd).await.ok()?;
    let mut out = Vec::new();
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => out.extend_from_slice(data),
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}
