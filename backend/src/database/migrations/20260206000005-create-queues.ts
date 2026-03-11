import { QueryInterface, DataTypes } from "sequelize";

export default {
    up: async (queryInterface: QueryInterface) => {
        await queryInterface.createTable("queues", {
            id: {
                type: DataTypes.INTEGER,
                autoIncrement: true,
                primaryKey: true,
                allowNull: false
            },
            name: {
                type: DataTypes.STRING,
                allowNull: false
            },
            color: {
                type: DataTypes.STRING,
                defaultValue: "#3b82f6"
            },
            greetingMessage: {
                type: DataTypes.TEXT,
                defaultValue: ""
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
        await queryInterface.dropTable("queues");
    }
};
