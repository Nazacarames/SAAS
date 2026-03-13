import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../helpers/jwt";
import AppError from "../errors/AppError";

interface AuthRequest extends Request {
    user?: {
        id: number;
        email: string;
        profile: string;
        companyId: number;
    };
}

const isAuth = (req: AuthRequest, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    let token: string | undefined;

    if (authHeader) {
        const parts = authHeader.split(" ");
        if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
            throw new AppError("Formato de token inválido", 401);
        }
        token = parts[1];
    } else if (req.cookies?.token) {
        token = req.cookies.token;
    }

    if (!token) {
        throw new AppError("Token no proporcionado", 401);
    }

    try {
        const decoded = verifyToken(token);
        req.user = decoded;
        next();
    } catch (error) {
        throw new AppError("Token inválido", 401);
    }
};

export default isAuth;
