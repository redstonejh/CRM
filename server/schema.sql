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

-- The operating model is explicit here. Records describe things; these tables
-- describe how work moves around and between those things.
CREATE TABLE IF NOT EXISTS crm_relationships (
  id text PRIMARY KEY,
  from_entity text NOT NULL,
  from_id text NOT NULL,
  to_entity text NOT NULL,
  to_id text NOT NULL,
  kind text NOT NULL DEFAULT 'related',
  role text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  doc jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS crm_relationships_from_idx
  ON crm_relationships (from_entity, from_id, deleted_at);
CREATE INDEX IF NOT EXISTS crm_relationships_to_idx
  ON crm_relationships (to_entity, to_id, deleted_at);

CREATE TABLE IF NOT EXISTS crm_commitments (
  id text PRIMARY KEY,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'task',
  status text NOT NULL DEFAULT 'open',
  due_at timestamptz,
  assignee text,
  visibility text NOT NULL DEFAULT 'private',
  priority text NOT NULL DEFAULT 'normal',
  completed_at timestamptz,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  doc jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS crm_commitments_due_idx
  ON crm_commitments (status, due_at, deleted_at);
CREATE INDEX IF NOT EXISTS crm_commitments_owner_idx
  ON crm_commitments (assignee, status, deleted_at);

CREATE TABLE IF NOT EXISTS crm_commitment_links (
  commitment_id text NOT NULL REFERENCES crm_commitments(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  record_id text NOT NULL,
  relation text NOT NULL DEFAULT 'regarding',
  PRIMARY KEY (commitment_id, entity_type, record_id, relation)
);
CREATE INDEX IF NOT EXISTS crm_commitment_links_record_idx
  ON crm_commitment_links (entity_type, record_id);

CREATE TABLE IF NOT EXISTS crm_activities (
  id text PRIMARY KEY,
  kind text NOT NULL DEFAULT 'note',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor text,
  content text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  doc jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS crm_activities_occurred_idx
  ON crm_activities (occurred_at DESC, deleted_at);

CREATE TABLE IF NOT EXISTS crm_activity_links (
  activity_id text NOT NULL REFERENCES crm_activities(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  record_id text NOT NULL,
  relation text NOT NULL DEFAULT 'regarding',
  PRIMARY KEY (activity_id, entity_type, record_id, relation)
);
CREATE INDEX IF NOT EXISTS crm_activity_links_record_idx
  ON crm_activity_links (entity_type, record_id);

CREATE TABLE IF NOT EXISTS crm_workflow_entries (
  id text PRIMARY KEY,
  workflow_key text NOT NULL,
  entity_type text NOT NULL,
  record_id text NOT NULL,
  stage text NOT NULL,
  rank numeric NOT NULL DEFAULT 0,
  owner text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  doc jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_workflow_entry_active_idx
  ON crm_workflow_entries (workflow_key, entity_type, record_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS crm_workflow_stage_idx
  ON crm_workflow_entries (workflow_key, stage, rank, deleted_at);
