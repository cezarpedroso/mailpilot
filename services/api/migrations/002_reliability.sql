ALTER TABLE emails ADD COLUMN IF NOT EXISTS retry_attempts integer NOT NULL DEFAULT 0 CHECK (retry_attempts >= 0);
ALTER TABLE emails ADD COLUMN IF NOT EXISTS next_retry_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE emails ADD COLUMN IF NOT EXISTS retry_claim_token uuid;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS retry_lease_until timestamptz;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS last_error_code text;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emails_processing_status_check'
    AND pg_get_constraintdef(oid) NOT LIKE '%retry_exhausted%') THEN
    ALTER TABLE emails DROP CONSTRAINT emails_processing_status_check;
    ALTER TABLE emails ADD CONSTRAINT emails_processing_status_check
      CHECK (processing_status IN ('queued','processed','needs_review','ai_failed','draft_failed','retry_exhausted'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS emails_retry_idx ON emails (next_retry_at, retry_lease_until)
  WHERE processing_status IN ('queued','ai_failed','draft_failed');

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_idempotency_idx ON notifications (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS automation_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id text NOT NULL,
  workflow_name text NOT NULL,
  execution_id text,
  error_code text NOT NULL,
  error_message text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS automation_failures_created_idx ON automation_failures (created_at DESC);
