import { QueryInterface } from "sequelize";

module.exports = {
  up: async (queryInterface: QueryInterface) => {
    // Tickets indexes for common query patterns
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_tickets_company_id
      ON tickets ("companyId");
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_tickets_status
      ON tickets (status);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_tickets_contact_id
      ON tickets ("contactId");
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_tickets_company_status
      ON tickets ("companyId", status);
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_tickets_contact_status
      ON tickets ("contactId", status);
    `);

    // Messages indexes for common query patterns
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_ticket_id
      ON messages ("ticketId");
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_created_at
      ON messages ("createdAt");
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_ticket_from_me
      ON messages ("ticketId", "fromMe");
    `);

    // Composite index for conversation messages listing
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_ticket_created
      ON messages ("ticketId", "createdAt");
    `);
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_tickets_company_id;`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_tickets_status;`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_tickets_contact_id;`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_tickets_company_status;`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_tickets_contact_status;`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_messages_ticket_id;`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_messages_created_at;`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_messages_ticket_from_me;`);
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_messages_ticket_created;`);
  }
};
