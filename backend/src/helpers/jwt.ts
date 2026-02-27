import jwt, { SignOptions } from "jsonwebtoken";

interface TokenPayload {
    id: number;
    email: string;
    profile: string;
    companyId: number;
}

export const createAccessToken = (payload: TokenPayload): string => {
    const secret = process.env.JWT_SECRET || "default-secret-change-me";
    const expiresIn = process.env.JWT_EXPIRES_IN || "15m";
    return jwt.sign(payload, secret, { expiresIn } as SignOptions);
};

export const createRefreshToken = (payload: TokenPayload): string => {
    const secret = process.env.JWT_REFRESH_SECRET || "default-refresh-secret-change-me";
    return jwt.sign(payload, secret, { expiresIn: "7d" } as SignOptions);
};

export const verifyToken = (token: string): TokenPayload => {
    const secret = process.env.JWT_SECRET || "default-secret-change-me";
    return jwt.verify(token, secret) as TokenPayload;
};

export const verifyRefreshToken = (token: string): TokenPayload => {
    const secret = process.env.JWT_REFRESH_SECRET || "default-refresh-secret-change-me";
    return jwt.verify(token, secret) as TokenPayload;
};
