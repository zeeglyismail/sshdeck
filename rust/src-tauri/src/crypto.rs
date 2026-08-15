use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::RngCore;
use std::path::PathBuf;

pub struct Crypto {
    cipher: Aes256Gcm,
}

impl Crypto {
    pub fn load(data_dir: PathBuf) -> Self {
        let key_path = data_dir.join("secret.key");
        let key_bytes: [u8; 32] = if key_path.exists() {
            let raw = std::fs::read(&key_path).expect("read key");
            raw.try_into().expect("key must be 32 bytes")
        } else {
            let mut k = [0u8; 32];
            OsRng.fill_bytes(&mut k);
            std::fs::write(&key_path, k).expect("write key");
            k
        };
        let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
        Crypto { cipher: Aes256Gcm::new(key) }
    }

    pub fn enc(&self, plain: &str) -> String {
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct = self.cipher.encrypt(nonce, plain.as_bytes()).expect("encrypt");
        let mut out = nonce_bytes.to_vec();
        out.extend(ct);
        B64.encode(out)
    }

    pub fn dec(&self, encoded: &str) -> Option<String> {
        let raw = B64.decode(encoded).ok()?;
        if raw.len() < 13 {
            return None;
        }
        let (nonce_bytes, ct) = raw.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);
        let pt = self.cipher.decrypt(nonce, ct).ok()?;
        String::from_utf8(pt).ok()
    }
}
