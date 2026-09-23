-- Apply with Wrangler D1 migrations; enquiry and outbox are committed atomically.
PRAGMA foreign_keys = ON;
CREATE TABLE enquiries (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  locale TEXT NOT NULL CHECK (locale IN ('en','ko','ja','zh-hant','ru','fr')),
  email TEXT NOT NULL,
  page_url TEXT NOT NULL,
  market TEXT NOT NULL,
  goal TEXT NOT NULL,
  issue TEXT NOT NULL DEFAULT '',
  preferred_time TEXT NOT NULL DEFAULT '',
  acknowledgement_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewing','closed'))
);
CREATE INDEX enquiries_expiry ON enquiries(expires_at);
CREATE TABLE notification_outbox (
  enquiry_id TEXT PRIMARY KEY REFERENCES enquiries(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  provider_message_id TEXT,
  last_error_code TEXT
);
CREATE INDEX notification_due ON notification_outbox(state, next_attempt_at);

CREATE TABLE rate_limits (bucket TEXT PRIMARY KEY, hits INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
