import { Router } from "express";
import isAuth from "../middleware/isAuth";
import isAdmin from "../middleware/isAdmin";
import { QueryTypes } from "sequelize";
import sequelize from "../database";
import { ensureBillingTables, getCompanyPlan } from "../services/BillingServices/BillingService";

const billingRoutes = Router();

billingRoutes.get('/plans', isAuth, async (_req, res) => {
  await ensureBillingTables();
  const plans = await sequelize.query(`SELECT code, name, monthly_price_usd, limits_json, features_json, active FROM billing_plans WHERE active = true ORDER BY monthly_price_usd ASC`, { type: QueryTypes.SELECT });
  return res.json({ ok: true, plans });
});

billingRoutes.get('/current', isAuth, async (req: any, res) => {
  const companyId = Number(req.user?.companyId || 0);
  const plan = await getCompanyPlan(companyId);
  return res.json({ ok: true, plan });
});

billingRoutes.get('/usage', isAuth, async (req: any, res) => {
  await ensureBillingTables();
  const companyId = Number(req.user?.companyId || 0);
  const ym = String(req.query?.period || `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`);
  const rows = await sequelize.query(
    `SELECT metric_code, metric_value, updated_at FROM usage_counters WHERE company_id = :companyId AND period_ym = :ym ORDER BY metric_code`,
    { replacements: { companyId, ym }, type: QueryTypes.SELECT }
  );
  return res.json({ ok: true, period: ym, usage: rows });
});

billingRoutes.put('/current', isAuth, isAdmin, async (req: any, res) => {
  await ensureBillingTables();
  const companyId = Number(req.user?.companyId || 0);
  const planCode = String(req.body?.planCode || '').trim().toLowerCase();
  if (!planCode) return res.status(400).json({ error: 'planCode is required' });

  await sequelize.query(
    `INSERT INTO company_subscriptions (company_id, plan_code, status, period_start, updated_at)
     VALUES (:companyId, :planCode, 'active', NOW(), NOW())
     ON CONFLICT (company_id)
     DO UPDATE SET plan_code = EXCLUDED.plan_code, status = 'active', updated_at = NOW()`,
    { replacements: { companyId, planCode }, type: QueryTypes.INSERT }
  );

  const plan = await getCompanyPlan(companyId);
  return res.json({ ok: true, plan });
});

export default billingRoutes;
