from pydantic import BaseModel


class UserCreateRequest(BaseModel):
    name: str
    email: str
    password: str
    profile: str = "user"


class UserOut(BaseModel):
    id: int
    name: str
    email: str
    profile: str
    companyId: int
