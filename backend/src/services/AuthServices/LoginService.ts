import User from "../../models/User";
import AppError from "../../errors/AppError";
import { createAccessToken, createRefreshToken } from "../../helpers/jwt";

interface LoginRequest {
    email: string;
    password: string;
}

interface LoginResponse {
    token: string;
    refreshToken: string;
    user: {
        id: number;
        name: string;
        email: string;
        profile: string;
        companyId: number;
    };
}

const LoginService = async ({ email, password }: LoginRequest): Promise<LoginResponse> => {
    const user = await User.findOne({
        where: { email },
        attributes: ["id", "name", "email", "passwordHash", "profile", "companyId"]
    });

    if (!user) {
        throw new AppError("Credenciales inválidas", 401);
    }

    const isPasswordValid = await user.checkPassword(password);

    if (!isPasswordValid) {
        throw new AppError("Credenciales inválidas", 401);
    }

    const tokenPayload = {
        id: user.id,
        email: user.email,
        profile: user.profile,
        companyId: user.companyId
    };

    const token = createAccessToken(tokenPayload);
    const refreshToken = createRefreshToken(tokenPayload);

    return {
        token,
        refreshToken,
        user: {
            id: user.id,
            name: user.name,
            email: user.email,
            profile: user.profile,
            companyId: user.companyId
        }
    };
};

export default LoginService;
