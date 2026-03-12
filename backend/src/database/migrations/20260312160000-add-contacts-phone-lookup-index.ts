import { QueryInterface } from "sequelize";

module.exports = {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_contacts_company_last10
      ON contacts ("companyId", RIGHT(regexp_replace(COALESCE(number,''), '\\D', '', 'g'), 10))
      WHERE COALESCE("isGroup", false) = false;
    `);
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS idx_contacts_company_last10;`);
  }
};
