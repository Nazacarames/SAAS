import { QueryInterface, DataTypes } from "sequelize";

export default {
    up: async (queryInterface: QueryInterface) => {
        await queryInterface.createTable("tickets", {
            id: {
                type: DataTypes.INTEGER,
                autoIncrement: true,
                primaryKey: true,
                allowNull: false
            },
            status: {
                type: DataTypes.STRING,
                defaultValue: "pending"
            },
            unreadMessages: {
                type: DataTypes.INTEGER,
                defaultValue: 0
            },
            lastMessage: {
                type: DataTypes.TEXT,
                allowNull: true
            },
            isGroup: {
                type: DataTypes.BOOLEAN,
                defaultValue: false
            },
            contactId: {
                type: DataTypes.INTEGER,
                references: { model: "contacts", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
                allowNull: false
            },
            userId: {
                type: DataTypes.INTEGER,
                references: { model: "users", key: "id" },
                onUpdate: "SET NULL",
                onDelete: "SET NULL",
                allowNull: true
            },
            whatsappId: {
                type: DataTypes.INTEGER,
                references: { model: "whatsapps", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
                allowNull: false
            },
            queueId: {
                type: DataTypes.INTEGER,
                references: { model: "queues", key: "id" },
                onUpdate: "SET NULL",
                onDelete: "SET NULL",
                allowNull: true
            },
            companyId: {
                type: DataTypes.INTEGER,
                references: { model: "companies", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
                allowNull: false
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
    },

    down: async (queryInterface: QueryInterface) => {
        await queryInterface.dropTable("tickets");
    }
};
