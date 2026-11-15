CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,          -- credential id, base64url
  public_key TEXT NOT NULL,     -- SPKI, base64url (ES256 only)
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE login_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start TEXT NOT NULL
);

-- Each WebAuthn challenge may be used once.
CREATE TABLE used_challenges (
  challenge TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
