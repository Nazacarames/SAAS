import { z } from "zod";

export const createUserSchema = z.object({
    name: z.string().trim().min(1, "Nombre requerido"),
    email: z.string().trim().email("Email inválido"),
    password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres"),
    profile: z.enum(["admin", "user"]).default("user")
});
