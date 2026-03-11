import { QueryInterface, DataTypes } from "sequelize";

export default {
    up: async (queryInterface: QueryInterface) => {
        await queryInterface.createTable("messages", {
            id: {
                type: DataTypes.STRING,
                primaryKey: true,
                allowNull: false
            },
            body: {
                type: DataTypes.TEXT,
                allowNull: false
            },
            ack: {
                type: DataTypes.INTEGER,
                defaultValue: 0
            },
            read: {
                type: DataTypes.BOOLEAN,
                defaultValue: false
            },
            fromMe: {
                type: DataTypes.BOOLEAN,
                defaultValue: false
            },
            mediaType: {
                type: DataTypes.STRING,
                defaultValue: "chat"
            },
            mediaUrl: {
                type: DataTypes.STRING,
                allowNull: true
            },
            ticketId: {
                type: DataTypes.INTEGER,
                references: { model: "tickets", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
                allowNull: false
            },
            contactId: {
                type: DataTypes.INTEGER,
                references: { model: "contacts", key: "id" },
                onUpdate: "SET NULL",
                onDelete: "SET NULL",
                allowNull: true
            },
            quotedMsgId: {
                type: DataTypes.STRING,
                references: { model: "messages", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "SET NULL",
                allowNull: true
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
        await queryInterface.dropTable("messages");
    }
};
