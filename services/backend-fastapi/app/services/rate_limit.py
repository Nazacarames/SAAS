"""
DB-backed rate limiter — shared across uvicorn workers and surviving restarts
(the old in-memory buckets were per-process, so with 2 workers the effective
limit was 2x and it reset on every deploy).

check_rate_limit does an atomic UPSERT: it starts a fresh window when the stored
one has expired, otherwise increments. Returns True while within the limit,
False once the request should be rejected.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import text
from sqlalchemy.orm import Session


def client_ip(request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check_rate_limit(db: Session, key: str, max_hits: int, window_seconds: int) -> bool:
    """Return True if the request is allowed, False if the limit is exceeded."""
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(seconds=window_seconds)
    try:
        row = db.execute(
            text(
                """
                INSERT INTO rate_limits (bucket_key, window_start, hit_count)
                VALUES (:k, :now, 1)
                ON CONFLICT (bucket_key) DO UPDATE SET
                    hit_count = CASE WHEN rate_limits.window_start < :cutoff THEN 1
                                     ELSE rate_limits.hit_count + 1 END,
                    window_start = CASE WHEN rate_limits.window_start < :cutoff THEN :now
                                        ELSE rate_limits.window_start END
                RETURNING hit_count
                """
            ),
            {"k": key[:160], "now": now, "cutoff": cutoff},
        ).mappings().first()
        db.commit()
        return bool(row) and row["hit_count"] <= max_hits
    except Exception:
        db.rollback()
        # Fail open on infrastructure error — never lock everyone out of auth if the
        # rate-limit table has a transient issue.
        return True
