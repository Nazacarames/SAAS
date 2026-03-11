import { QueryInterface, DataTypes } from "sequelize";

export default {
  up: async (queryInterface: QueryInterface) => {
    await queryInterface.addColumn("contacts", "source", {
      type: DataTypes.STRING,
      allowNull: true
    });

    await queryInterface.addColumn("contacts", "leadStatus", {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "unread"
    });

    await queryInterface.addColumn("contacts", "assignedUserId", {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "users", key: "id" },
      onUpdate: "SET NULL",
      onDelete: "SET NULL"
    });

    await queryInterface.addColumn("contacts", "lastInteractionAt", {
      type: DataTypes.DATE,
      allowNull: true
    });

    await queryInterface.addColumn("contacts", "inactivityMinutes", {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 30
    });

    await queryInterface.addColumn("contacts", "inactivityWebhookId", {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: { model: "webhooks", key: "id" },
      onUpdate: "SET NULL",
      onDelete: "SET NULL"
    });

    await queryInterface.addColumn("contacts", "lastInactivityFiredAt", {
      type: DataTypes.DATE,
      allowNull: true
    });

    await queryInterface.createTable("tags", {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
      },
      color: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: "#3B82F6"
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false
      }
    });

    await queryInterface.createTable("contact_tags", {
      contactId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: "contacts", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE"
      },
      tagId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: "tags", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE"
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false
      }
    });

    await queryInterface.addConstraint("contact_tags", {
      fields: ["contactId", "tagId"],
      type: "primary key",
      name: "contact_tags_pkey"
    });
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.dropTable("contact_tags");
    await queryInterface.dropTable("tags");

    await queryInterface.removeColumn("contacts", "lastInactivityFiredAt");
    await queryInterface.removeColumn("contacts", "inactivityWebhookId");
    await queryInterface.removeColumn("contacts", "inactivityMinutes");
    await queryInterface.removeColumn("contacts", "lastInteractionAt");
    await queryInterface.removeColumn("contacts", "assignedUserId");
    await queryInterface.removeColumn("contacts", "leadStatus");
    await queryInterface.removeColumn("contacts", "source");
  }
};
