import { Router } from "express";
import { QueryTypes } from "sequelize";
import LoginService from "../services/AuthServices/LoginService";
import RefreshTokenService from "../services/AuthServices/RefreshTokenService";
import Company from "../models/Company";
import User from "../models/User";
import sequelize from "../database";
import AppError from "../errors/AppError";
import validateSchema from "../middleware/validateSchema";
import { loginSchema, refreshTokenSchema, registerSchema } from "../schemas/authSchemas";
import { rateLimitRedis } from "../services/RedisService";

const authRoutes = Router();

// Rate limit configuration
const REGISTER_MAX_PER_WINDOW = 5;
const REGISTER_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

authRoutes.post("/login", validateSchema(loginSchema), async (req, res) => {
    const { email, password } = req.body;

    const result = await LoginService({ email, password });

    const isProduction = process.env.NODE_ENV === 'production';
    const cookieOptions = {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'strict' as const : 'lax' as const,
        path: '/',
    };

    res.cookie('token', result.token, { ...cookieOptions, maxAge: 15 * 60 * 1000 });
    res.cookie('refreshToken', result.refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/api/auth/refresh' });
    return res.json({ user: result.user });
});

authRoutes.post("/refresh", validateSchema(refreshTokenSchema), async (req, res) => {
    const refreshToken = req.cookies?.refreshToken || req.body.refreshToken;

    const result = await RefreshTokenService(refreshToken);

    const isProduction = process.env.NODE_ENV === 'production';
    const cookieOptions = {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'strict' as const : 'lax' as const,
        path: '/',
    };
    res.cookie('token', result.token, { ...cookieOptions, maxAge: 15 * 60 * 1000 });
    if (result.refreshToken) {
        res.cookie('refreshToken', result.refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/api/auth/refresh' });
    }
    return res.json({ ok: true });
});

authRoutes.post("/logout", (req, res) => {
    res.clearCookie('token', { path: '/' });
    res.clearCookie('refreshToken', { path: '/api/auth/refresh' });
    return res.json({ ok: true });
});

authRoutes.post("/register", validateSchema(registerSchema), async (req, res) => {
    // Distributed rate limit check using Redis
    const ip = String(req.ip || "unknown");
    const { allowed, remaining, resetAt } = await rateLimitRedis({
        key: `register:${ip}`,
        maxRequests: REGISTER_MAX_PER_WINDOW,
        windowMs: REGISTER_WINDOW_MS,
    });

    if (!allowed) {
        res.setHeader("X-RateLimit-Remaining", "0");
        res.setHeader("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));
        return res.status(429).json({
            error: "Demasiados intentos de registro. Intente más tarde.",
            retryAfter: Math.ceil((resetAt - Date.now()) / 1000)
        });
    }

    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));

    const { companyName, name, email, password } = req.body || {};

    const safeCompanyName = String(companyName || "").trim();
    const safeName = String(name || "").trim();
    const safeEmail = String(email || "").trim().toLowerCase();
    const safePassword = String(password || "");

    if (!safeCompanyName || !safeName || !safeEmail || !safePassword) {
        throw new AppError("Faltan datos requeridos", 400);
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) {
        throw new AppError("Email inválido", 400);
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

        const isProduction = process.env.NODE_ENV === 'production';
        const cookieOptions = {
            httpOnly: true,
            secure: isProduction,
            sameSite: isProduction ? 'strict' as const : 'lax' as const,
            path: '/',
        };

        res.cookie('token', login.token, { ...cookieOptions, maxAge: 15 * 60 * 1000 });
        res.cookie('refreshToken', login.refreshToken, { ...cookieOptions, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/api/auth/refresh' });
        return res.status(201).json({
            user: login.user,
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
