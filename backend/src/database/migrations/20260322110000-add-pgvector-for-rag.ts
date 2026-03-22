import { QueryInterface } from "sequelize";

module.exports = {
  up: async (queryInterface: QueryInterface) => {
    // Enable pgvector extension (requires superuser or CREATE privilege)
    await queryInterface.sequelize.query(`
      CREATE EXTENSION IF NOT EXISTS vector;
    `);

    // Add embedding column to kb_chunks with vector size 1536 (OpenAI text-embedding-3-small)
    await queryInterface.sequelize.query(`
      ALTER TABLE kb_chunks
      ADD COLUMN IF NOT EXISTS embedding vector(1536);
    `);

    // Create HNSW index for vector similarity search
    // HNSW is faster for search with good recall
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding_hnsw
      ON kb_chunks
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
    `);

    // Add status column for tracking embedding generation
    await queryInterface.sequelize.query(`
      ALTER TABLE kb_chunks
      ADD COLUMN IF NOT EXISTS embedding_status VARCHAR(20) DEFAULT 'pending'
        CHECK (embedding_status IN ('pending', 'processing', 'completed', 'failed'));
    `);

    // Add updated_at for embedding timestamp
    await queryInterface.sequelize.query(`
      ALTER TABLE kb_chunks
      ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMP;
    `);
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_kb_chunks_embedding_hnsw;`);
    await queryInterface.sequelize.query(`ALTER TABLE kb_chunks DROP COLUMN IF EXISTS embedding;`);
    await queryInterface.sequelize.query(`ALTER TABLE kb_chunks DROP COLUMN IF EXISTS embedding_status;`);
    await queryInterface.sequelize.query(`ALTER TABLE kb_chunks DROP COLUMN IF EXISTS embedding_updated_at;`);
    // Note: We don't drop the vector extension as it might be used elsewhere
  }
};
