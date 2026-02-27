import type { Options } from "sequelize";

const commonDefine = {
  freezeTableName: true,
  underscored: false,
};

const usePostgres =
  !!process.env.DB_HOST &&
  !!process.env.DB_NAME &&
  !!process.env.DB_USER &&
  !!process.env.DB_PASS;

const config: Options = usePostgres
  ? {
      dialect: "postgres",
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      logging: process.env.NODE_ENV === "production" ? false : console.log,
      define: commonDefine,
    }
  : {
      dialect: "sqlite",
      storage: "./database.sqlite",
      logging: console.log,
      define: {
        ...commonDefine,
        // These are sqlite-friendly; Postgres ignores them anyway.
        charset: "utf8mb4",
        collate: "utf8mb4_general_ci",
      } as any,
    };

export default config;
