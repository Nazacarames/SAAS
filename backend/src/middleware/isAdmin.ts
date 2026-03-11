import { Request, Response, NextFunction } from "express";
import AppError from "../errors/AppError";

interface AuthRequest extends Request {
  user?: {
    id: number;
    email: string;
    profile: string;
    companyId: number;
  };
}

const isAdmin = (req: AuthRequest, _res: Response, next: NextFunction): void => {
  if (!req.user) {
    throw new AppError("No autenticado", 401);
  }

  if (req.user.profile !== "admin") {
    throw new AppError("Sin permisos", 403);
  }

  return next();
};

export default isAdmin;
