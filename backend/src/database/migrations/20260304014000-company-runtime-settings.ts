import { QueryInterface, DataTypes } from "sequelize";

module.exports = {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.createTable("company_runtime_settings", {
      company_id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        allowNull: false
      },
      settings_json: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: '{}'
      },
      updated_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW
      }
    });
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.dropTable("company_runtime_settings");
  }
};
