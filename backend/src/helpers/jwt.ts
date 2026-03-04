import jwt, { SignOptions } from "jsonwebtoken";

interface TokenPayload {
    id: number;
    email: string;
    profile: string;
    companyId: number;
}

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!JWT_SECRET) {
    throw new Error("JWT_SECRET is required");
}

if (!JWT_REFRESH_SECRET) {
    throw new Error("JWT_REFRESH_SECRET is required");
}

export const createAccessToken = (payload: TokenPayload): string => {
    const expiresIn = process.env.JWT_EXPIRES_IN || "15m";
    return jwt.sign(payload, JWT_SECRET, { expiresIn } as SignOptions);
};

export const createRefreshToken = (payload: TokenPayload): string => {
    return jwt.sign(payload, JWT_REFRESH_SECRET, { expiresIn: "7d" } as SignOptions);
};

export const verifyToken = (token: string): TokenPayload => {
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
};

export const verifyRefreshToken = (token: string): TokenPayload => {
    return jwt.verify(token, JWT_REFRESH_SECRET) as TokenPayload;
};
