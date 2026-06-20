-- Migration: add training/fine-tuning support columns
-- Run: psql $DATABASE_URL -f app/migrations/add_training_columns.sql

-- Conversation-level rating (thumbs up/down) for training data curation
ALTER TABLE ai_conversations
  ADD COLUMN IF NOT EXISTS rating SMALLINT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS rating_comment TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS exported_for_training BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS export_run_id TEXT DEFAULT NULL;

-- Agent model tracking: base model + optional ft system prompt
ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS base_model TEXT DEFAULT 'gpt-4o-mini',
  ADD COLUMN IF NOT EXISTS ft_system_prompt TEXT DEFAULT NULL;

-- Golden training examples (curated by hand, highest quality)
CREATE TABLE IF NOT EXISTS ai_training_golden (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    messages JSONB NOT NULL,
    active BOOLEAN DEFAULT TRUE,
    weight INTEGER DEFAULT 1,  -- repeat this many times in training data
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index for efficient rating-based export
CREATE INDEX IF NOT EXISTS idx_ai_conversations_rating ON ai_conversations(rating);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_exported ON ai_conversations(exported_for_training);
