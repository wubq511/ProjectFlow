"""Tests for LLM provider readiness and diagnostics (Issue #16).

Covers:
- Error mapping for each failure mode (missing key, timeout, HTTP errors, invalid provider, invalid response)
- Diagnostic endpoint
- API key masking (never in response)
- Mock mode still works
"""

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from app.agent.llm_client import (
    LLMAuthError,
    LLMClientSettings,
    LLMConfigurationError,
    LLMConnectionError,
    LLMError,
    LLMResponseError,
    LLMTimeoutError,
    MockLLMClient,
    OpenAICompatibleLLMClient,
    build_agent_llm_client,
    build_llm_client,
)
from app.core.config import settings as app_settings
from app.schemas.llm import LLMDiagnosticRequest, LLMDiagnosticResponse
from app.services.llm_service import run_diagnostic


# ===========================================================================
# Error hierarchy tests
# ===========================================================================


class TestLLMErrorHierarchy:
    """All specific errors inherit from LLMError for catch-all handling."""

    def test_auth_error_is_llm_error(self):
        err = LLMAuthError("bad key", provider="openai")
        assert isinstance(err, LLMError)

    def test_config_error_is_llm_error_and_value_error(self):
        err = LLMConfigurationError("bad config", provider="mock")
        assert isinstance(err, LLMError)
        assert isinstance(err, ValueError)

    def test_timeout_error_is_llm_error(self):
        err = LLMTimeoutError("timed out", provider="openai-compatible")
        assert isinstance(err, LLMError)

    def test_connection_error_is_llm_error(self):
        err = LLMConnectionError("unreachable", provider="openai-compatible")
        assert isinstance(err, LLMError)

    def test_response_error_is_llm_error(self):
        err = LLMResponseError("bad body", provider="openai-compatible")
        assert isinstance(err, LLMError)

    def test_errors_carry_provider_and_detail(self):
        err = LLMAuthError("bad key", provider="openai", detail="Check .env")
        assert err.provider == "openai"
        assert err.detail == "Check .env"


# ===========================================================================
# build_llm_client factory tests
# ===========================================================================


class TestBuildLLMClient:
    def test_mock_provider(self):
        client = build_llm_client(LLMClientSettings(provider="mock"))
        assert isinstance(client, MockLLMClient)

    def test_openai_provider_with_key(self):
        client = build_llm_client(
            LLMClientSettings(provider="openai", api_key="sk-test", base_url="https://api.openai.com/v1")
        )
        assert isinstance(client, OpenAICompatibleLLMClient)

    def test_openai_compatible_provider_with_key(self):
        client = build_llm_client(
            LLMClientSettings(provider="openai-compatible", api_key="sk-test", base_url="https://proxy.test/v1")
        )
        assert isinstance(client, OpenAICompatibleLLMClient)

    def test_missing_api_key_raises_auth_error(self):
        with pytest.raises(LLMAuthError) as exc_info:
            build_llm_client(LLMClientSettings(provider="openai", api_key=None))
        assert "LLM_API_KEY" in str(exc_info.value)

    def test_empty_api_key_raises_auth_error(self):
        with pytest.raises(LLMAuthError):
            build_llm_client(LLMClientSettings(provider="openai", api_key=""))

    def test_blank_api_key_raises_auth_error(self):
        with pytest.raises(LLMAuthError):
            build_llm_client(LLMClientSettings(provider="openai", api_key="   "))

    def test_unsupported_provider_raises_config_error(self):
        with pytest.raises(LLMConfigurationError) as exc_info:
            build_llm_client(LLMClientSettings(provider="anthropic", api_key="key"))
        assert "Unsupported" in str(exc_info.value)


# ===========================================================================
# OpenAICompatibleLLMClient error mapping tests
# ===========================================================================


