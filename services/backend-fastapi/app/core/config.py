from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Charlott FastAPI"
    environment: str = "development"
    api_prefix: str = "/api"
    jwt_secret: Optional[str] = None
    jwt_refresh_secret: Optional[str] = None
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7
    db_host: str = "localhost"
    db_port: int = 5432
    db_user: str = "atendechat_user"
    db_pass: Optional[str] = None
    db_name: str = "atendechat"
    openai_api_key: str = ""
    # WhatsApp Cloud API
    wa_cloud_phone_number_id: str = ""
    wa_cloud_access_token: str = ""
    whatsapp_webhook_verify_token: str = "atendechat"
    # Meta Webhooks
    meta_webhook_verify_token: str = ""
    meta_app_secret: str = ""
    # Tokko
    tokko_api_url: str = ""
    tokko_api_key: str = ""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+psycopg://{self.db_user}:{self.db_pass}@"
            f"{self.db_host}:{self.db_port}/{self.db_name}"
        )

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # Fail-fast in production if required secrets are not set
        if self.environment == "production":
            if self.jwt_secret is None:
                raise ValueError("JWT_SECRET must be set in production!")
            if self.jwt_refresh_secret is None:
                raise ValueError("JWT_REFRESH_SECRET must be set in production!")
            if self.db_pass is None:
                raise ValueError("DB_PASS must be set in production!")


settings = Settings()
