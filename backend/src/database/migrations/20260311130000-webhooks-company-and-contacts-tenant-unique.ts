import { QueryInterface, DataTypes } from "sequelize";

const WEBHOOKS_TABLE = "webhooks";
const CONTACTS_TABLE = "contacts";
const DEFAULT_COMPANY_ID = 1;

const ensureWebhooksCompanyId = async (queryInterface: QueryInterface) => {
  const table = await queryInterface.describeTable(WEBHOOKS_TABLE);

  if (!table.companyId) {
    await queryInterface.addColumn(WEBHOOKS_TABLE, "companyId", {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: DEFAULT_COMPANY_ID
    });
  }

  await queryInterface.sequelize.query(
    `UPDATE "${WEBHOOKS_TABLE}" SET "companyId" = :defaultCompanyId WHERE "companyId" IS NULL`,
    { replacements: { defaultCompanyId: DEFAULT_COMPANY_ID } }
  );

  await queryInterface.changeColumn(WEBHOOKS_TABLE, "companyId", {
    type: DataTypes.INTEGER,
    allowNull: false
  });

  await queryInterface.addConstraint(WEBHOOKS_TABLE, {
    fields: ["companyId"],
    type: "foreign key",
    name: "fk_webhooks_company_id",
    references: { table: "companies", field: "id" },
    onUpdate: "CASCADE",
    onDelete: "CASCADE"
  }).catch(() => undefined);
};

const ensureContactsTenantUnique = async (queryInterface: QueryInterface) => {
  // Remove legacy global unique constraint/index on contacts.number when present
  await queryInterface.sequelize.query(`ALTER TABLE "${CONTACTS_TABLE}" DROP CONSTRAINT IF EXISTS contacts_number_key`);
  await queryInterface.sequelize.query(`DROP INDEX IF EXISTS contacts_number_key`);

  // Guard: fail migration with clear message if data violates tenant unique rule
  const duplicates: any[] = await queryInterface.sequelize.query(
    `SELECT "companyId", "number", COUNT(*)::int AS count
     FROM "${CONTACTS_TABLE}"
     WHERE "number" IS NOT NULL
     GROUP BY "companyId", "number"
     HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC
     LIMIT 20`,
    { type: "SELECT" as any }
  );

  if (Array.isArray(duplicates) && duplicates.length > 0) {
    const sample = duplicates
      .map((d) => `companyId=${d.companyId}, number=${d.number}, count=${d.count}`)
      .join(" | ");

    throw new Error(
      `Cannot create UNIQUE(companyId, number) on contacts: duplicates found. Sample: ${sample}`
    );
  }

  await queryInterface.addConstraint(CONTACTS_TABLE, {
    fields: ["companyId", "number"],
    type: "unique",
    name: "uq_contacts_company_number"
  }).catch(() => undefined);
};

export default {
  up: async (queryInterface: QueryInterface) => {
    await ensureWebhooksCompanyId(queryInterface);
    await ensureContactsTenantUnique(queryInterface);
  },

  down: async (queryInterface: QueryInterface) => {
    await queryInterface.removeConstraint(CONTACTS_TABLE, "uq_contacts_company_number").catch(() => undefined);

    await queryInterface.removeConstraint(WEBHOOKS_TABLE, "fk_webhooks_company_id").catch(() => undefined);
    const table = await queryInterface.describeTable(WEBHOOKS_TABLE);
    if (table.companyId) {
      await queryInterface.removeColumn(WEBHOOKS_TABLE, "companyId").catch(() => undefined);
    }
  }
};
