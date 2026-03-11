import { Router } from "express";
import isAuth from "../middleware/isAuth";
import isAdmin from "../middleware/isAdmin";
import CreateUserService from "../services/UserServices/CreateUserService";
import ListUsersService from "../services/UserServices/ListUsersService";

const userRoutes = Router();

userRoutes.get("/", isAuth, isAdmin, async (req: any, res) => {
  const { companyId } = req.user;

  const users = await ListUsersService({ companyId });

  return res.json(users);
});

userRoutes.post("/", isAuth, isAdmin, async (req: any, res) => {
  const { companyId } = req.user;
  const { name, email, password, profile } = req.body;

  const user = await CreateUserService({
    name,
    email,
    password,
    profile,
    companyId
  });

  return res.status(201).json(user);
});

export default userRoutes;
