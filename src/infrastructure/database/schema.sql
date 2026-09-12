-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- 1. Users table (Identity, Timezone, Preferences, Morning Briefing, Admin RBAC)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number TEXT UNIQUE NOT NULL,
  display_name TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Bogota',
  locale TEXT NOT NULL DEFAULT 'es-CO',
  is_admin BOOLEAN DEFAULT FALSE,
  morning_briefing_enabled BOOLEAN DEFAULT TRUE,
  morning_briefing_time TEXT DEFAULT '06:00',
  last_briefing_at TIMESTAMPTZ,
  last_user_message_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);
CREATE INDEX IF NOT EXISTS idx_users_last_message ON users(last_user_message_at);

-- 2. Entities table (People, Companies, Projects, Assets, Places)
CREATE TABLE IF NOT EXISTS entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('person', 'company', 'project', 'asset', 'place', 'other')),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, name, category)
);
CREATE INDEX IF NOT EXISTS idx_entities_user_id ON entities(user_id);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(user_id, name);

-- 3. Tasks table (Actionable Todos, Deadlines, Priorities)
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  due_date TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(user_id, due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_fts ON tasks USING gin(to_tsvector('spanish', title));

-- 4. Reminders table (with Recurrence, Concurrency Locks & Persistent Nudge Escalation Support)
CREATE TABLE IF NOT EXISTS reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
  parent_reminder_id UUID REFERENCES reminders(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  content TEXT NOT NULL,
  send_at TIMESTAMPTZ NOT NULL,
  recurrence_rule TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'missed', 'cancelled')),
  claimed_at TIMESTAMPTZ,
  claimed_by TEXT,
  lock_until TIMESTAMPTZ,
  delivery_id TEXT,
  requires_confirmation BOOLEAN DEFAULT FALSE,
  nudge_interval_minutes INTEGER,
  max_nudges INTEGER,
  nudge_count INTEGER,
  last_nudged_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_reminders_status_send_at ON reminders(status, send_at);
CREATE INDEX IF NOT EXISTS idx_reminders_user_id ON reminders(user_id);
CREATE INDEX IF NOT EXISTS idx_reminders_nudge ON reminders(requires_confirmation, acknowledged_at, status);
CREATE INDEX IF NOT EXISTS idx_reminders_locks ON reminders(status, lock_until, send_at);

-- Atomic Reminder Claiming Function for Distributed Multi-Worker Deployments (FOR UPDATE SKIP LOCKED)
CREATE OR REPLACE FUNCTION claim_next_pending_reminder(p_worker_id TEXT DEFAULT 'worker-1', p_lock_duration_sec INT DEFAULT 120)
RETURNS SETOF reminders AS $$
DECLARE
  v_reminder_id UUID;
BEGIN
  SELECT id INTO v_reminder_id
  FROM reminders
  WHERE (status = 'pending' AND send_at <= NOW())
     OR (status = 'processing' AND lock_until IS NOT NULL AND lock_until < NOW())
  ORDER BY send_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF v_reminder_id IS NOT NULL THEN
    RETURN QUERY
    UPDATE reminders
    SET status = 'processing',
        claimed_at = NOW(),
        claimed_by = p_worker_id,
        lock_until = NOW() + (p_lock_duration_sec || ' seconds')::INTERVAL
    WHERE id = v_reminder_id
    RETURNING *;
  END IF;
  RETURN;
END;
$$ LANGUAGE plpgsql;

