const commonDefine = {
  freezeTableName: true,
  underscored: false,
};

const cfg = {
  dialect: "postgres",
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  logging: process.env.NODE_ENV === "production" ? false : console.log,
  define: commonDefine,
};

module.exports = {
  development: cfg,
  test: cfg,
  production: cfg,
};
