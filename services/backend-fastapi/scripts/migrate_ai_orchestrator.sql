-- Migration: AI Orchestrator Tables
-- Adds ai_conversations, ai_tool_calls columns, and citations to ai_turns
-- Run on: srv920095.hstgr.cloud PostgreSQL

BEGIN;

-- ============================================================
-- ai_conversations: conversation-level state and slots
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_conversations (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL,
    contact_id INTEGER,
    state VARCHAR(30) NOT NULL DEFAULT 'new',
    intent VARCHAR(60),
    slots_json TEXT DEFAULT '{}',
    messages_count INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_company ON ai_conversations(company_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_contact ON ai_conversations(contact_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_state ON ai_conversations(company_id, state);

-- ============================================================
-- ai_tool_calls: tool call trace per conversation turn
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_tool_calls (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER REFERENCES ai_conversations(id) ON DELETE CASCADE,
    turn_role VARCHAR(20) DEFAULT 'assistant',
    tool_name VARCHAR(60) NOT NULL,
    tool_args_json TEXT DEFAULT '{}',
    tool_result_json TEXT DEFAULT '{}',
    success BOOLEAN NOT NULL DEFAULT true,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_conversation ON ai_tool_calls(conversation_id, id DESC);

-- ============================================================
-- Add columns to existing ai_turns table if not present
-- These are optional - the orchestrator works without them
-- ============================================================
DO $$
BEGIN
    -- Add intent column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_name = 'ai_turns' AND column_name = 'intent') THEN
        ALTER TABLE ai_turns ADD COLUMN intent VARCHAR(60);
    END IF;

    -- Add latency_ms column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_name = 'ai_turns' AND column_name = 'latency_ms') THEN
        ALTER TABLE ai_turns ADD COLUMN latency_ms DECIMAL(10,2) DEFAULT 0;
    END IF;

    -- Add citations_json column
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_name = 'ai_turns' AND column_name = 'citations_json') THEN
        ALTER TABLE ai_turns ADD COLUMN citations_json TEXT DEFAULT '[]';
    END IF;

    -- Add tokens_in column (if not exists)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_name = 'ai_turns' AND column_name = 'tokens_in') THEN
        ALTER TABLE ai_turns ADD COLUMN tokens_in INTEGER DEFAULT 0;
    END IF;

    -- Add tokens_out column (if not exists)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_name = 'ai_turns' AND column_name = 'tokens_out') THEN
        ALTER TABLE ai_turns ADD COLUMN tokens_out INTEGER DEFAULT 0;
    END IF;
END $$;

-- ============================================================
-- kb_chunks: add embedding_json if not present
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_name = 'kb_chunks' AND column_name = 'embedding_json') THEN
        ALTER TABLE kb_chunks ADD COLUMN embedding_json TEXT DEFAULT '[]';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_name = 'kb_chunks' AND column_name = 'embedding_model') THEN
        ALTER TABLE kb_chunks ADD COLUMN embedding_model VARCHAR(60) DEFAULT 'text-embedding-3-small';
    END IF;
END $$;

-- ============================================================
-- kb_search_logs: add cited_chunk_ids column
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_name = 'kb_search_logs' AND column_name = 'cited_chunk_ids') THEN
        ALTER TABLE kb_search_logs ADD COLUMN cited_chunk_ids TEXT DEFAULT '[]';
    END IF;
END $$;

-- ============================================================
-- ai_agents: add industry column for multi-tenant industry
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_name = 'ai_agents' AND column_name = 'industry') THEN
        ALTER TABLE ai_agents ADD COLUMN industry VARCHAR(60) DEFAULT 'inmobiliaria';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_name = 'ai_agents' AND column_name = 'ai_config_json') THEN
        ALTER TABLE ai_agents ADD COLUMN ai_config_json TEXT DEFAULT '{}';
    END IF;
END $$;

-- ============================================================
-- companies: add industry column
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                  WHERE table_name = 'companies' AND column_name = 'industry') THEN
        ALTER TABLE companies ADD COLUMN industry VARCHAR(60) DEFAULT 'inmobiliaria';
    END IF;
END $$;

COMMIT;

-- Verify tables created
SELECT 'ai_conversations' AS table_name, COUNT(*) AS row_count FROM ai_conversations
UNION ALL
SELECT 'ai_tool_calls', COUNT(*) FROM ai_tool_calls;
