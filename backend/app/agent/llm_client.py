import json
import logging
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Protocol
from urllib import error as urllib_error
from urllib import request

from app.core.config import settings as app_settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Exception hierarchy — each failure mode maps to a distinct, clear error.
# ---------------------------------------------------------------------------


class LLMError(RuntimeError):
    """Base for all LLM client errors."""

    def __init__(self, message: str, *, provider: str = "", detail: str = ""):
        self.provider = provider
        self.detail = detail
        super().__init__(message)


class LLMConfigurationError(LLMError, ValueError):
    """Raised when provider settings are incomplete or unsupported."""


class LLMAuthError(LLMError):
    """Raised when the API key is missing, empty, or rejected by the provider."""


class LLMTimeoutError(LLMError):
    """Raised when the LLM request exceeds the configured timeout."""


class LLMConnectionError(LLMError):
    """Raised when the LLM endpoint is unreachable (network / DNS / refused)."""


class LLMResponseError(LLMError):
    """Raised when the provider returns an unexpected HTTP status or malformed body."""


# ---------------------------------------------------------------------------
# Protocol & settings
# ---------------------------------------------------------------------------


class LLMClient(Protocol):
    def complete(self, messages: list[dict[str, str]], *, max_tokens: int | None = None) -> str:
        """Return the assistant message content."""

    def stream_complete(
        self, messages: list[dict[str, str]], *, max_tokens: int | None = None
    ) -> Iterator[str]:
        """Yield content tokens incrementally."""
        ...  # pragma: no cover


@dataclass(frozen=True)
class LLMClientSettings:
    provider: str = "mock"
    api_key: str | None = None
    base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-4o-mini"
    timeout_seconds: float = 30.0


# ---------------------------------------------------------------------------
# Mock client (offline / demo / tests)
# ---------------------------------------------------------------------------


class MockLLMClient:
    def __init__(self, responses: list[str] | None = None):
        self.responses = responses or []
        self.calls = 0

    def complete(self, messages: list[dict[str, str]], *, max_tokens: int | None = None) -> str:
        self.calls += 1
        if not self.responses:
            return "{}"
        index = min(self.calls - 1, len(self.responses) - 1)
        return self.responses[index]

    def stream_complete(self, messages: list[dict[str, str]], *, max_tokens: int | None = None) -> Iterator[str]:
        content = self.complete(messages, max_tokens=max_tokens)
        for char in content:
            yield char
            time.sleep(0.01)


# ---------------------------------------------------------------------------
# OpenAI-compatible client (real provider)
# ---------------------------------------------------------------------------


