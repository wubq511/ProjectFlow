from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    service: str
    app_env: str | None = None
    evaluation_nonce: str | None = None
