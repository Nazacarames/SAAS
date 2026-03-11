import { QueryInterface, DataTypes } from "sequelize";

export default {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.addColumn("contacts", "business_type", { type: DataTypes.STRING, allowNull: true });
    await queryInterface.addColumn("contacts", "needs", { type: DataTypes.TEXT, allowNull: true });
    await queryInterface.addColumn("contacts", "lead_score", { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });

    await queryInterface.addColumn("tickets", "bot_enabled", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true });
    await queryInterface.addColumn("tickets", "human_override", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });

    await queryInterface.createTable("ai_agents", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      company_id: { type: DataTypes.INTEGER, allowNull: false },
      name: { type: DataTypes.STRING, allowNull: false },
      persona: { type: DataTypes.TEXT, allowNull: true },
      language: { type: DataTypes.STRING, allowNull: false, defaultValue: "es" },
      model: { type: DataTypes.STRING, allowNull: false, defaultValue: "gpt-4o-mini" },
      temperature: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0.3 },
      max_tokens: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 600 },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      welcome_msg: { type: DataTypes.TEXT, allowNull: true },
      offhours_msg: { type: DataTypes.TEXT, allowNull: true },
      farewell_msg: { type: DataTypes.TEXT, allowNull: true },
      business_hours_json: { type: DataTypes.TEXT, allowNull: true },
      funnel_stages_json: { type: DataTypes.TEXT, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false }
    });

    await queryInterface.createTable("ai_conversations", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      ticket_id: { type: DataTypes.INTEGER, allowNull: true },
      agent_id: { type: DataTypes.INTEGER, allowNull: true },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: "open" },
      bot_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      human_override: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      last_turn_at: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false }
    });

    await queryInterface.createTable("ai_turns", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      conversation_id: { type: DataTypes.INTEGER, allowNull: true },
      role: { type: DataTypes.STRING, allowNull: false },
      content: { type: DataTypes.TEXT, allowNull: false },
      model: { type: DataTypes.STRING, allowNull: true },
      latency_ms: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      tokens_in: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      tokens_out: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false }
    });

    await queryInterface.createTable("ai_tool_calls", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      turn_id: { type: DataTypes.INTEGER, allowNull: true },
      tool_name: { type: DataTypes.STRING, allowNull: false },
      args_json: { type: DataTypes.TEXT, allowNull: true },
      result_json: { type: DataTypes.TEXT, allowNull: true },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: "ok" },
      error: { type: DataTypes.TEXT, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false }
    });

    await queryInterface.createTable("kb_documents", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      company_id: { type: DataTypes.INTEGER, allowNull: false },
      title: { type: DataTypes.STRING, allowNull: false },
      category: { type: DataTypes.STRING, allowNull: false, defaultValue: "faq" },
      source_type: { type: DataTypes.STRING, allowNull: false, defaultValue: "manual" },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: "ready" },
      content: { type: DataTypes.TEXT, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false }
    });

    await queryInterface.createTable("kb_chunks", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      document_id: { type: DataTypes.INTEGER, allowNull: false },
      chunk_index: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      chunk_text: { type: DataTypes.TEXT, allowNull: false },
      token_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      embedding_json: { type: DataTypes.TEXT, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false }
    });

    await queryInterface.createTable("kb_search_logs", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      company_id: { type: DataTypes.INTEGER, allowNull: false },
      query: { type: DataTypes.TEXT, allowNull: false },
      top_k: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
      results_json: { type: DataTypes.TEXT, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false }
    });

    await queryInterface.createTable("appointments", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      company_id: { type: DataTypes.INTEGER, allowNull: false },
      contact_id: { type: DataTypes.INTEGER, allowNull: false },
      ticket_id: { type: DataTypes.INTEGER, allowNull: true },
      starts_at: { type: DataTypes.DATE, allowNull: false },
      ends_at: { type: DataTypes.DATE, allowNull: false },
      service_type: { type: DataTypes.STRING, allowNull: true },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: "scheduled" },
      notes: { type: DataTypes.TEXT, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false }
    });

    await queryInterface.createTable("appointment_events", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      appointment_id: { type: DataTypes.INTEGER, allowNull: false },
      event_type: { type: DataTypes.STRING, allowNull: false },
      reason: { type: DataTypes.TEXT, allowNull: true },
      created_by: { type: DataTypes.INTEGER, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false },
      updated_at: { type: DataTypes.DATE, allowNull: false }
    });
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.dropTable("appointment_events");
    await queryInterface.dropTable("appointments");
    await queryInterface.dropTable("kb_search_logs");
    await queryInterface.dropTable("kb_chunks");
    await queryInterface.dropTable("kb_documents");
    await queryInterface.dropTable("ai_tool_calls");
    await queryInterface.dropTable("ai_turns");
    await queryInterface.dropTable("ai_conversations");
    await queryInterface.dropTable("ai_agents");

    await queryInterface.removeColumn("tickets", "human_override");
    await queryInterface.removeColumn("tickets", "bot_enabled");
    await queryInterface.removeColumn("contacts", "lead_score");
    await queryInterface.removeColumn("contacts", "needs");
    await queryInterface.removeColumn("contacts", "business_type");
  }
};
