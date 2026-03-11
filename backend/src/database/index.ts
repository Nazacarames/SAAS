import { Sequelize } from "sequelize-typescript";
import config from "../config/database";
import path from "path";

const sequelize = new Sequelize({
    ...config,
    models: [path.join(__dirname, "..", "models")]
});

export default sequelize;
