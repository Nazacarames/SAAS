import { QueryInterface, DataTypes } from "sequelize";

const TABLE = "tags";
const DEFAULT_COMPANY_ID = 1;

export default {
  up: async (queryInterface: QueryInterface) => {
    const table = await queryInterface.describeTable(TABLE);

    if (!table.companyId) {
      await queryInterface.addColumn(TABLE, "companyId", {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: DEFAULT_COMPANY_ID
      });
    }

    // Backfill existing tags with default company
    await queryInterface.sequelize.query(
      `UPDATE "${TABLE}" SET "companyId" = :defaultCompanyId WHERE "companyId" IS NULL`,
      { replacements: { defaultCompanyId: DEFAULT_COMPANY_ID } }
    );

    await queryInterface.changeColumn(TABLE, "companyId", {
      type: DataTypes.INTEGER,
      allowNull: false
    });

    // Add FK constraint
    await queryInterface.addConstraint(TABLE, {
      fields: ["companyId"],
      type: "foreign key",
      name: "fk_tags_company_id",
      references: { table: "companies", field: "id" },
      onUpdate: "CASCADE",
      onDelete: "CASCADE"
    }).catch(() => undefined);

    // Drop old global unique on name (if exists)
    await queryInterface.sequelize.query(
      `ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS tags_name_key`
    );
    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS tags_name_key`
    );

    // Add tenant-scoped unique constraint
    await queryInterface.addConstraint(TABLE, {
      fields: ["companyId", "name"],
      type: "unique",
      name: "uq_tags_company_name"
    }).catch(() => undefined);
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.removeConstraint(TABLE, "uq_tags_company_name").catch(() => undefined);
    await queryInterface.removeConstraint(TABLE, "fk_tags_company_id").catch(() => undefined);

    const table = await queryInterface.describeTable(TABLE);
    if (table.companyId) {
      await queryInterface.removeColumn(TABLE, "companyId").catch(() => undefined);
    }
  }
};
