import { Router } from "express";
import { QueryTypes } from "sequelize";
import isAuth from "../middleware/isAuth";
import ListTicketsService from "../services/TicketServices/ListTicketsService";
import sequelize from "../database";

const conversationRoutes = Router();

// Unified conversations endpoint (conversation + leads view)
conversationRoutes.get("/", isAuth, async (req: any, res) => {
  const companyId = req.user.companyId;
  const { status, contactId, page, limit } = req.query;
  const conversations = await ListTicketsService({
    companyId,
    status,
    contactId: contactId ? parseInt(contactId) : undefined,
    page: page ? parseInt(page) : undefined,
    limit: limit ? parseInt(limit) : undefined
  });
  return res.json(conversations);
});

// Update conversation metadata at lead/contact level
conversationRoutes.put("/:conversationId", isAuth, async (req: any, res) => {
  const companyId = req.user.companyId;
  const { conversationId } = req.params;
  const { status, userId } = req.body;

  const contactId = Number(conversationId || 0);
  if (!contactId) return res.status(400).json({ error: "conversationId inválido" });

  const [contact]: any = await sequelize.query(
    `SELECT id, "leadStatus", "assignedUserId" FROM contacts WHERE id = :contactId AND "companyId" = :companyId LIMIT 1`,
    { replacements: { contactId, companyId }, type: QueryTypes.SELECT }
  );
  if (!contact) return res.status(404).json({ error: "conversación no encontrada" });

  await sequelize.query(
    `UPDATE contacts
     SET "leadStatus" = COALESCE(:leadStatus, "leadStatus"),
         "assignedUserId" = COALESCE(:assignedUserId, "assignedUserId"),
         "updatedAt" = NOW()
     WHERE id = :contactId AND "companyId" = :companyId`,
    {
      replacements: {
        companyId,
        contactId,
        leadStatus: status ? String(status) : null,
        assignedUserId: Number(userId || 0) || null
      },
      type: QueryTypes.UPDATE
    }
  );

  const [updated]: any = await sequelize.query(
    `SELECT id, "leadStatus", "assignedUserId", "updatedAt" FROM contacts WHERE id = :contactId AND "companyId" = :companyId LIMIT 1`,
    { replacements: { contactId, companyId }, type: QueryTypes.SELECT }
  );

  return res.json({ conversationId: contactId, ...updated });
});

export default conversationRoutes;
