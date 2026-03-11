import { QueryInterface, DataTypes } from "sequelize";

export default {
    up: async (queryInterface: QueryInterface) => {
        await queryInterface.createTable("whatsapps", {
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
            session: {
                type: DataTypes.TEXT,
                allowNull: true
            },
            qrcode: {
                type: DataTypes.TEXT,
                allowNull: true
            },
            status: {
                type: DataTypes.STRING,
                defaultValue: "DISCONNECTED"
            },
            battery: {
                type: DataTypes.STRING,
                allowNull: true
            },
            plugged: {
                type: DataTypes.BOOLEAN,
                defaultValue: false
            },
            isDefault: {
                type: DataTypes.BOOLEAN,
                defaultValue: false
            },
            greetingMessage: {
                type: DataTypes.TEXT,
                defaultValue: ""
            },
            farewellMessage: {
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
        await queryInterface.dropTable("whatsapps");
    }
};
