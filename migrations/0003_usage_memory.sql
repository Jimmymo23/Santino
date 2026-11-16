CREATE TABLE usage (
  day TEXT NOT NULL,            -- YYYY-MM-DD in the owner's timezone
  kind TEXT NOT NULL,           -- claude | stt | tts
  units REAL NOT NULL DEFAULT 0, -- tokens, audio seconds, characters
  cost REAL NOT NULL DEFAULT 0,  -- USD, estimated from list prices
  PRIMARY KEY (day, kind)
);

CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'other', -- person | preference | decision | business | other
  subject TEXT,
  fact TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
