import { QueryInterface } from "sequelize";
import bcrypt from "bcryptjs";

export default {
    up: async (queryInterface: QueryInterface) => {
        const passwordHash = await bcrypt.hash("admin123", 10);

        await queryInterface.bulkInsert("companies", [
            {
                name: "Empresa Demo",
                email: "demo@atendechat.com",
                phone: "5511999999999",
                status: true,
                createdAt: new Date(),
                updatedAt: new Date()
            }
        ]);

        await queryInterface.bulkInsert("users", [
            {
                name: "Administrador",
                email: "admin@atendechat.com",
                passwordHash,
                profile: "admin",
                companyId: 1,
                createdAt: new Date(),
                updatedAt: new Date()
            }
        ]);
    },

    down: async (queryInterface: QueryInterface) => {
        await queryInterface.bulkDelete("users", {});
        await queryInterface.bulkDelete("companies", {});
    }
};
