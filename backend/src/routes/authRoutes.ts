import { Router } from "express";
import { QueryTypes } from "sequelize";
import LoginService from "../services/AuthServices/LoginService";
import RefreshTokenService from "../services/AuthServices/RefreshTokenService";
import Company from "../models/Company";
import User from "../models/User";
import sequelize from "../database";
import AppError from "../errors/AppError";

const authRoutes = Router();

// Rate limiter for registration
const registerBuckets = new Map<string, { count: number; resetAt: number }>();
const REGISTER_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const REGISTER_MAX_PER_WINDOW = 5;

authRoutes.post("/login", async (req, res) => {
    const { email, password } = req.body;

    const result = await LoginService({ email, password });

    return res.json(result);
});

authRoutes.post("/refresh", async (req, res) => {
    const { refreshToken } = req.body;

    const result = await RefreshTokenService(refreshToken);

    return res.json(result);
});

authRoutes.post("/register", async (req, res) => {
    // Rate limit check
    const ip = String(req.ip || "unknown");
    const now = Date.now();
    const bucket = registerBuckets.get(ip);
    if (bucket && bucket.resetAt > now && bucket.count >= REGISTER_MAX_PER_WINDOW) {
        return res.status(429).json({ error: "Demasiados intentos de registro. Intente más tarde." });
    }
    if (!bucket || bucket.resetAt <= now) {
        registerBuckets.set(ip, { count: 1, resetAt: now + REGISTER_WINDOW_MS });
    } else {
        bucket.count += 1;
    }
    const { companyName, name, email, password } = req.body || {};

    const safeCompanyName = String(companyName || "").trim();
    const safeName = String(name || "").trim();
    const safeEmail = String(email || "").trim().toLowerCase();
    const safePassword = String(password || "");

    if (!safeCompanyName || !safeName || !safeEmail || !safePassword) {
        throw new AppError("Faltan datos requeridos", 400);
    }

    if (safePassword.length < 8) {
        throw new AppError("La contraseña debe tener al menos 8 caracteres", 400);
    }

    const existingUser = await User.findOne({ where: { email: safeEmail } as any });
    if (existingUser) {
        throw new AppError("El email ya está registrado", 409);
    }

    const tx = await sequelize.transaction();
    try {
        const company = await Company.create({
            name: safeCompanyName,
            email: safeEmail,
            status: true
        } as any, { transaction: tx });

        const user = await User.create({
            name: safeName,
            email: safeEmail,
            passwordHash: safePassword,
            profile: "admin",
            companyId: company.id
        } as any, { transaction: tx });

        const [trialPlan]: any = await sequelize.query(
            `SELECT id FROM plans WHERE code = 'trial_30' LIMIT 1`,
            { type: QueryTypes.SELECT, transaction: tx }
        );

        if (trialPlan?.id) {
            const now = new Date();
            const endsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
            await sequelize.query(
                `INSERT INTO subscriptions ("companyId", "planId", status, "trialStartsAt", "trialEndsAt", "currentPeriodStart", "currentPeriodEnd", metadata, "createdAt", "updatedAt")
                 VALUES (:companyId, :planId, 'trialing', :trialStartsAt, :trialEndsAt, :periodStart, :periodEnd, '{}'::jsonb, NOW(), NOW())`,
                {
                    replacements: {
                        companyId: Number(company.id),
                        planId: Number(trialPlan.id),
                        trialStartsAt: now,
                        trialEndsAt: endsAt,
                        periodStart: now,
                        periodEnd: endsAt
                    },
                    type: QueryTypes.INSERT,
                    transaction: tx
                }
            );
        }

        await tx.commit();

        const login = await LoginService({ email: safeEmail, password: safePassword });
        return res.status(201).json({
            ...login,
            onboarding: {
                trialDays: 30,
                companyId: company.id,
                userId: user.id
            }
        });
    } catch (error) {
        await tx.rollback();
        throw error;
    }
});

export default authRoutes;
