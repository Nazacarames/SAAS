-- Migration 002: Schema solidification
-- Fixes type bugs, adds missing indexes, cleans duplicate columns
-- Reversible: see rollback section at bottom
-- Run: psql $DATABASE_URL -f 002_solidify_schema.sql

BEGIN;

-- ══════════════════════════════════════════════════════════════
-- FIX 1: contacts.whatsappId — INTEGER → BIGINT
-- (WhatsApp IDs like 5491127713231 overflow INTEGER max 2.1B)
-- ══════════════════════════════════════════════════════════════
ALTER TABLE contacts ALTER COLUMN "whatsappId" TYPE BIGINT;

-- ══════════════════════════════════════════════════════════════
-- FIX 2: Missing indexes on ai_turns
-- Without these every orchestrator call does a full table scan
-- ══════════════════════════════════════════════════════════════
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_turns_conversation_id
    ON ai_turns(conversation_id, created_at)
    WHERE conversation_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_turns_created_at
    ON ai_turns(created_at DESC);

-- ══════════════════════════════════════════════════════════════
-- FIX 3: Missing indexes on ai_tool_calls
-- ══════════════════════════════════════════════════════════════
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_tool_calls_conversation_id
    ON ai_tool_calls(conversation_id, created_at)
    WHERE conversation_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ai_tool_calls_turn_id
    ON ai_tool_calls(turn_id)
    WHERE turn_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════
-- FIX 4: messages — consolidate 3 duplicate provider ID columns
-- Keep: provider_message_id (snake_case, used by replay guard index)
-- Migrate data from camelCase duplicates, then drop them
-- ══════════════════════════════════════════════════════════════

-- Backfill provider_message_id from the two camelCase dupes (if null)
UPDATE messages
SET provider_message_id = COALESCE(
    provider_message_id,
    "providerMessageId",
    providermessageid
)
WHERE provider_message_id IS NULL
  AND (
    "providerMessageId" IS NOT NULL
    OR providermessageid IS NOT NULL
  );

-- Drop the duplicate columns
ALTER TABLE messages DROP COLUMN IF EXISTS "providerMessageId";
ALTER TABLE messages DROP COLUMN IF EXISTS providermessageid;

-- ══════════════════════════════════════════════════════════════
-- FIX 5: conversations timestamps — add timezone awareness
-- (safe: AT TIME ZONE 'UTC' preserves the existing values)
-- ══════════════════════════════════════════════════════════════
ALTER TABLE conversations
    ALTER COLUMN "lastMessageAt" TYPE TIMESTAMP WITH TIME ZONE
    USING "lastMessageAt" AT TIME ZONE 'UTC';

ALTER TABLE conversations
    ALTER COLUMN "createdAt" TYPE TIMESTAMP WITH TIME ZONE
    USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE conversations
    ALTER COLUMN "updatedAt" TYPE TIMESTAMP WITH TIME ZONE
    USING "updatedAt" AT TIME ZONE 'UTC';

-- ══════════════════════════════════════════════════════════════
-- FIX 6: ai_conversations.slots_json — TEXT → JSONB
-- Enables native JSON ops and GIN index later
-- ══════════════════════════════════════════════════════════════
ALTER TABLE ai_conversations
    ALTER COLUMN slots_json TYPE JSONB
    USING CASE
        WHEN slots_json IS NULL OR slots_json = '' THEN '{}'::JSONB
        ELSE slots_json::JSONB
    END;

-- ══════════════════════════════════════════════════════════════
-- FIX 7: contacts — add composite index for phone lookup
-- get_contact_by_phone does LIKE %digits% — this speeds it up
-- ══════════════════════════════════════════════════════════════
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_number_digits
    ON contacts(
        "companyId",
        regexp_replace(COALESCE(number, ''), '\D', '', 'g')
    )
    WHERE COALESCE("isGroup", false) = false;

-- ══════════════════════════════════════════════════════════════
-- FIX 8: ai_turns — conversation_id NOT NULL constraint
-- New data always sets it; old NULL rows are legacy (pre-2026-04-09)
-- Tag them so we don't accidentally process them as linked
-- ══════════════════════════════════════════════════════════════
-- (No constraint change — legacy NULL rows are intentionally kept for training export)

-- ══════════════════════════════════════════════════════════════
-- VERIFY
-- ══════════════════════════════════════════════════════════════
DO $$
DECLARE
    r RECORD;
BEGIN
    -- Check whatsappId is now BIGINT
    SELECT data_type INTO r FROM information_schema.columns
    WHERE table_name = 'contacts' AND column_name = 'whatsappId';
    ASSERT r.data_type = 'bigint', 'contacts.whatsappId should be bigint';

    -- Check slots_json is now JSONB
    SELECT data_type INTO r FROM information_schema.columns
    WHERE table_name = 'ai_conversations' AND column_name = 'slots_json';
    ASSERT r.data_type = 'jsonb', 'ai_conversations.slots_json should be jsonb';

    RAISE NOTICE 'Migration 002 verified OK';
END $$;

COMMIT;

-- ══════════════════════════════════════════════════════════════
-- ROLLBACK (run manually if needed):
-- ══════════════════════════════════════════════════════════════
-- ALTER TABLE contacts ALTER COLUMN "whatsappId" TYPE INTEGER;
-- DROP INDEX IF EXISTS idx_ai_turns_conversation_id;
-- DROP INDEX IF EXISTS idx_ai_turns_created_at;
-- DROP INDEX IF EXISTS idx_ai_tool_calls_conversation_id;
-- DROP INDEX IF EXISTS idx_ai_tool_calls_turn_id;
-- DROP INDEX IF EXISTS idx_contacts_number_digits;
-- ALTER TABLE ai_conversations ALTER COLUMN slots_json TYPE TEXT USING slots_json::TEXT;
-- ALTER TABLE conversations ALTER COLUMN "lastMessageAt" TYPE TIMESTAMP WITHOUT TIME ZONE USING "lastMessageAt" AT TIME ZONE 'UTC';
-- ALTER TABLE conversations ALTER COLUMN "createdAt" TYPE TIMESTAMP WITHOUT TIME ZONE USING "createdAt" AT TIME ZONE 'UTC';
-- ALTER TABLE conversations ALTER COLUMN "updatedAt" TYPE TIMESTAMP WITHOUT TIME ZONE USING "updatedAt" AT TIME ZONE 'UTC';
-- -- Note: dropped columns (providerMessageId, providermessageid) cannot be rolled back automatically
