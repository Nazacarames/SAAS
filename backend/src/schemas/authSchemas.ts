import { z } from "zod";

export const loginSchema = z.object({
    email: z.string().email("Email inválido"),
    password: z.string().min(1, "Contraseña requerida")
});

export const refreshTokenSchema = z.object({
    refreshToken: z.string().min(1, "Refresh token requerido").optional()
});

export const registerSchema = z.object({
    companyName: z.string().trim().min(1, "Nombre de empresa requerido"),
    name: z.string().trim().min(1, "Nombre requerido"),
    email: z.string().trim().email("Email inválido"),
    password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres")
});
