from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import settings

# Pool sized for 2 uvicorn workers against Postgres max_connections=100:
# 2 x (15 + 25) = 80 peak, leaving headroom for psql/cron/backups.
engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=15,
    max_overflow=25,
    pool_timeout=10,
    pool_recycle=1800,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
