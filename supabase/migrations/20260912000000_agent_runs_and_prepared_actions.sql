-- Migration: 20260912000000_agent_runs_and_prepared_actions.sql
-- Description: Creates durable tables for AgentRun state machine, prepared actions, and execution events.

-- 1. Agent Runs table (Durable multi-turn conversational operations)
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

CREATE INDEX IF NOT EXISTS idx_agent_runs_lookup 
  ON agent_runs(user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_runs_thread 
  ON agent_runs(thread_id, status);

-- 2. Prepared Actions table (Deterministic staged calls with immutable target IDs)
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

CREATE INDEX IF NOT EXISTS idx_prepared_actions_run 
  ON prepared_actions(run_id, status);

-- 3. Execution Events table (Durable audit log for run transitions and execution facts)
CREATE TABLE IF NOT EXISTS agent_execution_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  fact_payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_execution_events_lookup 
  ON agent_execution_events(user_id, created_at DESC);
