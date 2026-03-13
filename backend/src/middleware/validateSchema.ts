import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";

const validateSchema = (schema: ZodSchema) => {
    return (req: Request, res: Response, next: NextFunction) => {
        try {
            req.body = schema.parse(req.body);
            next();
        } catch (error) {
            if (error instanceof ZodError) {
                const messages = error.errors.map(e => `${e.path.join(".")}: ${e.message}`);
                return res.status(400).json({ error: "Datos inválidos", details: messages });
            }
            next(error);
        }
    };
};

export default validateSchema;
