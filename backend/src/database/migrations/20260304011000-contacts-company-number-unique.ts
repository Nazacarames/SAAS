import { QueryInterface } from "sequelize";

module.exports = {
  up: async (queryInterface: QueryInterface) => {
    try { await queryInterface.removeConstraint("contacts", "contacts_number_key"); } catch (_e) {}
    try { await queryInterface.removeConstraint("contacts", "contacts_number_unique"); } catch (_e) {}
    await queryInterface.addConstraint("contacts", {
      fields: ["companyId", "number"],
      type: "unique",
      name: "contacts_company_number_unique"
    });
  },

  down: async (queryInterface: QueryInterface) => {
    try { await queryInterface.removeConstraint("contacts", "contacts_company_number_unique"); } catch (_e) {}
  }
};
