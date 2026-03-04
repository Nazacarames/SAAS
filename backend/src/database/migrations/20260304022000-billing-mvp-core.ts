import { QueryInterface, DataTypes } from "sequelize";

module.exports = {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.createTable("billing_plans", {
      code: { type: DataTypes.STRING(30), primaryKey: true },
      name: { type: DataTypes.STRING(60), allowNull: false },
      monthly_price_usd: { type: DataTypes.DECIMAL(10,2), allowNull: false, defaultValue: 0 },
      limits_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '{}' },
      features_json: { type: DataTypes.TEXT, allowNull: false, defaultValue: '[]' },
      active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    });

    await queryInterface.createTable("company_subscriptions", {
      company_id: { type: DataTypes.INTEGER, primaryKey: true },
      plan_code: { type: DataTypes.STRING(30), allowNull: false },
      status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
      period_start: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      period_end: { type: DataTypes.DATE, allowNull: true },
      created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    });

    await queryInterface.createTable("usage_counters", {
      company_id: { type: DataTypes.INTEGER, allowNull: false },
      period_ym: { type: DataTypes.STRING(7), allowNull: false },
      metric_code: { type: DataTypes.STRING(40), allowNull: false },
      metric_value: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
      updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    });

    await queryInterface.addConstraint("usage_counters", {
      fields: ["company_id", "period_ym", "metric_code"],
      type: "primary key",
      name: "usage_counters_pkey"
    });
  },
  down: async (queryInterface: QueryInterface) => {
    await queryInterface.dropTable("usage_counters");
    await queryInterface.dropTable("company_subscriptions");
    await queryInterface.dropTable("billing_plans");
  }
};
