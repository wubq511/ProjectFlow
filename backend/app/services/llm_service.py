"""LLM provider diagnostic service — verify connectivity without exposing secrets."""

from app.agent.llm_client import (
    LLMClientSettings,
    LLMConfigurationError,
    LLMConnectionError,
    LLMError,
    LLMAuthError,
    LLMResponseError,
    LLMTimeoutError,
    MockLLMClient,
    OpenAICompatibleLLMClient,
    build_llm_client,
)
from app.core.config import settings as app_settings
from app.schemas.llm import LLMDiagnosticRequest, LLMDiagnosticResponse


def run_diagnostic(req: LLMDiagnosticRequest | None = None) -> LLMDiagnosticResponse:
    """Check LLM provider connectivity with a safe dry-run.

    For mock provider: returns status="mock" immediately.
    For real providers: sends a minimal chat completion and reports success/failure.
    API key is never included in the response.
    """
    provider = (req.provider if req and req.provider else app_settings.llm_provider).lower()
    model = req.model if req and req.model else app_settings.llm_model
    base_url = req.base_url if req and req.base_url else app_settings.llm_base_url
    api_key = req.api_key if req and req.api_key else app_settings.llm_api_key
    timeout = req.timeout_seconds if req and req.timeout_seconds else app_settings.llm_timeout_seconds

    # Mock mode — no connectivity check needed
    if provider == "mock":
        return LLMDiagnosticResponse(
            provider=provider,
            model=model,
            base_url=base_url,
            status="mock",
            detail="Mock provider does not require connectivity",
        )

    # Validate provider name
    if provider not in {"openai", "openai-compatible"}:
        return LLMDiagnosticResponse(
            provider=provider,
            model=model,
            base_url=base_url,
            status="error",
            detail=f"Unsupported provider: {provider!r}. Supported: mock, openai, openai-compatible",
        )

    # Validate API key presence
    if not api_key:
        return LLMDiagnosticResponse(
            provider=provider,
            model=model,
            base_url=base_url,
            status="error",
            detail="LLM_API_KEY is required but was not set",
        )

    # Attempt a minimal completion to verify connectivity
    try:
        client = OpenAICompatibleLLMClient(
            api_key=api_key,
            base_url=base_url,
            model=model,
            timeout_seconds=timeout,
        )
        # Send a tiny prompt to verify end-to-end connectivity
        client.complete([{"role": "user", "content": "Reply with exactly: ok"}])
        return LLMDiagnosticResponse(
            provider=provider,
            model=model,
            base_url=base_url,
            status="ok",
            detail="Provider responded successfully",
        )
    except LLMAuthError as exc:
        return LLMDiagnosticResponse(
            provider=provider, model=model, base_url=base_url, status="error", detail=exc.detail or str(exc),
        )
    except LLMTimeoutError as exc:
        return LLMDiagnosticResponse(
            provider=provider, model=model, base_url=base_url, status="error", detail=f"Timeout: {exc.detail or str(exc)}",
        )
    except LLMConnectionError as exc:
        return LLMDiagnosticResponse(
            provider=provider, model=model, base_url=base_url, status="error", detail=f"Connection failed: {exc.detail or str(exc)}",
        )
    except LLMResponseError as exc:
        return LLMDiagnosticResponse(
            provider=provider, model=model, base_url=base_url, status="error", detail=f"Bad response: {exc.detail or str(exc)}",
        )
    except LLMError as exc:
        return LLMDiagnosticResponse(
            provider=provider, model=model, base_url=base_url, status="error", detail=str(exc),
        )
