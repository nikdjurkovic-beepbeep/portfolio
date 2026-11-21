-- Two-factor authentication (TOTP authenticator apps + recovery codes)

ALTER TABLE users ADD COLUMN totp_secret TEXT;              -- AES-GCM encrypted, see src/mfa.js
ALTER TABLE users ADD COLUMN totp_pending TEXT;             -- encrypted secret awaiting confirmation
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;        -- last accepted 30-second step (replay protection)
ALTER TABLE users ADD COLUMN totp_enabled_at TEXT;
ALTER TABLE users ADD COLUMN recovery_codes TEXT NOT NULL DEFAULT '[]';  -- SHA-256 hashes of unused codes

-- Password verified, waiting for the second factor. Never a session.
CREATE TABLE IF NOT EXISTS login_challenges (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Who must use 2FA: none | administrators | staff (everyone with CMS access) | all
INSERT OR IGNORE INTO settings (key, value) VALUES ('require_2fa', 'staff');
UPDATE settings SET value = '2' WHERE key = 'schema_version';
