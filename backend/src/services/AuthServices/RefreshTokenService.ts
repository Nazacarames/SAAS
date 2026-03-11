import { verifyRefreshToken, createAccessToken } from "../../helpers/jwt";
import AppError from "../../errors/AppError";

interface RefreshTokenResponse {
    token: string;
}

const RefreshTokenService = async (refreshToken: string): Promise<RefreshTokenResponse> => {
    try {
        const decoded = verifyRefreshToken(refreshToken);

        const newToken = createAccessToken({
            id: decoded.id,
            email: decoded.email,
            profile: decoded.profile,
            companyId: decoded.companyId
        });

        return { token: newToken };
    } catch (error) {
        throw new AppError("Token de actualización inválido", 401);
    }
};

export default RefreshTokenService;
