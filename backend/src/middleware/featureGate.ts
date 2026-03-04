import { Request, Response, NextFunction } from "express";
import { FeatureCode, hasFeature } from "../services/BillingServices/BillingService";

const featureGate = (feature: FeatureCode) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const companyId = Number((req as any).integrationCompanyId || (req as any).user?.companyId || req.body?.companyId || 0);
    if (!companyId) return res.status(400).json({ error: "companyId is required" });

    const allowed = await hasFeature(companyId, feature);
    if (!allowed) {
      return res.status(402).json({ error: "feature_not_in_plan", feature, upgradeRequired: true });
    }

    return next();
  };
};

export default featureGate;
