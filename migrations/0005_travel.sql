-- Named places the owner uses as trip start/end points ("home", "office").
CREATE TABLE places (
  name TEXT PRIMARY KEY,         -- lower-case key
  label TEXT NOT NULL,           -- as the owner said it
  address TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Trips Santino watches: travel time with live traffic, "leave now" and
-- "traffic got worse" notifications.
CREATE TABLE trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  destination TEXT NOT NULL,
  origin TEXT,                   -- address or place name; NULL = his live location, else home
  arrive_by TEXT NOT NULL,       -- ISO UTC
  buffer_min INTEGER NOT NULL DEFAULT 10,
  mode TEXT NOT NULL DEFAULT 'drive',
  source TEXT NOT NULL DEFAULT 'manual', -- manual | calendar
  event_id TEXT UNIQUE,          -- calendar event, for auto-created trips
  status TEXT NOT NULL DEFAULT 'active', -- active | done | cancelled
  next_check_at TEXT NOT NULL,
  baseline_min REAL,
  last_min REAL,
  last_leave_at TEXT,
  alerted_min REAL,              -- duration last told to the owner
  notified_early INTEGER NOT NULL DEFAULT 0,
  notified_leave INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX trips_due ON trips(status, next_check_at);