class OpenAICompatibleLLMClient:
    def __init__(self, *, api_key: str, base_url: str, model: str, timeout_seconds: float):
        if not api_key or not api_key.strip():
            raise LLMAuthError(
                "LLM API key is required for OpenAI-compatible providers but was empty",
                provider="openai-compatible",
                detail="Set LLM_API_KEY in .env or pass api_key to build_llm_client()",
            )
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout_seconds = timeout_seconds

    def complete(self, messages: list[dict[str, str]], *, max_tokens: int | None = None) -> str:
        body = json.dumps(
            {
                "model": self.model,
                "messages": messages,
                "response_format": {"type": "json_object"},
                "temperature": 0.05,
                "max_tokens": max_tokens or 1800,
            }
        ).encode("utf-8")
        req = request.Request(
            f"{self.base_url}/chat/completions",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )
        try:
            with request.urlopen(req, timeout=self.timeout_seconds) as response:
                raw_response = response.read().decode("utf-8")
                payload: dict[str, Any] = json.loads(raw_response)
        except urllib_error.HTTPError as exc:
            self._raise_http_error(exc)
        except urllib_error.URLError as exc:
            self._raise_url_error(exc)
        except TimeoutError:
            raise LLMTimeoutError(
                f"LLM request timed out after {self.timeout_seconds}s",
                provider="openai-compatible",
                detail=f"model={self.model} base_url={self.base_url}",
            )
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise LLMResponseError(
                f"LLM response was not valid JSON: {exc}",
                provider="openai-compatible",
                detail=f"model={self.model} base_url={self.base_url}",
            ) from exc

        # Validate response structure
        try:
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMResponseError(
                f"LLM response missing expected structure: {exc}",
                provider="openai-compatible",
                detail=f"response keys: {list(payload.keys()) if isinstance(payload, dict) else type(payload).__name__}",
            )
        return content

    def stream_complete(self, messages: list[dict[str, str]], *, max_tokens: int | None = None) -> Iterator[str]:
        body = json.dumps(
            {
                "model": self.model,
                "messages": messages,
                "temperature": 0.05,
                "max_tokens": max_tokens or 1800,
                "stream": True,
            }
        ).encode("utf-8")
        req = request.Request(
            f"{self.base_url}/chat/completions",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )
        try:
            with request.urlopen(req, timeout=self.timeout_seconds) as response:
                for line in response:
                    line = line.decode("utf-8").strip()
                    if not line or not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                        delta = chunk.get("choices", [{}])[0].get("delta", {})
                        content = delta.get("content")
                        if content:
                            yield content
                    except (json.JSONDecodeError, IndexError, KeyError):
                        logger.warning("Skipping malformed SSE chunk")
                        continue
        except (urllib_error.HTTPError, urllib_error.URLError, TimeoutError) as exc:
            logger.warning("Streaming failed, falling back to non-streaming: %s", exc)
            yield self.complete(messages, max_tokens=max_tokens)

    # ------------------------------------------------------------------
    # Error translation helpers
    # ------------------------------------------------------------------

    def _raise_http_error(self, exc: urllib_error.HTTPError) -> None:
        """Translate HTTP status codes into specific LLM errors."""
        status = exc.code
        if status == 401:
            raise LLMAuthError(
                "LLM API key was rejected (HTTP 401 Unauthorized)",
                provider="openai-compatible",
                detail="Verify LLM_API_KEY is correct.",
            ) from exc
        if status == 403:
            raise LLMAuthError(
                "LLM API key lacks permission (HTTP 403 Forbidden)",
                provider="openai-compatible",
                detail="Check API key scopes and provider account access.",
            ) from exc
        if status == 404:
            raise LLMConfigurationError(
                f"LLM model or endpoint not found (HTTP 404): model={self.model}",
                provider="openai-compatible",
                detail="Verify LLM_MODEL and LLM_BASE_URL.",
            ) from exc
        if status == 429:
            raise LLMError(
                "LLM rate limit exceeded (HTTP 429)",
                provider="openai-compatible",
                detail="Retry after a delay or reduce request volume.",
            ) from exc
        if status >= 500:
            raise LLMConnectionError(
                f"LLM provider server error (HTTP {status})",
                provider="openai-compatible",
                detail="Provider may be temporarily unavailable.",
            ) from exc
        raise LLMResponseError(
            f"Unexpected HTTP {status} from LLM provider",
            provider="openai-compatible",
            detail="Provider returned an unexpected HTTP status.",
        ) from exc

    def _raise_url_error(self, exc: urllib_error.URLError) -> None:
        """Translate URL errors (network / DNS) into LLMConnectionError."""
        reason = exc.reason
        if isinstance(reason, TimeoutError):
            raise LLMTimeoutError(
                f"LLM request timed out after {self.timeout_seconds}s",
                provider="openai-compatible",
                detail=f"model={self.model} base_url={self.base_url}",
            ) from exc
        raise LLMConnectionError(
            f"Cannot reach LLM endpoint: {reason}",
            provider="openai-compatible",
            detail=f"Check LLM_BASE_URL and network. base_url={self.base_url}",
        ) from exc


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def build_llm_client(settings: LLMClientSettings | None = None) -> LLMClient:
    selected = settings or LLMClientSettings(
        provider=app_settings.llm_provider,
        api_key=app_settings.llm_api_key.get_secret_value() if app_settings.llm_api_key else None,
        base_url=app_settings.llm_base_url,
        model=app_settings.llm_model,
        timeout_seconds=app_settings.llm_timeout_seconds,
    )
    provider = selected.provider.lower()
    if provider == "mock":
        return MockLLMClient()
    if provider in {"openai", "openai-compatible"}:
        if not selected.api_key:
            raise LLMAuthError(
                "LLM_API_KEY is required for OpenAI-compatible providers but was not set",
                provider=provider,
                detail="Set LLM_API_KEY in .env or pass api_key to build_llm_client()",
            )
        return OpenAICompatibleLLMClient(
            api_key=selected.api_key,
            base_url=selected.base_url,
            model=selected.model,
            timeout_seconds=selected.timeout_seconds,
        )
    raise LLMConfigurationError(
        f"Unsupported LLM provider: {selected.provider!r}",
        provider=selected.provider,
        detail="Supported providers: mock, openai, openai-compatible",
    )


def build_agent_llm_client() -> LLMClient:
    """Build the real Agent client with the Agent generation timeout.

    Diagnostics intentionally keep using LLM_TIMEOUT_SECONDS so connectivity
    checks stay fast. Agent generation gets its own longer default because
    structured planning responses are slower than a dry-run health check.
    """
    return build_llm_client(
        LLMClientSettings(
            provider=app_settings.llm_provider,
            api_key=app_settings.llm_api_key.get_secret_value() if app_settings.llm_api_key else None,
            base_url=app_settings.llm_base_url,
            model=app_settings.llm_model,
            timeout_seconds=app_settings.llm_agent_timeout_seconds,
        )
    )
