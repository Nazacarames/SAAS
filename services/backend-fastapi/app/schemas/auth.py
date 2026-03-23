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
    user: UserOut
    token: str


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
