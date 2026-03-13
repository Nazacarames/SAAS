import { z } from "zod";

export const createWhatsappSchema = z.object({
    name: z.string().trim().min(1, "Nombre requerido"),
    isDefault: z.boolean().optional()
});
