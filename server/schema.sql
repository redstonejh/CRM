CREATE TABLE IF NOT EXISTS crm_records (
  entity_type text NOT NULL,
  id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  assignee text,
  doc jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (entity_type, id)
);

CREATE INDEX IF NOT EXISTS crm_records_entity_updated_idx
  ON crm_records (entity_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS crm_records_entity_deleted_idx
  ON crm_records (entity_type, deleted_at);

CREATE INDEX IF NOT EXISTS crm_records_doc_gin_idx
  ON crm_records USING gin (doc);

