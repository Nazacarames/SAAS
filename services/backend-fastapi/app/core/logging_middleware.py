"""Structured JSON logging middleware with correlation-id per request."""
import json
import logging
import time
import uuid
from contextvars import ContextVar

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

# Context variable so any code in the request can access the correlation ID
correlation_id_var: ContextVar[str] = ContextVar("correlation_id", default="-")


class JSONFormatter(logging.Formatter):
    """Emit log records as single-line JSON."""

    SKIP_FIELDS = {"message", "msg", "args", "exc_info", "exc_text", "stack_info", "levelno"}

    def format(self, record: logging.LogRecord) -> str:
        entry: dict = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "cid": correlation_id_var.get("-"),
        }
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        # Forward any extra kwargs passed to logger.info(..., extra={...})
        for key, val in record.__dict__.items():
            if key not in logging.LogRecord.__dict__ and key not in self.SKIP_FIELDS and not key.startswith("_"):
                entry[key] = val
        return json.dumps(entry, ensure_ascii=False, default=str)


def setup_logging(level: str = "INFO") -> None:
    """Call once at startup to configure JSON logging for the whole app."""
    handler = logging.StreamHandler()
    handler.setFormatter(JSONFormatter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    # Quiet noisy libraries
    for lib in ("uvicorn.access", "sqlalchemy.engine", "httpcore", "httpx"):
        logging.getLogger(lib).setLevel(logging.WARNING)


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    """
    - Reads X-Correlation-Id from the incoming request (or generates a new UUID).
    - Sets the correlation_id_var context var for the lifetime of the request.
    - Adds X-Correlation-Id to the response headers.
    - Emits a structured access log line with method, path, status, and duration.
    """

    SKIP_PATHS = {"/health", "/", "/favicon.ico"}

    async def dispatch(self, request: Request, call_next):
        cid = request.headers.get("x-correlation-id") or str(uuid.uuid4())[:8]
        token = correlation_id_var.set(cid)

        logger = logging.getLogger("app.access")
        t0 = time.perf_counter()

        try:
            response = await call_next(request)
        except Exception as exc:
            ms = int((time.perf_counter() - t0) * 1000)
            if request.url.path not in self.SKIP_PATHS:
                logger.error("request_error", extra={
                    "method": request.method,
                    "path": request.url.path,
                    "ms": ms,
                    "error": str(exc),
                })
            raise
        finally:
            correlation_id_var.reset(token)

        ms = int((time.perf_counter() - t0) * 1000)
        if request.url.path not in self.SKIP_PATHS:
            logger.info("request", extra={
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "ms": ms,
            })

        response.headers["X-Correlation-Id"] = cid
        return response
