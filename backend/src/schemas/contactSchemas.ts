import { z } from "zod";

export const createContactSchema = z.object({
    name: z.string().trim().min(1, "Nombre requerido"),
    number: z.string().trim().min(1, "Número requerido"),
    email: z.string().trim().email("Email inválido").optional().or(z.literal("")),
    whatsappId: z.number().int().positive().optional().nullable(),
    source: z.string().optional(),
    leadStatus: z.string().optional(),
    assignedUserId: z.number().int().positive().optional().nullable(),
    inactivityMinutes: z.number().int().min(0).optional(),
    inactivityWebhookId: z.number().int().positive().optional().nullable(),
    tags: z.array(z.number().int().positive()).optional()
});

export const updateContactSchema = createContactSchema.partial();
