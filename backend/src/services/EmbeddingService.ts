import { QueryTypes } from "sequelize";
import sequelize from "../database";

const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

interface EmbeddingResult {
  embedding: number[];
  tokens: number;
}

/**
 * Generate embedding for a single text using OpenAI API
 */
export const generateEmbedding = async (text: string): Promise<EmbeddingResult> => {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: OPENAI_EMBEDDING_MODEL,
      input: text.slice(0, 8000), // Max input length
      dimensions: EMBEDDING_DIMENSIONS
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(`OpenAI API error: ${error?.error?.message || response.statusText}`);
  }

  const data: any = await response.json();
  return {
    embedding: data.data[0].embedding,
    tokens: data.usage?.prompt_tokens || 0
  };
};

/**
 * Generate embeddings for multiple texts in batch
 */
export const generateBatchEmbeddings = async (texts: string[]): Promise<EmbeddingResult[]> => {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  // OpenAI batch limit is 2048 inputs
  const batchSize = 100;
  const results: EmbeddingResult[] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize).map(t => t.slice(0, 8000));

    try {
      const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: OPENAI_EMBEDDING_MODEL,
          input: batch,
          dimensions: EMBEDDING_DIMENSIONS
        })
      });

      if (!response.ok) {
        console.error(`[Embedding] Batch ${i / batchSize} failed:`, response.statusText);
        continue;
      }

      const data: any = await response.json();
      for (const item of data.data || []) {
        results.push({
          embedding: item.embedding,
          tokens: 0
        });
      }
    } catch (error) {
      console.error(`[Embedding] Batch ${i / batchSize} error:`, error);
    }
  }

  return results;
};

/**
 * Update a kb_chunk with its embedding
 */
export const updateChunkEmbedding = async (
  chunkId: number,
  embedding: number[]
): Promise<void> => {
  const embeddingJson = JSON.stringify(embedding);

  await sequelize.query(
    `UPDATE kb_chunks
     SET embedding = :embedding::vector,
         embedding_status = 'completed',
         embedding_updated_at = NOW()
     WHERE id = :chunkId`,
    {
      replacements: { chunkId, embedding: embeddingJson },
      type: QueryTypes.UPDATE
    }
  );
};

/**
 * Process a single document - generate embeddings for all its chunks
 */
export const embedDocument = async (documentId: number): Promise<{ success: boolean; chunks: number }> => {
  // Get all chunks for the document
  const [chunks]: any = await sequelize.query(
    `SELECT c.id, c.chunk_text
     FROM kb_chunks c
     WHERE c.document_id = :documentId
       AND (c.embedding_status IS NULL OR c.embedding_status != 'completed')`,
    {
      replacements: { documentId },
      type: QueryTypes.SELECT
    }
  );

  if (!chunks || chunks.length === 0) {
    return { success: true, chunks: 0 };
  }

  // Mark as processing
  await sequelize.query(
    `UPDATE kb_chunks SET embedding_status = 'processing' WHERE document_id = :documentId`,
    { replacements: { documentId }, type: QueryTypes.UPDATE }
  );

  // Generate embeddings
  const texts = chunks.map((c: any) => String(c.chunk_text || ""));
  const embeddings = await generateBatchEmbeddings(texts);

  // Update each chunk with its embedding
  let successCount = 0;
  for (let i = 0; i < chunks.length; i++) {
    try {
      await updateChunkEmbedding(chunks[i].id, embeddings[i]?.embedding || []);
      successCount++;
    } catch (error) {
      console.error(`[Embedding] Failed to update chunk ${chunks[i].id}:`, error);
      await sequelize.query(
        `UPDATE kb_chunks SET embedding_status = 'failed' WHERE id = :chunkId`,
        { replacements: { chunkId: chunks[i].id }, type: QueryTypes.UPDATE }
      );
    }
  }

  return { success: successCount === chunks.length, chunks: successCount };
};

/**
 * Semantic search using vector similarity
 */
