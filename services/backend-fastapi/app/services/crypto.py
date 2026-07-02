"""
Application-level encryption for secrets at rest (access tokens).

Protects DB dumps / leaked backups: a read-only view of the database (or a
stolen `/var/backups` gzip) no longer exposes the raw Meta access tokens that
let one send WhatsApp messages as a client. It does NOT protect against full
server compromise (the key lives in the same .env) — that's an accepted limit.

decrypt() is deliberately TOLERANT: values that are not in our `enc:v1:` format
are returned unchanged. This lets encryption roll out with zero downtime — the
code can read legacy plaintext and freshly-encrypted values side by side, and a
one-off migration script encrypts the existing rows whenever it's run.
"""
from __future__ import annotations

import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings

log = logging.getLogger("app.crypto")

_PREFIX = "enc:v1:"
_fernet: Fernet | None = None
_loaded = False


def _get_fernet() -> Fernet | None:
    global _fernet, _loaded
    if _loaded:
        return _fernet
    _loaded = True
    key = (getattr(settings, "encryption_key", "") or "").strip()
    if not key:
        log.warning("ENCRYPTION_KEY not set — secrets stored in plaintext (passthrough mode)")
        _fernet = None
        return None
    # Accept either a real Fernet key (44-char urlsafe b64) or any passphrase
    # (derived deterministically so ops can set a human string if they prefer).
    try:
        if len(key) == 44 and key.endswith("="):
            _fernet = Fernet(key.encode())
        else:
            derived = base64.urlsafe_b64encode(hashlib.sha256(key.encode()).digest())
            _fernet = Fernet(derived)
    except Exception as e:
        log.error("Invalid ENCRYPTION_KEY (%s) — passthrough mode", str(e)[:80])
        _fernet = None
    return _fernet


def encrypt(plaintext: str | None) -> str:
    """Encrypt a secret to the `enc:v1:` format. Passthrough if no key or empty."""
    if not plaintext:
        return plaintext or ""
    if str(plaintext).startswith(_PREFIX):
        return plaintext  # already encrypted
    f = _get_fernet()
    if f is None:
        return plaintext
    return _PREFIX + f.encrypt(str(plaintext).encode()).decode()


def decrypt(value: str | None) -> str:
    """Decrypt an `enc:v1:` value. Legacy plaintext is returned unchanged."""
    if not value:
        return value or ""
    if not str(value).startswith(_PREFIX):
        return value  # legacy plaintext — tolerated
    f = _get_fernet()
    if f is None:
        # Encrypted data but no key → cannot recover; return empty so callers
        # treat it as "not configured" rather than sending a broken token.
        log.error("Encrypted value present but ENCRYPTION_KEY missing")
        return ""
    try:
        return f.decrypt(value[len(_PREFIX):].encode()).decode()
    except InvalidToken:
        log.error("Failed to decrypt value (wrong key?)")
        return ""
