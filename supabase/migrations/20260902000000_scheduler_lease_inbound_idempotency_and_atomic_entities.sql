-- Migration: 20260902000000_scheduler_lease_inbound_idempotency_and_atomic_entities.sql
-- Description: Adds scheduler lease lock columns, persistent inbound message deduplication,
-- and atomic PostgreSQL RPC transactions for entity cascading rename and merge.

-- 1. Add lock columns and delivery_id to reminders
ALTER TABLE reminders 
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_by TEXT,
  ADD COLUMN IF NOT EXISTS lock_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_id TEXT;

CREATE INDEX IF NOT EXISTS idx_reminders_locks ON reminders(status, lock_until, send_at);

-- 2. Add message_id with UNIQUE constraint to messages table for persistent inbound idempotency
ALTER TABLE messages 
  ADD COLUMN IF NOT EXISTS message_id TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);

-- 3. Replace claim_next_pending_reminder with atomic lease & lock recovery
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
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

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

-- 4. Atomic PostgreSQL RPC for entity rename cascade across entities, reminders, tasks, memories
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

  -- 1. Find existing source entity or create target entity
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

  -- 2. Update pending / processing reminders
  WITH upd_rem AS (
    UPDATE reminders
    SET content = regexp_replace(content, v_regex, TRIM(p_new_name), 'gi')
    WHERE user_id = p_user_id
      AND status IN ('pending', 'processing')
      AND content ~* v_regex
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_reminders_updated FROM upd_rem;

  -- 3. Update active tasks and link entity_id
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

  -- 4. Update active memories
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

-- 5. Atomic PostgreSQL RPC for entity merge
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

  -- Fetch source and target entities with lock
  SELECT * INTO v_source FROM entities WHERE id = p_source_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source entity % not found for user %', p_source_id, p_user_id;
  END IF;

  SELECT * INTO v_target FROM entities WHERE id = p_target_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Target entity % not found for user %', p_target_id, p_user_id;
  END IF;

  -- Merge metadata non-destructively
  v_merged_metadata := COALESCE(v_target.metadata, '{}'::jsonb) || COALESCE(v_source.metadata, '{}'::jsonb);

  -- Reassign all tasks from source to target
  WITH upd_tasks AS (
    UPDATE tasks
    SET entity_id = p_target_id,
        updated_at = NOW()
    WHERE user_id = p_user_id
      AND entity_id = p_source_id
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_tasks_reassigned FROM upd_tasks;

  -- Update target entity with merged metadata
  UPDATE entities
  SET metadata = v_merged_metadata,
      updated_at = NOW()
  WHERE id = p_target_id;

  -- Delete source entity
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