class TestOpenAICompatibleClientErrors:
    """Test that HTTP/URL errors are mapped to specific LLM errors."""

    def _make_client(self) -> OpenAICompatibleLLMClient:
        return OpenAICompatibleLLMClient(
            api_key="sk-test-key",
            base_url="https://api.test/v1",
            model="test-model",
            timeout_seconds=5.0,
        )

    def _mock_httpx_response(self, status_code: int) -> MagicMock:
        mock_resp = MagicMock(spec=httpx.Response)
        mock_resp.status_code = status_code
        mock_resp.text = '{"error":"test"}'
        return mock_resp

    def test_http_401_raises_auth_error(self):
        client = self._make_client()
        mock_resp = self._mock_httpx_response(401)
        httpx_error = httpx.HTTPStatusError("401", request=MagicMock(), response=mock_resp)

        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.side_effect = httpx_error
            with pytest.raises(LLMAuthError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "401" in str(exc_info.value)

    def test_http_403_raises_auth_error(self):
        client = self._make_client()
        mock_resp = self._mock_httpx_response(403)
        httpx_error = httpx.HTTPStatusError("403", request=MagicMock(), response=mock_resp)

        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.side_effect = httpx_error
            with pytest.raises(LLMAuthError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "403" in str(exc_info.value)

    def test_http_404_raises_config_error(self):
        client = self._make_client()
        mock_resp = self._mock_httpx_response(404)
        httpx_error = httpx.HTTPStatusError("404", request=MagicMock(), response=mock_resp)

        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.side_effect = httpx_error
            with pytest.raises(LLMConfigurationError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "404" in str(exc_info.value)

    def test_http_429_raises_llm_error(self):
        client = self._make_client()
        mock_resp = self._mock_httpx_response(429)
        httpx_error = httpx.HTTPStatusError("429", request=MagicMock(), response=mock_resp)

        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.side_effect = httpx_error
            with pytest.raises(LLMError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "429" in str(exc_info.value)

    def test_http_500_raises_connection_error(self):
        client = self._make_client()
        mock_resp = self._mock_httpx_response(500)
        httpx_error = httpx.HTTPStatusError("500", request=MagicMock(), response=mock_resp)

        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.side_effect = httpx_error
            with pytest.raises(LLMConnectionError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "500" in str(exc_info.value)

    def test_connect_error_raises_connection_error(self):
        client = self._make_client()

        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.side_effect = httpx.ConnectError("Connection refused")
            with pytest.raises(LLMConnectionError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "Cannot reach" in str(exc_info.value)

    def test_timeout_error_raises_timeout_error(self):
        client = self._make_client()

        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.side_effect = httpx.TimeoutException("timed out")
            with pytest.raises(LLMTimeoutError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "timed out" in str(exc_info.value)

    def test_malformed_response_raises_response_error(self):
        client = self._make_client()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = '{"not_choices": true}'
        mock_resp.raise_for_status = MagicMock()

        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.return_value = mock_resp
            with pytest.raises(LLMResponseError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "missing expected structure" in str(exc_info.value)

    def test_non_json_provider_response_raises_response_error(self):
        client = self._make_client()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = "not json"
        mock_resp.raise_for_status = MagicMock()

        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.return_value = mock_resp
            with pytest.raises(LLMResponseError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "not valid JSON" in str(exc_info.value)

    def test_successful_response(self):
        client = self._make_client()
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = json.dumps({
            "choices": [{"message": {"content": '{"result": "ok"}'}}]
        })
        mock_resp.raise_for_status = MagicMock()

        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.return_value = mock_resp
            result = client.complete([{"role": "user", "content": "test"}])
            assert result == '{"result": "ok"}'


# ===========================================================================
# Diagnostic endpoint tests
# ===========================================================================


class TestLLMDiagnostic:
    def test_test_settings_do_not_load_real_env_key(self):
        """Pytest conftest sets LLM_API_KEY='' so real .env key is never loaded."""
        if app_settings.llm_api_key is None:
            return
        val = app_settings.llm_api_key.get_secret_value()
        assert val == "", f"LLM_API_KEY must be empty in tests, got: {val[:8] if val else 'empty'}..."

    def test_mock_provider_returns_mock_status(self):
        result = run_diagnostic()
        assert result.status == "mock"
        assert result.provider == "mock"

    def test_mock_provider_with_explicit_request(self):
        req = LLMDiagnosticRequest(provider="mock")
        result = run_diagnostic(req)
        assert result.status == "mock"

    def test_unsupported_provider_returns_error(self):
        req = LLMDiagnosticRequest(provider="unknown")
        result = run_diagnostic(req)
        assert result.status == "error"
        assert "Unsupported" in result.detail

    def test_missing_api_key_returns_error(self):
        req = LLMDiagnosticRequest(provider="openai")
        result = run_diagnostic(req)
        assert result.status == "error"
        assert "LLM_API_KEY" in result.detail

    def test_real_provider_auth_failure(self, monkeypatch):
        """Simulate a 401 from the provider."""
        monkeypatch.setattr(app_settings, "llm_api_key", SecretStr("sk-bad-key"))
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        httpx_error = httpx.HTTPStatusError("401", request=MagicMock(), response=mock_resp)

        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.side_effect = httpx_error
            req = LLMDiagnosticRequest(provider="openai")
            result = run_diagnostic(req)
            assert result.status == "error"
            assert "LLM_API_KEY" in result.detail

    def test_real_provider_timeout(self, monkeypatch):
        monkeypatch.setattr(app_settings, "llm_api_key", SecretStr("sk-test"))
        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.side_effect = httpx.TimeoutException("timed out")
            req = LLMDiagnosticRequest(provider="openai", timeout_seconds=1.0)
            result = run_diagnostic(req)
            assert result.status == "error"
            assert "Timeout" in result.detail

    def test_real_provider_connection_failure(self, monkeypatch):
        monkeypatch.setattr(app_settings, "llm_api_key", SecretStr("sk-test"))
        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.side_effect = httpx.ConnectError("Connection refused")
            req = LLMDiagnosticRequest(provider="openai")
            result = run_diagnostic(req)
            assert result.status == "error"
            assert "Connection" in result.detail

    def test_real_provider_success(self, monkeypatch):
        monkeypatch.setattr(app_settings, "llm_api_key", SecretStr("sk-test"))
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = json.dumps({
            "choices": [{"message": {"content": "ok"}}]
        })
        mock_resp.raise_for_status = MagicMock()

        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.return_value = mock_resp
            req = LLMDiagnosticRequest(provider="openai")
            result = run_diagnostic(req)
            assert result.status == "ok"
            assert result.provider == "openai"

    def test_real_provider_diagnostic_prompt_matches_json_mode(self, monkeypatch):
        monkeypatch.setattr(app_settings, "llm_api_key", SecretStr("sk-test"))
        captured = {}
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = json.dumps({
            "choices": [{"message": {"content": '{"status":"ok"}'}}]
        })
        mock_resp.raise_for_status = MagicMock()

        def fake_post(url, *, json, headers, timeout):
            captured["body"] = json
            return mock_resp

        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.side_effect = fake_post
            req = LLMDiagnosticRequest(provider="openai")
            result = run_diagnostic(req)

        assert result.status == "ok"
        # response_format is only set for non-DeepSeek providers
        # When base_url contains "deepseek", response_format is omitted
        if "deepseek" not in captured["body"].get("model", "").lower():
            assert captured["body"]["response_format"] == {"type": "json_object"}
        assert "json" in captured["body"]["messages"][0]["content"].lower()

    def test_diagnostic_request_rejects_runtime_api_key_override(self):
        with pytest.raises(ValidationError):
            LLMDiagnosticRequest.model_validate({"provider": "mock", "api_key": "sk-should-not-be-accepted"})

    def test_diagnostic_endpoint_rejects_runtime_api_key_override(self, client):
        response = client.post("/api/llm/diagnostic", json={"provider": "mock", "api_key": "sk-should-not-be-accepted"})
        assert response.status_code == 422


# ===========================================================================
# API key masking / non-leak tests
# ===========================================================================


class TestAPIKeyMasking:
    """API key values must never appear in responses, logs, or timeline snapshots."""

    def test_diagnostic_response_has_no_api_key_field(self):
        """LLMDiagnosticResponse model must not have an api_key field."""
        fields = LLMDiagnosticResponse.model_fields
        assert "api_key" not in fields, "LLMDiagnosticResponse must not expose api_key"

    def test_diagnostic_response_never_contains_key_value(self, monkeypatch):
        """Even after a real diagnostic run, the response text must not contain the key."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = json.dumps({
            "choices": [{"message": {"content": "ok"}}]
        })
        mock_resp.raise_for_status = MagicMock()

        secret_key = "sk-super-secret-key-12345"
        monkeypatch.setattr(app_settings, "llm_api_key", SecretStr(secret_key))
        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.return_value = mock_resp
            req = LLMDiagnosticRequest(provider="openai")
            result = run_diagnostic(req)
            # Serialize the response to JSON — the key must not appear
            result_json = result.model_dump_json()
            assert secret_key not in result_json, "API key leaked in diagnostic response"

    def test_provider_error_body_is_not_returned_to_frontend(self, monkeypatch):
        """Provider error bodies can be arbitrary; do not echo them into API responses."""
        secret_key = "sk-super-secret-key-12345"
        monkeypatch.setattr(app_settings, "llm_api_key", SecretStr(secret_key))
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        httpx_error = httpx.HTTPStatusError("401", request=MagicMock(), response=mock_resp)

        with patch("app.agent.llm_client._get_http_client") as mock_get:
            mock_http = MagicMock()
            mock_get.return_value = mock_http
            mock_http.post.side_effect = httpx_error
            req = LLMDiagnosticRequest(provider="openai")
            result = run_diagnostic(req)

        assert result.status == "error"
        assert secret_key not in result.model_dump_json()

    def test_error_messages_do_not_contain_key_value(self):
        """Error messages reference the setting name, not the actual key value."""
        try:
            build_llm_client(LLMClientSettings(provider="openai", api_key=None))
        except LLMAuthError as exc:
            msg = str(exc)
            assert "sk-" not in msg
            assert "LLM_API_KEY" in msg  # references the setting name, not value

    def test_llm_error_detail_does_not_contain_key(self):
        """LLMError detail strings must not contain the API key value."""
        err = LLMAuthError("key rejected", provider="openai", detail="Check LLM_API_KEY in .env")
        assert "sk-" not in err.detail
        assert "sk-" not in str(err)


# ===========================================================================
# Mock mode still works (regression guard)
# ===========================================================================


class TestMockModeRegression:
    """Ensure existing mock-mode behavior is preserved."""

    def test_mock_client_returns_empty_json(self):
        client = MockLLMClient()
        assert client.complete([]) == "{}"

    def test_mock_client_returns_preset_responses(self):
        client = MockLLMClient(responses=['{"a": 1}', '{"b": 2}'])
        assert client.complete([]) == '{"a": 1}'
        assert client.complete([]) == '{"b": 2}'
        # Subsequent calls return last response
        assert client.complete([]) == '{"b": 2}'

    def test_build_mock_client(self):
        client = build_llm_client(LLMClientSettings(provider="mock"))
        assert isinstance(client, MockLLMClient)
        assert client.complete([{"role": "user", "content": "hello"}]) == "{}"


def test_build_agent_llm_client_uses_agent_generation_timeout(monkeypatch):
    monkeypatch.setattr(app_settings, "llm_provider", "openai-compatible")
    monkeypatch.setattr(app_settings, "llm_api_key", SecretStr("sk-test"))
    monkeypatch.setattr(app_settings, "llm_base_url", "https://example.test/v1")
    monkeypatch.setattr(app_settings, "llm_model", "demo-model")
    monkeypatch.setattr(app_settings, "llm_timeout_seconds", 30.0)
    monkeypatch.setattr(app_settings, "llm_agent_timeout_seconds", 66.0)

    client = build_agent_llm_client()

    assert isinstance(client, OpenAICompatibleLLMClient)
    assert client.timeout_seconds == 66.0
