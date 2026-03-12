import { Router } from "express";
import isAuth from "../middleware/isAuth";
import ListTagsService from "../services/TagServices/ListTagsService";

const tagRoutes = Router();

tagRoutes.get("/", isAuth, async (req: any, res) => {
  const { companyId } = req.user;
  const tags = await ListTagsService(companyId);
  return res.json(tags);
});

export default tagRoutes;
