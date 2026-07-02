from pydantic import BaseModel, EmailStr


class UserOut(BaseModel):
    id: int
    name: str
    email: str
    profile: str
    companyId: int


class MeResponse(BaseModel):
    user: UserOut


class LoginRequest(BaseModel):
    email: str
    password: str


class LoginResponse(BaseModel):
    # When 2FA is enabled, user/token are omitted and requires_2fa + mfa_token are returned;
    # the client then calls /auth/2fa/verify with the TOTP code to obtain the session token.
    user: UserOut | None = None
    token: str | None = None
    requires_2fa: bool = False
    mfa_token: str | None = None


class TwoFactorVerifyRequest(BaseModel):
    mfa_token: str
    code: str


class TwoFactorCodeRequest(BaseModel):
    code: str


class TwoFactorSetupResponse(BaseModel):
    ok: bool = True
    otpauth_uri: str
    secret: str


class TwoFactorStatusResponse(BaseModel):
    enabled: bool


class RefreshRequest(BaseModel):
    refreshToken: str | None = None


class RefreshResponse(BaseModel):
    ok: bool = True
    token: str


class LogoutResponse(BaseModel):
    ok: bool = True


class RegisterRequest(BaseModel):
    name: str
    email: str
    password: str
    companyName: str


class RegisterResponse(BaseModel):
    ok: bool = True
    user: UserOut
    token: str


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    password: str


class GenericOkResponse(BaseModel):
    ok: bool = True
