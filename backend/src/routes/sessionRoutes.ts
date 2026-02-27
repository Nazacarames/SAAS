import { Router } from "express";
import isAuth from "../middleware/isAuth";

const sessionRoutes = Router();

// QR sessions disabled: only WhatsApp Cloud API is supported.
sessionRoutes.post("/:whatsappId", isAuth, async (_req, res) => {
  return res.status(410).json({
    error: "QR connections are disabled. Use WhatsApp Cloud API from Conexiones."
  });
});

export default sessionRoutes;
