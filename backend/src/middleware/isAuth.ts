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

    const [, token] = authHeader.split(" ");

    try {
        const decoded = verifyToken(token);
        req.user = decoded;
        next();
    } catch (error) {
        throw new AppError("Token inválido", 401);
    }
};

export default isAuth;
