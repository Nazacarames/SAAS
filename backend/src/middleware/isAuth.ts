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

    if (!authHeader) {
        throw new AppError("Token no proporcionado", 401);
    }

    const parts = authHeader.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
        throw new AppError("Formato de token inválido", 401);
    }

    try {
        const decoded = verifyToken(parts[1]);
        req.user = decoded;
        next();
    } catch (error) {
        throw new AppError("Token inválido", 401);
    }
};

export default isAuth;
