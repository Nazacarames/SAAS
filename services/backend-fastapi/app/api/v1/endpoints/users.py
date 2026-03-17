from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.deps import require_admin
from app.core.db import get_db
from app.schemas.users import UserCreateRequest, UserOut
from app.services.users_service import create_user, list_users

router = APIRouter(prefix="/users", tags=["users"])


@router.get("/", response_model=list[UserOut])
def users_list(
    admin_payload: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    company_id = int(admin_payload.get("companyId") or 0)
    if not company_id:
        raise HTTPException(status_code=400, detail="invalid_company")
    return list_users(db, company_id)


@router.post("/", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def users_create(
    body: UserCreateRequest,
    admin_payload: dict = Depends(require_admin),
    db: Session = Depends(get_db),
):
    company_id = int(admin_payload.get("companyId") or 0)
    if not company_id:
        raise HTTPException(status_code=400, detail="invalid_company")
    try:
        return create_user(
            db,
            name=body.name,
            email=str(body.email),
            password=body.password,
            profile=body.profile,
            company_id=company_id,
        )
    except ValueError as e:
        if str(e) == "email_already_exists":
            raise HTTPException(status_code=409, detail="Email already exists")
        raise
