from pydantic import BaseModel


class LLMDiagnosticRequest(BaseModel):
    """Optional body for the diagnostic endpoint — allows overriding settings for the check.

    SECURITY: api_key is accepted as input only and is NEVER returned in the response,
    logged, or persisted. Use sparingly — prefer setting LLM_API_KEY in .env.
    """

    provider: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    model: str | None = None
    timeout_seconds: float | None = None


class LLMDiagnosticResponse(BaseModel):
    """Safe diagnostic result — never includes the API key."""

    provider: str
    model: str
    base_url: str
    status: str  # "ok" | "error" | "mock"
    detail: str = ""
