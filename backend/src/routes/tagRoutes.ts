import { Router } from "express";
import isAuth from "../middleware/isAuth";
import ListTagsService from "../services/TagServices/ListTagsService";

const tagRoutes = Router();

tagRoutes.get("/", isAuth, async (req, res) => {
  const tags = await ListTagsService();
  return res.json(tags);
});

export default tagRoutes;
