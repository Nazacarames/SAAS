import { QueryInterface, DataTypes } from "sequelize";

export default {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.createTable("ticket_state", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      ticket_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
      intent: { type: DataTypes.STRING, allowNull: true },
      slots_json: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      missing_slots_json: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      last_tool_call_json: { type: DataTypes.JSONB, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS provider_message_id VARCHAR(255);
    `);
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_message_id_uniq
      ON messages (provider_message_id)
      WHERE provider_message_id IS NOT NULL;
    `);

    await queryInterface.createTable("integration_logs", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      company_id: { type: DataTypes.INTEGER, allowNull: true },
      ticket_id: { type: DataTypes.INTEGER, allowNull: true },
      contact_id: { type: DataTypes.INTEGER, allowNull: true },
      provider_message_id: { type: DataTypes.STRING, allowNull: true },
      direction: { type: DataTypes.STRING, allowNull: false, defaultValue: "inbound" },
      event: { type: DataTypes.STRING, allowNull: false },
      intent: { type: DataTypes.STRING, allowNull: true },
      slots_json: { type: DataTypes.JSONB, allowNull: true },
      tool_called: { type: DataTypes.STRING, allowNull: true },
      query_text: { type: DataTypes.TEXT, allowNull: true },
      result_count: { type: DataTypes.INTEGER, allowNull: true },
      decision: { type: DataTypes.STRING, allowNull: true },
      payload_json: { type: DataTypes.JSONB, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    });

    await queryInterface.sequelize.query(`
      ALTER TABLE kb_chunks
      ADD COLUMN IF NOT EXISTS chunk_tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(chunk_text, ''))) STORED;
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS kb_chunks_chunk_tsv_gin
      ON kb_chunks USING GIN (chunk_tsv);
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE kb_chunks
      ADD COLUMN IF NOT EXISTS embedding VECTOR(1536);
    `).catch(() => undefined as any);
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS kb_chunks_chunk_tsv_gin;`);
    await queryInterface.sequelize.query(`ALTER TABLE kb_chunks DROP COLUMN IF EXISTS chunk_tsv;`);
    await queryInterface.sequelize.query(`ALTER TABLE kb_chunks DROP COLUMN IF EXISTS embedding;`).catch(() => undefined as any);

    await queryInterface.dropTable("integration_logs");
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS messages_provider_message_id_uniq;`);
    await queryInterface.sequelize.query(`ALTER TABLE messages DROP COLUMN IF EXISTS provider_message_id;`);
    await queryInterface.dropTable("ticket_state");
  }
};
