import * as Sentry from "@sentry/node";
import { Request, Response, NextFunction } from "express";
import AppError from "../errors/AppError";

interface ErrorResponse {
    error: string;
}

const errorHandler = (
    err: any,
    req: Request,
    res: Response,
    next: NextFunction
): Response<ErrorResponse> => {
    if (err instanceof AppError) {
        return res.status(err.statusCode).json({
            error: err.message
        });
    }

    // Preserve explicit HTTP status codes from body-parser/validation errors
    if (typeof err?.status === "number" && err.status >= 400 && err.status < 600) {
        return res.status(err.status).json({
            error: err.expose ? err.message : "Request error"
        });
    }

    Sentry.captureException(err);
    console.error("Internal Server Error:", err);

    return res.status(500).json({
        error: "Internal server error"
    });
};

export default errorHandler;
