import { Request, Response, NextFunction } from "express";

const integrationAuth = (req: Request, res: Response, next: NextFunction) => {
  const key = req.header("x-api-key") || req.header("x-api-token") || "";
  const expected = process.env.INTEGRATIONS_API_KEY || "";

  if (!expected) {
    return res.status(500).json({ error: "Integrations API key not configured" });
  }

  if (key !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  return next();
};

export default integrationAuth;
