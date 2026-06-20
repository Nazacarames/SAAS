import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.core.config import settings

log = logging.getLogger("app.email")


def send_password_reset_email(to_email: str, user_name: str, token: str) -> bool:
    if not settings.smtp_host:
        log.warning("SMTP not configured — skipping password reset email")
        return False

    reset_url = f"{settings.frontend_url}/reset-password?token={token}"

    html = f"""
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#E8A020;margin-bottom:8px">LMTM CRM</h2>
      <p>Hola {user_name},</p>
      <p>Recibimos una solicitud para restablecer tu contraseña.</p>
      <p style="text-align:center;margin:32px 0">
        <a href="{reset_url}"
           style="background:#E8A020;color:#0C0E12;padding:12px 32px;
                  border-radius:8px;text-decoration:none;font-weight:600;
                  display:inline-block">
          Restablecer contraseña
        </a>
      </p>
      <p style="color:#888;font-size:13px">
        Este enlace expira en 1 hora. Si no solicitaste esto, ignorá este email.
      </p>
    </div>
    """

    msg = MIMEMultipart("alternative")
    msg["Subject"] = "Restablecer contraseña — LMTM CRM"
    msg["From"] = settings.smtp_from or settings.smtp_user
    msg["To"] = to_email
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as srv:
            srv.starttls()
            srv.login(settings.smtp_user, settings.smtp_pass)
            srv.sendmail(msg["From"], [to_email], msg.as_string())
        log.info("Password reset email sent to %s", to_email)
        return True
    except Exception:
        log.exception("Failed to send password reset email to %s", to_email)
        return False
