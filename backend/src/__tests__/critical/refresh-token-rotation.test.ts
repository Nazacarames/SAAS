import AppError from "../../errors/AppError";

jest.mock("../../helpers/jwt", () => ({
  verifyRefreshToken: jest.fn(),
  createAccessToken: jest.fn(),
  createRefreshToken: jest.fn()
}));

jest.mock("../../models/RefreshToken", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    update: jest.fn(),
    create: jest.fn()
  }
}));

import RefreshTokenService from "../../services/AuthServices/RefreshTokenService";
import { verifyRefreshToken, createAccessToken, createRefreshToken } from "../../helpers/jwt";
import RefreshToken from "../../models/RefreshToken";

describe("critical/auth refresh rotation", () => {
  const decoded = { id: 7, email: "x@x.com", profile: "admin", companyId: 1 };

  it("rota refresh token y revoca el anterior", async () => {
    (verifyRefreshToken as jest.Mock).mockReturnValue(decoded);
    const update = jest.fn().mockResolvedValue(undefined);
    (RefreshToken.findOne as jest.Mock).mockResolvedValue({ update });
    (createAccessToken as jest.Mock).mockReturnValue("new-access");
    (createRefreshToken as jest.Mock).mockReturnValue("new-refresh");

    const out = await RefreshTokenService("old-refresh");

    expect(update).toHaveBeenCalledWith({ revoked: true });
    expect(RefreshToken.create).toHaveBeenCalledWith(expect.objectContaining({
      token: "new-refresh",
      userId: decoded.id
    }));
    expect(out).toEqual({ token: "new-access", refreshToken: "new-refresh" });
  });

  it("bloquea token reutilizado y revoca toda la familia", async () => {
    (verifyRefreshToken as jest.Mock).mockReturnValue(decoded);
    (RefreshToken.findOne as jest.Mock).mockResolvedValue(null);

    await expect(RefreshTokenService("reused")).rejects.toBeInstanceOf(AppError);
    expect(RefreshToken.update).toHaveBeenCalledWith({ revoked: true }, { where: { userId: decoded.id } });
  });
});
