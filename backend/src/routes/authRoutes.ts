import { Router } from "express";
import LoginService from "../services/AuthServices/LoginService";
import RefreshTokenService from "../services/AuthServices/RefreshTokenService";

const authRoutes = Router();

authRoutes.post("/login", async (req, res) => {
    const { email, password } = req.body;

    const result = await LoginService({ email, password });

    return res.json(result);
});

authRoutes.post("/refresh", async (req, res) => {
    const { refreshToken } = req.body;

    const result = await RefreshTokenService(refreshToken);

    return res.json(result);
});

export default authRoutes;
