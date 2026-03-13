import { QueryInterface, DataTypes } from "sequelize";

module.exports = {
    up: async (queryInterface: QueryInterface) => {
        await queryInterface.createTable("refresh_tokens", {
            id: {
                type: DataTypes.INTEGER,
                autoIncrement: true,
                primaryKey: true
            },
            token: {
                type: DataTypes.TEXT,
                allowNull: false
            },
            userId: {
                type: DataTypes.INTEGER,
                allowNull: false,
                references: { model: "users", key: "id" },
                onDelete: "CASCADE"
            },
            expiresAt: {
                type: DataTypes.DATE,
                allowNull: false
            },
            revoked: {
                type: DataTypes.BOOLEAN,
                defaultValue: false
            },
            createdAt: {
                type: DataTypes.DATE,
                allowNull: false,
                defaultValue: DataTypes.NOW
            }
        });

        await queryInterface.addIndex("refresh_tokens", ["token"]);
        await queryInterface.addIndex("refresh_tokens", ["userId"]);
    },

    down: async (queryInterface: QueryInterface) => {
        await queryInterface.dropTable("refresh_tokens");
    }
};
