import { Op } from "sequelize";
import { verifyRefreshToken, createAccessToken, createRefreshToken } from "../../helpers/jwt";
import RefreshToken from "../../models/RefreshToken";
import AppError from "../../errors/AppError";

interface RefreshTokenResponse {
    token: string;
    refreshToken: string;
}

const RefreshTokenService = async (oldRefreshToken: string): Promise<RefreshTokenResponse> => {
    // Verify JWT signature first
    let decoded;
    try {
        decoded = verifyRefreshToken(oldRefreshToken);
    } catch {
        throw new AppError("Token de actualización inválido", 401);
    }

    // Check token exists in database and is not revoked
    const storedToken = await RefreshToken.findOne({
        where: {
            token: oldRefreshToken,
            revoked: false,
            expiresAt: { [Op.gt]: new Date() }
        }
    });

    if (!storedToken) {
        // Possible token reuse attack — revoke all tokens for this user
        await RefreshToken.update(
            { revoked: true },
            { where: { userId: decoded.id } }
        );
        throw new AppError("Token de actualización inválido o reutilizado", 401);
    }

    // Revoke the old token (rotation)
    await storedToken.update({ revoked: true });

    const payload = {
        id: decoded.id,
        email: decoded.email,
        profile: decoded.profile,
        companyId: decoded.companyId
    };

    const newAccessToken = createAccessToken(payload);
    const newRefreshToken = createRefreshToken(payload);

    // Store new refresh token
    await RefreshToken.create({
        token: newRefreshToken,
        userId: decoded.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    } as any);

    return { token: newAccessToken, refreshToken: newRefreshToken };
};

export default RefreshTokenService;
