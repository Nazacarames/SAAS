from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "Charlott FastAPI"
    environment: str = "development"
    api_prefix: str = "/api"
    jwt_secret: str = "change-me"
    jwt_refresh_secret: str = "change-me-refresh"
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7
    db_host: str = "localhost"
    db_port: int = 5432
    db_user: str = "atendechat_user"
    db_pass: str = "Atendechat2026!"
    db_name: str = "atendechat"
    openai_api_key: str = ""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+psycopg://{self.db_user}:{self.db_pass}@"
            f"{self.db_host}:{self.db_port}/{self.db_name}"
        )


settings = Settings()
