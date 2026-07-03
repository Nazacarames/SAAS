"""Tiny in-process TTL cache for hot, repeat-heavy reads.

Per-worker (no cross-process invalidation): keep TTLs short and call
invalidate() after writes so the writing worker is immediately fresh;
the other worker converges within one TTL. No Redis needed at this scale.
"""
import threading
import time
from typing import Any, Callable

_store: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()
_MAX_ENTRIES = 2000


def get_or_set(key: str, ttl_seconds: float, factory: Callable[[], Any]) -> Any:
    now = time.monotonic()
    with _lock:
        hit = _store.get(key)
        if hit and hit[0] > now:
            return hit[1]
    value = factory()
    with _lock:
        if len(_store) >= _MAX_ENTRIES:
            # drop expired first; if still full, drop oldest-expiring
            expired = [k for k, (exp, _) in _store.items() if exp <= now]
            for k in expired:
                _store.pop(k, None)
            while len(_store) >= _MAX_ENTRIES:
                _store.pop(min(_store, key=lambda k: _store[k][0]), None)
        _store[key] = (now + ttl_seconds, value)
    return value


def peek(key: str) -> Any | None:
    """Return cached value or None (for async callers that can't pass a factory)."""
    now = time.monotonic()
    with _lock:
        hit = _store.get(key)
        return hit[1] if hit and hit[0] > now else None


def put(key: str, ttl_seconds: float, value: Any) -> None:
    with _lock:
        _store[key] = (time.monotonic() + ttl_seconds, value)


def invalidate(prefix: str) -> None:
    """Drop every entry whose key starts with prefix."""
    with _lock:
        for k in [k for k in _store if k.startswith(prefix)]:
            _store.pop(k, None)
