# RAG Vectorial Implementation Plan

## Current State

The current RAG implementation uses PostgreSQL `LIKE/ILIKE` queries, which is NOT true RAG:
- `kb_chunks` table has `embedding_json` column but it's never populated
- Search uses `ts_rank_cd` which is FTS, not vector similarity
- Phase 3 of AI_AGENT_MASTER_PLAN is incomplete

## Target State

True vector-based RAG using:
- **pgvector** extension for PostgreSQL
- OpenAI `text-embedding-3-small` or `text-embedding-3-large` for embeddings
- Cosine similarity for semantic search

## Implementation Plan

### Phase 1: Database Setup

1. Enable pgvector extension
2. Add vector column to kb_chunks
3. Create vector index for HNSW or IVFFlat search

### Phase 2: Embedding Generation

1. Create embedding service using OpenAI API
2. Batch process existing kb_documents
3. Schedule periodic re-embedding on document updates

### Phase 3: Semantic Search

1. Update `searchKnowledge()` to use vector similarity
2. Hybrid search: combine vector + keyword (BM25)
3. Reranking for better results

## Database Migration

```sql
-- Enable extension (run once)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column
ALTER TABLE kb_chunks
ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- Create index (HNSW - better recall, faster build)
CREATE INDEX ON kb_chunks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Or use IVFFlat (better for large datasets)
-- CREATE INDEX ON kb_chunks
-- USING ivfflat (embedding vector_cosine_ops)
-- WITH (lists = 100);
```

## Embedding Service

```typescript
interface EmbeddingOptions {
  model: "text-embedding-3-small" | "text-embedding-3-large";
  dimensions?: number; // 1536 for 3-small, 256/512/1024 for 3-large
}

const generateEmbedding = async (text: string, options?: EmbeddingOptions): Promise<number[]> => {
  const response = await openai.embeddings.create({
    model: options?.model || "text-embedding-3-small",
    input: text,
    dimensions: options?.dimensions || 1536,
  });

  return response.data[0].embedding;
};
```

## Hybrid Search Query

```sql
-- Semantic search (vector)
WITH semantic_results AS (
  SELECT c.id, c.chunk_text, d.title, d.category,
         1 - (c.embedding <=> :query_embedding) AS similarity
  FROM kb_chunks c
  JOIN kb_documents d ON d.id = c.document_id
  WHERE d.company_id = :companyId
  ORDER BY c.embedding <=> :query_embedding
  LIMIT 5
),

-- Keyword search (BM25)
keyword_results AS (
  SELECT c.id, c.chunk_text, d.title, d.category,
         ts_rank_cd(c.chunk_tsv, plainto_tsquery('spanish', :query)) AS rank
  FROM kb_chunks c
  JOIN kb_documents d ON d.id = c.document_id
  WHERE d.company_id = :companyId
    AND c.chunk_tsv @@ plainto_tsquery('spanish', :query)
  ORDER BY rank DESC
  LIMIT 5
)

-- Combine with RRF (Reciprocal Rank Fusion)
SELECT
  COALESCE(s.id, k.id) AS id,
  COALESCE(s.chunk_text, k.chunk_text) AS chunk_text,
  COALESCE(s.title, k.title) AS title,
  COALESCE(s.category, k.category) AS category,
  COALESCE(s.similarity, 0) AS semantic_score,
  COALESCE(k.rank, 0) AS keyword_score,
  COALESCE(s.similarity, 0) * 0.6 + COALESCE(k.rank, 0) * 0.4 AS combined_score
FROM semantic_results s
FULL OUTER JOIN keyword_results k ON s.id = k.id
ORDER BY combined_score DESC;
```

## TODO Checklist

- [ ] Create pgvector migration
- [ ] Implement embedding service
- [ ] Add background job for document embedding
- [ ] Update searchKnowledge() for vector search
- [ ] Implement hybrid search
- [ ] Add re-ranking
- [ ] Performance testing
- [ ] Update documentation

## Estimated Effort

- Database migration: 1 day
- Embedding service: 2 days
- Search update: 2 days
- Testing: 2 days
- **Total: ~1 week**
