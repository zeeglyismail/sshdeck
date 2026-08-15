import os
import sqlite3
import threading

DATA_DIR = os.environ.get("DATA_DIR", "./data")
os.makedirs(DATA_DIR, exist_ok=True)

_conn = sqlite3.connect(os.path.join(DATA_DIR, "sshdeck.db"), check_same_thread=False)
_conn.row_factory = sqlite3.Row
_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    pw_hash TEXT NOT NULL,
    created TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    parent_id INTEGER
);
CREATE TABLE IF NOT EXISTS keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    private_enc TEXT NOT NULL,
    passphrase_enc TEXT
);
CREATE TABLE IF NOT EXISTS identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    username TEXT NOT NULL,
    password_enc TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tunnels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    host_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    listen_port INTEGER NOT NULL,
    dest_host TEXT NOT NULL DEFAULT 'localhost',
    dest_port INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    folder_id INTEGER,
    label TEXT NOT NULL,
    hostname TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'password',
    password_enc TEXT,
    key_id INTEGER,
    identity_id INTEGER
);
"""


def init():
    with _lock:
        _conn.executescript(SCHEMA)
        # migrations for volumes created before these columns existed
        try:
            _conn.execute("ALTER TABLE hosts ADD COLUMN identity_id INTEGER")
        except sqlite3.OperationalError:
            pass
        try:
            _conn.execute("ALTER TABLE folders ADD COLUMN parent_id INTEGER")
        except sqlite3.OperationalError:
            pass
        # old schema had UNIQUE(user_id, name); nested folders may legitimately share
        # names under different parents, so rebuild the table without that constraint
        idx = _conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='folders'").fetchone()
        if idx and "UNIQUE" in (idx[0] or ""):
            _conn.executescript("""
                CREATE TABLE folders_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    parent_id INTEGER
                );
                INSERT INTO folders_new(id, user_id, name, parent_id)
                    SELECT id, user_id, name, parent_id FROM folders;
                DROP TABLE folders;
                ALTER TABLE folders_new RENAME TO folders;
            """)
        _conn.commit()


def q(sql, args=()):
    with _lock:
        cur = _conn.execute(sql, args)
        return cur.fetchall()


def one(sql, args=()):
    rows = q(sql, args)
    return rows[0] if rows else None


def x(sql, args=()):
    with _lock:
        cur = _conn.execute(sql, args)
        _conn.commit()
        return cur.lastrowid
