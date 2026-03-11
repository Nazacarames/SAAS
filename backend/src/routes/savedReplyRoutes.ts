import { Router } from "express";
import isAuth from "../middleware/isAuth";
import SavedReply from "../models/SavedReply";
import AppError from "../errors/AppError";

const savedReplyRoutes = Router();

savedReplyRoutes.get("/", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const rows = await SavedReply.findAll({
    where: { companyId },
    order: [["updatedAt", "DESC"]]
  });
  return res.json(rows);
});

savedReplyRoutes.post("/", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { shortcut, message } = req.body;

  if (!shortcut?.trim() || !message?.trim()) {
    throw new AppError("shortcut y message son obligatorios", 400);
  }

  const row = await SavedReply.create({
    shortcut: String(shortcut).trim(),
    message: String(message).trim(),
    companyId
  });

  return res.status(201).json(row);
});

savedReplyRoutes.put("/:id", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { id } = req.params;
  const { shortcut, message } = req.body;

  const row = await SavedReply.findOne({ where: { id: parseInt(id), companyId } });
  if (!row) throw new AppError("Plantilla no encontrada", 404);

  await row.update({
    shortcut: shortcut !== undefined ? String(shortcut).trim() : row.shortcut,
    message: message !== undefined ? String(message).trim() : row.message
  });

  return res.json(row);
});

savedReplyRoutes.delete("/:id", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const { id } = req.params;

  const row = await SavedReply.findOne({ where: { id: parseInt(id), companyId } });
  if (!row) throw new AppError("Plantilla no encontrada", 404);

  await row.destroy();
  return res.status(204).send();
});

export default savedReplyRoutes;
