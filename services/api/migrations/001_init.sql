CREATE TABLE IF NOT EXISTS emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_message_id text NOT NULL UNIQUE CHECK (length(trim(external_message_id)) > 0),
  sender text NOT NULL CHECK (length(trim(sender)) > 0),
  subject text NOT NULL CHECK (length(trim(subject)) > 0),
  body text NOT NULL CHECK (length(trim(body)) > 0),
  category text CHECK (category IN ('billing','support','sales','general')),
  priority text CHECK (priority IN ('low','medium','high')),
  assigned_team text CHECK (assigned_team IN ('finance','support','sales','general')),
  summary text,
  needs_review boolean NOT NULL DEFAULT false,
  processing_status text NOT NULL DEFAULT 'queued'
    CHECK (processing_status IN ('queued','processed','needs_review','ai_failed','draft_failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS emails_created_idx ON emails (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS emails_status_idx ON emails (processing_status, created_at);

CREATE TABLE IF NOT EXISTS drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid NOT NULL UNIQUE REFERENCES emails(id) ON DELETE CASCADE,
  content text NOT NULL CHECK (length(trim(content)) > 0),
  approval_status text NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (length(trim(event_type)) > 0),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflow_events_email_idx ON workflow_events (email_id, created_at, id);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id uuid REFERENCES emails(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (length(trim(type)) > 0),
  message text NOT NULL CHECK (length(trim(message)) > 0),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (created_at) WHERE read_at IS NULL;
