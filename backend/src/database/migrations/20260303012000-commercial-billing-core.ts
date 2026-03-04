import { QueryInterface, DataTypes } from "sequelize";

export default {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.createTable("plans", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      code: { type: DataTypes.STRING, allowNull: false, unique: true },
      name: { type: DataTypes.STRING, allowNull: false },
      currency: { type: DataTypes.STRING, allowNull: false, defaultValue: "USD" },
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      interval: { type: DataTypes.STRING, allowNull: false, defaultValue: "monthly" },
      trialDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false }
    });

    await queryInterface.createTable("subscriptions", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      companyId: {
        type: DataTypes.INTEGER,
        references: { model: "companies", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
        allowNull: false
      },
      planId: {
        type: DataTypes.INTEGER,
        references: { model: "plans", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
        allowNull: false
      },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: "trialing" },
      externalProvider: { type: DataTypes.STRING, allowNull: true },
      externalCustomerId: { type: DataTypes.STRING, allowNull: true },
      externalSubscriptionId: { type: DataTypes.STRING, allowNull: true },
      trialStartsAt: { type: DataTypes.DATE, allowNull: true },
      trialEndsAt: { type: DataTypes.DATE, allowNull: true },
      currentPeriodStart: { type: DataTypes.DATE, allowNull: true },
      currentPeriodEnd: { type: DataTypes.DATE, allowNull: true },
      canceledAt: { type: DataTypes.DATE, allowNull: true },
      metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false }
    });

    await queryInterface.addIndex("subscriptions", ["companyId"]);
    await queryInterface.addIndex("subscriptions", ["status"]);

    await queryInterface.createTable("payment_transactions", {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true, allowNull: false },
      companyId: {
        type: DataTypes.INTEGER,
        references: { model: "companies", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
        allowNull: false
      },
      subscriptionId: {
        type: DataTypes.INTEGER,
        references: { model: "subscriptions", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
        allowNull: true
      },
      provider: { type: DataTypes.STRING, allowNull: false, defaultValue: "skrill" },
      providerOrderId: { type: DataTypes.STRING, allowNull: true },
      providerTransactionId: { type: DataTypes.STRING, allowNull: true },
      status: { type: DataTypes.STRING, allowNull: false, defaultValue: "pending" },
      currency: { type: DataTypes.STRING, allowNull: false, defaultValue: "USD" },
      amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      rawPayload: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      createdAt: { type: DataTypes.DATE, allowNull: false },
      updatedAt: { type: DataTypes.DATE, allowNull: false }
    });

    await queryInterface.addIndex("payment_transactions", ["companyId"]);
    await queryInterface.addIndex("payment_transactions", ["provider", "providerTransactionId"]);

    await queryInterface.bulkInsert("plans", [
      {
        code: "trial_30",
        name: "Trial 30 días",
        currency: "USD",
        amount: 0,
        interval: "trial",
        trialDays: 30,
        isActive: true,
        metadata: JSON.stringify({ public: false }),
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        code: "pro_monthly",
        name: "Pro Mensual",
        currency: "USD",
        amount: 49,
        interval: "monthly",
        trialDays: 0,
        isActive: true,
        metadata: JSON.stringify({ public: true }),
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ] as any);
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.dropTable("payment_transactions");
    await queryInterface.dropTable("subscriptions");
    await queryInterface.dropTable("plans");
  }
};