export const semanticSearch = async (
  companyId: number,
  query: string,
  limit = 5
): Promise<any[]> => {
  if (!query.trim()) {
    return [];
  }

  try {
    // Generate query embedding
    const { embedding } = await generateEmbedding(query);
    const embeddingJson = JSON.stringify(embedding);

    // Search using cosine similarity
    const [results]: any = await sequelize.query(
      `SELECT c.id, c.chunk_text, d.title, d.category,
              1 - (c.embedding <=> :embedding::vector) AS similarity
       FROM kb_chunks c
       JOIN kb_documents d ON d.id = c.document_id
       WHERE d.company_id = :companyId
         AND c.embedding IS NOT NULL
         AND embedding_status = 'completed'
       ORDER BY c.embedding <=> :embedding::vector
       LIMIT :limit`,
      {
        replacements: { companyId, embedding: embeddingJson, limit },
        type: QueryTypes.SELECT
      }
    );

    return results || [];
  } catch (error) {
    console.error("[Embedding] Semantic search failed:", error);
    // Fallback to regular FTS search
    return [];
  }
};

/**
 * Hybrid search combining vector and keyword search
 */
export const hybridSearch = async (
  companyId: number,
  query: string,
  limit = 5
): Promise<any[]> => {
  if (!query.trim()) {
    return [];
  }

  try {
    const { embedding } = await generateEmbedding(query);
    const embeddingJson = JSON.stringify(embedding);

    // Hybrid search using RRF (Reciprocal Rank Fusion)
    const [results]: any = await sequelize.query(
      `WITH semantic_results AS (
         SELECT c.id, c.chunk_text, d.title, d.category,
                1 - (c.embedding <=> :embedding::vector) AS semantic_score
         FROM kb_chunks c
         JOIN kb_documents d ON d.id = c.document_id
         WHERE d.company_id = :companyId
           AND c.embedding IS NOT NULL
           AND embedding_status = 'completed'
         ORDER BY c.embedding <=> :embedding::vector
         LIMIT :limit
       ),
       keyword_results AS (
         SELECT c.id, c.chunk_text, d.title, d.category,
                ts_rank_cd(c.chunk_tsv, plainto_tsquery('spanish', :query)) AS keyword_score
         FROM kb_chunks c
         JOIN kb_documents d ON d.id = c.document_id
         WHERE d.company_id = :companyId
           AND c.chunk_tsv @@ plainto_tsquery('spaning', :query)
         ORDER BY ts_rank_cd(c.chunk_tsv, plainto_tsquery('spanish', :query)) DESC
         LIMIT :limit
       )
       SELECT
         COALESCE(s.id, k.id) AS id,
         COALESCE(s.chunk_text, k.chunk_text) AS chunk_text,
         COALESCE(s.title, k.title) AS title,
         COALESCE(s.category, k.category) AS category,
         COALESCE(s.semantic_score, 0) AS semantic_score,
         COALESCE(k.keyword_score, 0) AS keyword_score,
         COALESCE(s.semantic_score, 0) * 0.6 + COALESCE(k.keyword_score, 0) * 0.4 AS combined_score
       FROM semantic_results s
       FULL OUTER JOIN keyword_results k ON s.id = k.id
       ORDER BY combined_score DESC
       LIMIT :limit`,
      {
        replacements: { companyId, embedding: embeddingJson, query, limit },
        type: QueryTypes.SELECT
      }
    );

    return results || [];
  } catch (error) {
    console.error("[Embedding] Hybrid search failed:", error);
    return semanticSearch(companyId, query, limit);
  }
};

/**
 * Re-embed all documents for a company
 */
export const reindexCompanyKnowledgeBase = async (companyId: number): Promise<{
  documents: number;
  chunks: number;
  failed: number;
}> => {
  // Get all documents for the company
  const [documents]: any = await sequelize.query(
    `SELECT id FROM kb_documents WHERE company_id = :companyId`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );

  let totalChunks = 0;
  let failedChunks = 0;

  for (const doc of documents || []) {
    const result = await embedDocument(doc.id);
    totalChunks += result.chunks;
    if (!result.success) {
      failedChunks++;
    }
  }

  return {
    documents: documents?.length || 0,
    chunks: totalChunks,
    failed: failedChunks
  };
};