-- 5. Memories table (with 768-dim Vector Embeddings for Semantic Search)
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_key TEXT,
  category TEXT NOT NULL CHECK (category IN ('fact', 'preference', 'decision', 'episode', 'observation', 'project')),
  content TEXT NOT NULL,
  confidence FLOAT DEFAULT 1.0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from TIMESTAMPTZ DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  superseded_by UUID REFERENCES memories(id) ON DELETE SET NULL,
  embedding vector(768),
  last_accessed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memories_user_active ON memories(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(user_id, topic_key);
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_memories_fts ON memories USING gin(to_tsvector('spanish', content));

-- 6. Conversation working memory (Level 1)
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id TEXT UNIQUE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  intent TEXT,
  entities JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_phone_created ON messages(phone_number, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);

-- Atomic PostgreSQL RPC for entity rename cascade across entities, reminders, tasks, memories
CREATE OR REPLACE FUNCTION rename_entity_cascade(
  p_user_id UUID,
  p_old_name TEXT,
  p_new_name TEXT,
  p_category TEXT DEFAULT 'other'
)
RETURNS JSONB AS $$
DECLARE
  v_entity_id UUID;
  v_tasks_updated INT := 0;
  v_reminders_updated INT := 0;
  v_memories_updated INT := 0;
  v_regex TEXT;
BEGIN
  IF p_user_id IS NULL OR p_old_name IS NULL OR p_new_name IS NULL THEN
    RAISE EXCEPTION 'Invalid parameters: user_id, old_name, and new_name are required';
  END IF;

  SELECT id INTO v_entity_id
  FROM entities
  WHERE user_id = p_user_id
    AND LOWER(name) = LOWER(TRIM(p_old_name))
  LIMIT 1;

  IF v_entity_id IS NOT NULL THEN
    UPDATE entities
    SET name = TRIM(p_new_name),
        updated_at = NOW()
    WHERE id = v_entity_id;
  ELSE
    INSERT INTO entities (user_id, name, category, metadata)
    VALUES (p_user_id, TRIM(p_new_name), COALESCE(p_category, 'other'), '{}'::jsonb)
    ON CONFLICT (user_id, name, category) DO UPDATE
      SET updated_at = NOW()
    RETURNING id INTO v_entity_id;
  END IF;

  v_regex := '\m' || regexp_replace(TRIM(p_old_name), '([.*+?^${}()|[\]\\])', '\\\1', 'g') || '\M';

  WITH upd_rem AS (
    UPDATE reminders
    SET content = regexp_replace(content, v_regex, TRIM(p_new_name), 'gi')
    WHERE user_id = p_user_id
      AND status IN ('pending', 'processing')
      AND content ~* v_regex
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_reminders_updated FROM upd_rem;

  WITH upd_tsk AS (
    UPDATE tasks
    SET title = regexp_replace(title, v_regex, TRIM(p_new_name), 'gi'),
        description = CASE 
          WHEN description IS NOT NULL THEN regexp_replace(description, v_regex, TRIM(p_new_name), 'gi')
          ELSE description 
        END,
        entity_id = COALESCE(entity_id, v_entity_id),
        updated_at = NOW()
    WHERE user_id = p_user_id
      AND status IN ('pending', 'in_progress')
      AND (title ~* v_regex OR description ~* v_regex)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_tasks_updated FROM upd_tsk;

  WITH upd_mem AS (
    UPDATE memories
    SET content = regexp_replace(content, v_regex, TRIM(p_new_name), 'gi'),
        topic_key = regexp_replace(topic_key, v_regex, LOWER(TRIM(p_new_name)), 'gi')
    WHERE user_id = p_user_id
      AND is_active = TRUE
      AND (content ~* v_regex OR topic_key ~* v_regex)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_memories_updated FROM upd_mem;

  RETURN jsonb_build_object(
    'success', true,
    'entity_id', v_entity_id,
    'old_name', p_old_name,
    'new_name', p_new_name,
    'reminders_updated', v_reminders_updated,
    'tasks_updated', v_tasks_updated,
    'memories_updated', v_memories_updated
  );
END;
$$ LANGUAGE plpgsql;

-- Atomic PostgreSQL RPC for entity merge
CREATE OR REPLACE FUNCTION merge_entities(
  p_user_id UUID,
  p_source_id UUID,
  p_target_id UUID
)
RETURNS JSONB AS $$
DECLARE
  v_source entities%ROWTYPE;
  v_target entities%ROWTYPE;
  v_tasks_reassigned INT := 0;
  v_merged_metadata JSONB;
BEGIN
  IF p_user_id IS NULL OR p_source_id IS NULL OR p_target_id IS NULL THEN
    RAISE EXCEPTION 'Invalid parameters: user_id, source_id, and target_id are required';
  END IF;

  IF p_source_id = p_target_id THEN
    RETURN jsonb_build_object('success', true, 'message', 'source and target are identical');
  END IF;

  SELECT * INTO v_source FROM entities WHERE id = p_source_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source entity % not found for user %', p_source_id, p_user_id;
  END IF;

  SELECT * INTO v_target FROM entities WHERE id = p_target_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target entity % not found for user %', p_target_id, p_user_id;
  END IF;

  v_merged_metadata := COALESCE(v_target.metadata, '{}'::jsonb) || COALESCE(v_source.metadata, '{}'::jsonb);

  WITH upd_tasks AS (
    UPDATE tasks
    SET entity_id = p_target_id,
        updated_at = NOW()
    WHERE user_id = p_user_id
      AND entity_id = p_source_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_tasks_reassigned FROM upd_tasks;

  UPDATE entities
  SET metadata = v_merged_metadata,
      updated_at = NOW()
  WHERE id = p_target_id;

  DELETE FROM entities WHERE id = p_source_id AND user_id = p_user_id;

  RETURN jsonb_build_object(
    'success', true,
    'source_id', p_source_id,
    'target_id', p_target_id,
    'tasks_reassigned', v_tasks_reassigned,
    'merged_metadata', v_merged_metadata
  );
END;
$$ LANGUAGE plpgsql;

-- 7. Subscriptions table (Billing, Plans, Active status, MercadoPago Integration)
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  amount NUMERIC DEFAULT 0,
  mp_preapproval_id TEXT UNIQUE,
  next_payment_date TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_mp_preapproval ON subscriptions(mp_preapproval_id);

-- 8. Agent Runs table (Durable multi-turn conversational operations)
CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'running',
    'waiting_for_input',
    'waiting_for_approval',
    'completed',
    'cancelled',
    'failed',
    'expired'
  )),
  kind TEXT NOT NULL CHECK (kind IN (
    'reminder_creation',
    'entity_destructive_batch',
    'task_mutation',
    'generic_operation'
  )),
  waiting_for JSONB,
  context JSONB DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_lookup ON agent_runs(user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_thread ON agent_runs(thread_id, status);

-- 9. Prepared Actions table (Deterministic staged calls with immutable target IDs)
CREATE TABLE IF NOT EXISTS prepared_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('entity', 'reminder', 'task', 'calendar', 'conversation')),
  action TEXT NOT NULL,
  target_id UUID,
  target_name TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN (
    'prepared',
    'executed',
    'skipped',
    'failed'
  )),
  execution_fact JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_at TIMESTAMPTZ,
  UNIQUE(run_id, call_id)
);
CREATE INDEX IF NOT EXISTS idx_prepared_actions_run ON prepared_actions(run_id, status);

-- 10. Execution Events table (Durable audit log for run transitions and execution facts)
CREATE TABLE IF NOT EXISTS agent_execution_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  fact_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_execution_events_lookup ON agent_execution_events(user_id, created_at DESC);
