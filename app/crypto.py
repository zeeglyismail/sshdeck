import base64
import hashlib
import os

from cryptography.fernet import Fernet

from .db import DATA_DIR

_KEY_PATH = os.path.join(DATA_DIR, "secret.key")

if not os.path.exists(_KEY_PATH):
    with open(_KEY_PATH, "wb") as f:
        f.write(Fernet.generate_key())

with open(_KEY_PATH, "rb") as f:
    _KEY = f.read().strip()

_fernet = Fernet(_KEY)


def enc(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    return _fernet.encrypt(value.encode()).decode()


def dec(value: str | None) -> str | None:
    if not value:
        return None
    return _fernet.decrypt(value.encode()).decode()


def session_secret() -> str:
    # derive a separate secret for cookie signing from the master key
    return base64.b64encode(hashlib.sha256(_KEY + b"session").digest()).decode()
