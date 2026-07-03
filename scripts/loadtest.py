"""Load test: N virtual users hitting the panel's hot GET endpoints.

Usage: .venv/bin/python3 loadtest.py [users] [seconds]
Token: one shared login (login rate limit forbids 100 logins from one IP).
Read-only mix — safe against prod.
"""
import asyncio
import statistics
import sys
import time

import httpx

BASE = "http://127.0.0.1:4010"
USERS = int(sys.argv[1]) if len(sys.argv) > 1 else 100
DURATION = int(sys.argv[2]) if len(sys.argv) > 2 else 45

# (path, weight) — weights mimic panel usage: conversations poll dominates
MIX = [
    ("/api/conversations/", 4),
    ("/api/contacts/", 2),
    ("/api/ai/agents", 1),
    ("/api/channels", 1),
    ("/api/channels/health", 1),
]
PATHS = [p for p, w in MIX for _ in range(w)]

results: list[tuple[str, int, float]] = []  # (path, status, ms)
errors: dict[str, int] = {}


async def vu(client: httpx.AsyncClient, headers: dict, stop_at: float, idx: int):
    i = idx  # stagger the mix per user
    while time.monotonic() < stop_at:
        path = PATHS[i % len(PATHS)]
        i += 1
        t0 = time.monotonic()
        try:
            r = await client.get(BASE + path, headers=headers, timeout=30)
            results.append((path, r.status_code, (time.monotonic() - t0) * 1000))
        except Exception as e:
            errors[type(e).__name__] = errors.get(type(e).__name__, 0) + 1
        await asyncio.sleep(0.2)  # small think time


async def pg_monitor(stop_at: float, peaks: list):
    from app.core.db import SessionLocal
    from sqlalchemy import text as T
    while time.monotonic() < stop_at:
        try:
            db = SessionLocal()
            n = db.execute(T("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()")).scalar()
            db.close()
            peaks.append(n)
        except Exception:
            pass
        await asyncio.sleep(1)


async def main():
    async with httpx.AsyncClient() as login_client:
        r = await login_client.post(BASE + "/api/auth/login", json={"email": LOGIN_EMAIL, "password": LOGIN_PASS}, timeout=20)
        r.raise_for_status()
        token = r.json()["token"]
    headers = {"Authorization": f"Bearer {token}"}

    limits = httpx.Limits(max_connections=USERS + 10, max_keepalive_connections=USERS)
    peaks: list = []
    t_start = time.monotonic()
    stop_at = t_start + DURATION
    async with httpx.AsyncClient(limits=limits) as client:
        tasks = [vu(client, headers, stop_at, i) for i in range(USERS)]
        tasks.append(pg_monitor(stop_at, peaks))
        await asyncio.gather(*tasks)
    elapsed = time.monotonic() - t_start

    lat = sorted(ms for _, _, ms in results)
    ok = sum(1 for _, s, _ in results if s == 200)
    by_status: dict[int, int] = {}
    for _, s, _ in results:
        by_status[s] = by_status.get(s, 0) + 1

    def pct(p):
        return lat[min(len(lat) - 1, int(len(lat) * p))] if lat else 0

    print(f"users={USERS} duration={elapsed:.0f}s requests={len(results)} rps={len(results)/elapsed:.1f}")
    print(f"status: {by_status} | transport errors: {errors or 'none'}")
    print(f"latency ms: p50={pct(0.50):.0f} p95={pct(0.95):.0f} p99={pct(0.99):.0f} max={lat[-1] if lat else 0:.0f} avg={statistics.mean(lat) if lat else 0:.0f}")
    print(f"pg connections: peak={max(peaks) if peaks else '?'} avg={statistics.mean(peaks):.0f}" if peaks else "pg: no data")
    # per-path p95
    for path, _w in MIX:
        pl = sorted(ms for p, _, ms in results if p == path)
        if pl:
            print(f"  {path}: n={len(pl)} p50={pl[len(pl)//2]:.0f} p95={pl[min(len(pl)-1,int(len(pl)*0.95))]:.0f}")


if __name__ == "__main__":
    import os
    LOGIN_EMAIL = os.environ.get("LT_EMAIL", "")
    LOGIN_PASS = os.environ.get("LT_PASS", "")
    if not LOGIN_EMAIL or not LOGIN_PASS:
        print("set LT_EMAIL / LT_PASS")
        sys.exit(1)
    asyncio.run(main())
