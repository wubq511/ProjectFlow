import json
from dataclasses import dataclass
from typing import Any, Protocol
from urllib import request

from app.core.config import settings as app_settings


class LLMConfigurationError(ValueError):
    """Raised when provider settings are incomplete or unsupported."""


class LLMClient(Protocol):
    def complete(self, messages: list[dict[str, str]]) -> str:
        """Return the assistant message content."""


@dataclass(frozen=True)
class LLMClientSettings:
    provider: str = "mock"
    api_key: str | None = None
    base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-4o-mini"
    timeout_seconds: float = 30.0


class MockLLMClient:
    def __init__(self, responses: list[str] | None = None):
        self.responses = responses or []
        self.calls = 0

    def complete(self, messages: list[dict[str, str]]) -> str:
        self.calls += 1
        if not self.responses:
            return "{}"
        index = min(self.calls - 1, len(self.responses) - 1)
        return self.responses[index]


class OpenAICompatibleLLMClient:
    def __init__(self, *, api_key: str, base_url: str, model: str, timeout_seconds: float):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout_seconds = timeout_seconds

    def complete(self, messages: list[dict[str, str]]) -> str:
        body = json.dumps(
            {
                "model": self.model,
                "messages": messages,
                "response_format": {"type": "json_object"},
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
        with request.urlopen(req, timeout=self.timeout_seconds) as response:
            payload: dict[str, Any] = json.loads(response.read().decode("utf-8"))
        return payload["choices"][0]["message"]["content"]


def build_llm_client(settings: LLMClientSettings | None = None) -> LLMClient:
    selected = settings or LLMClientSettings(
        provider=app_settings.llm_provider,
        api_key=app_settings.llm_api_key,
        base_url=app_settings.llm_base_url,
        model=app_settings.llm_model,
        timeout_seconds=app_settings.llm_timeout_seconds,
    )
    provider = selected.provider.lower()
    if provider == "mock":
        return MockLLMClient()
    if provider in {"openai", "openai-compatible"}:
        if not selected.api_key:
            raise LLMConfigurationError("llm_api_key is required for OpenAI-compatible providers")
        return OpenAICompatibleLLMClient(
            api_key=selected.api_key,
            base_url=selected.base_url,
            model=selected.model,
            timeout_seconds=selected.timeout_seconds,
        )
    raise LLMConfigurationError(f"Unsupported LLM provider: {selected.provider}")
