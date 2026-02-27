import { QueryInterface, DataTypes } from "sequelize";

export default {
    up: async (queryInterface: QueryInterface) => {
        await queryInterface.createTable("contacts", {
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
            number: {
                type: DataTypes.STRING,
                allowNull: false,
                unique: true
            },
            email: {
                type: DataTypes.STRING,
                defaultValue: ""
            },
            profilePicUrl: {
                type: DataTypes.STRING,
                defaultValue: ""
            },
            isGroup: {
                type: DataTypes.BOOLEAN,
                defaultValue: false
            },
            companyId: {
                type: DataTypes.INTEGER,
                references: { model: "companies", key: "id" },
                onUpdate: "CASCADE",
                onDelete: "CASCADE",
                allowNull: false
            },
            whatsappId: {
                type: DataTypes.INTEGER,
                references: { model: "whatsapps", key: "id" },
                onUpdate: "SET NULL",
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
        await queryInterface.dropTable("contacts");
    }
};
