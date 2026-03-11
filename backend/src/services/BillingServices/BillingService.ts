import { QueryTypes } from "sequelize";
import sequelize from "../../database";

export type FeatureCode = "integrations_api" | "ai_rag" | "meta_leads" | "advanced_reports";

let billingTablesReady = false;

export const ensureBillingTables = async () => {
  if (billingTablesReady) return;

  await sequelize.query(`CREATE TABLE IF NOT EXISTS billing_plans (
    code VARCHAR(30) PRIMARY KEY,
    name VARCHAR(60) NOT NULL,
    monthly_price_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
    limits_json TEXT NOT NULL DEFAULT '{}',
    features_json TEXT NOT NULL DEFAULT '[]',
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);

  await sequelize.query(`CREATE TABLE IF NOT EXISTS company_subscriptions (
    company_id INTEGER PRIMARY KEY,
    plan_code VARCHAR(30) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    period_start TIMESTAMP NOT NULL DEFAULT NOW(),
    period_end TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`);

  await sequelize.query(`CREATE TABLE IF NOT EXISTS usage_counters (
    company_id INTEGER NOT NULL,
    period_ym VARCHAR(7) NOT NULL,
    metric_code VARCHAR(40) NOT NULL,
    metric_value BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, period_ym, metric_code)
  )`);

  await sequelize.query(`INSERT INTO billing_plans (code, name, monthly_price_usd, limits_json, features_json)
    VALUES
      ('starter', 'Starter', 129, '{"conversations":1500,"users":2}', '["integrations_api","meta_leads"]'),
      ('pro', 'Pro', 229, '{"conversations":6000,"users":5}', '["integrations_api","meta_leads","ai_rag","advanced_reports"]'),
      ('scale', 'Scale', 399, '{"conversations":15000,"users":10}', '["integrations_api","meta_leads","ai_rag","advanced_reports"]')
    ON CONFLICT (code) DO NOTHING`);

  billingTablesReady = true;
};

export const getCompanyPlan = async (companyId: number) => {
  await ensureBillingTables();
  const [sub]: any = await sequelize.query(
    `SELECT cs.company_id, cs.plan_code, cs.status, bp.name, bp.monthly_price_usd, bp.limits_json, bp.features_json
     FROM company_subscriptions cs
     JOIN billing_plans bp ON bp.code = cs.plan_code
     WHERE cs.company_id = :companyId
     LIMIT 1`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );

  if (sub) return sub;

  await sequelize.query(
    `INSERT INTO company_subscriptions (company_id, plan_code, status)
     VALUES (:companyId, 'starter', 'active')
     ON CONFLICT (company_id) DO NOTHING`,
    { replacements: { companyId }, type: QueryTypes.INSERT }
  );

  const [fallback]: any = await sequelize.query(
    `SELECT cs.company_id, cs.plan_code, cs.status, bp.name, bp.monthly_price_usd, bp.limits_json, bp.features_json
     FROM company_subscriptions cs
     JOIN billing_plans bp ON bp.code = cs.plan_code
     WHERE cs.company_id = :companyId
     LIMIT 1`,
    { replacements: { companyId }, type: QueryTypes.SELECT }
  );

  return fallback;
};

export const hasFeature = async (companyId: number, feature: FeatureCode): Promise<boolean> => {
  const plan: any = await getCompanyPlan(companyId);
  const features = JSON.parse(String(plan?.features_json || '[]')) as string[];
  return features.includes(feature);
};

export const incrementUsage = async (companyId: number, metricCode: string, by = 1) => {
  await ensureBillingTables();
  const d = new Date();
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

  await sequelize.query(
    `INSERT INTO usage_counters (company_id, period_ym, metric_code, metric_value, updated_at)
     VALUES (:companyId, :ym, :metricCode, :by, NOW())
     ON CONFLICT (company_id, period_ym, metric_code)
     DO UPDATE SET metric_value = usage_counters.metric_value + EXCLUDED.metric_value, updated_at = NOW()`,
    { replacements: { companyId, ym, metricCode, by }, type: QueryTypes.INSERT }
  );
};
