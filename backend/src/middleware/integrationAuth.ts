import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import Company from "../models/Company";

const integrationAuth = async (req: Request, res: Response, next: NextFunction) => {
  const key = String(req.header("x-api-key") || req.header("x-api-token") || "").trim();
  const companyIdRaw = String(req.header("x-company-id") || req.query.companyId || "").trim();
  const companyId = Number(companyIdRaw);

  if (!companyId || Number.isNaN(companyId)) {
    return res.status(400).json({ error: "Missing or invalid x-company-id" });
  }

  if (!key) {
    return res.status(401).json({ error: "Missing x-api-key" });
  }

  const company = await Company.findByPk(companyId);
  const expected = String((company as any)?.integrationApiKey || "").trim();

  if (!expected) {
    return res.status(403).json({ error: "Integrations API key not configured for this company" });
  }

  // Timing-safe comparison to prevent side-channel attacks
  const keyBuf = Buffer.from(key);
  const expectedBuf = Buffer.from(expected);
  if (keyBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(keyBuf, expectedBuf)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  (req as any).integrationCompanyId = companyId;
  return next();
};

export default integrationAuth;
