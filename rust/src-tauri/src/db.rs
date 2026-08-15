use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT NOT NULL,
    password_enc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    private_enc TEXT NOT NULL,
    passphrase_enc TEXT
);
CREATE TABLE IF NOT EXISTS hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id INTEGER,
    label TEXT NOT NULL,
    hostname TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL DEFAULT '',
    auth_type TEXT NOT NULL DEFAULT 'password',
    password_enc TEXT,
    key_id INTEGER,
    identity_id INTEGER
);
";

pub fn open(data_dir: PathBuf) -> Db {
    std::fs::create_dir_all(&data_dir).expect("create data dir");
    let conn = Connection::open(data_dir.join("sshdeck.db")).expect("open db");
    conn.execute_batch(SCHEMA).expect("apply schema");
    Db(Mutex::new(conn))
}

#[derive(Serialize)]
pub struct Folder {
    pub id: i64,
    pub name: String,
}

#[derive(Serialize)]
pub struct Host {
    pub id: i64,
    pub folder_id: Option<i64>,
    pub label: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub has_password: bool,
    pub key_id: Option<i64>,
    pub identity_id: Option<i64>,
}

#[derive(Serialize)]
pub struct Identity {
    pub id: i64,
    pub name: String,
    pub username: String,
}

#[derive(Serialize)]
pub struct KeyRow {
    pub id: i64,
    pub name: String,
}

#[derive(Serialize)]
pub struct AppState {
    pub folders: Vec<Folder>,
    pub hosts: Vec<Host>,
    pub identities: Vec<Identity>,
    pub keys: Vec<KeyRow>,
}

pub fn read_state(db: &Db) -> AppState {
    let conn = db.0.lock().unwrap();
    let folders = conn
        .prepare("SELECT id, name FROM folders ORDER BY name")
        .unwrap()
        .query_map([], |r| Ok(Folder { id: r.get(0)?, name: r.get(1)? }))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    let hosts = conn
        .prepare(
            "SELECT id, folder_id, label, hostname, port, username, auth_type, \
             (password_enc IS NOT NULL), key_id, identity_id FROM hosts ORDER BY label",
        )
        .unwrap()
        .query_map([], |r| {
            Ok(Host {
                id: r.get(0)?,
                folder_id: r.get(1)?,
                label: r.get(2)?,
                hostname: r.get(3)?,
                port: r.get(4)?,
                username: r.get(5)?,
                auth_type: r.get(6)?,
                has_password: r.get(7)?,
                key_id: r.get(8)?,
                identity_id: r.get(9)?,
            })
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    let identities = conn
        .prepare("SELECT id, name, username FROM identities ORDER BY name")
        .unwrap()
        .query_map([], |r| {
            Ok(Identity { id: r.get(0)?, name: r.get(1)?, username: r.get(2)? })
        })
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    let keys = conn
        .prepare("SELECT id, name FROM keys ORDER BY name")
        .unwrap()
        .query_map([], |r| Ok(KeyRow { id: r.get(0)?, name: r.get(1)? }))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    AppState { folders, hosts, identities, keys }
}
