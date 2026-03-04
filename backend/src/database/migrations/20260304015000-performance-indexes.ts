import { QueryInterface } from "sequelize";

module.exports = {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS idx_tickets_company_status_updated ON tickets ("companyId", status, "updatedAt" DESC)');
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS idx_messages_ticket_created ON messages ("ticketId", "createdAt" DESC)');
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS idx_contacts_company_status_updated ON contacts ("companyId", "leadStatus", "updatedAt" DESC)');
    await queryInterface.sequelize.query('CREATE INDEX IF NOT EXISTS idx_meta_lead_events_company_created ON meta_lead_events (company_id, created_at DESC)');
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS idx_tickets_company_status_updated');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS idx_messages_ticket_created');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS idx_contacts_company_status_updated');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS idx_meta_lead_events_company_created');
  }
};
