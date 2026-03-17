from sqlalchemy import text
from sqlalchemy.orm import Session
import bcrypt


def list_users(db: Session, company_id: int):
    rows = db.execute(
        text(
            'SELECT id, name, email, profile, "companyId" FROM users WHERE "companyId" = :company_id ORDER BY id DESC'
        ),
        {"company_id": company_id},
    ).mappings().all()
    return [dict(r) for r in rows]


def create_user(db: Session, *, name: str, email: str, password: str, profile: str, company_id: int):
    existing = db.execute(
        text('SELECT id FROM users WHERE lower(email)=lower(:email) LIMIT 1'),
        {"email": email},
    ).mappings().first()
    if existing:
        raise ValueError("email_already_exists")

    pwd = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8")
    row = db.execute(
        text(
            'INSERT INTO users (name, email, "passwordHash", profile, "companyId", "createdAt", "updatedAt") '
            'VALUES (:name, :email, :password_hash, :profile, :company_id, NOW(), NOW()) '
            'RETURNING id, name, email, profile, "companyId"'
        ),
        {
            "name": name,
            "email": email,
            "password_hash": pwd,
            "profile": profile,
            "company_id": company_id,
        },
    ).mappings().first()
    db.commit()
    return dict(row)
