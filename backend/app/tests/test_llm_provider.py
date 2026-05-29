"""Tests for LLM provider readiness and diagnostics (Issue #16).

Covers:
- Error mapping for each failure mode (missing key, timeout, HTTP errors, invalid provider, invalid response)
- Diagnostic endpoint
- API key masking (never in response)
- Mock mode still works
"""

import json
from unittest.mock import MagicMock, patch
from urllib import error as urllib_error

import pytest

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
    build_llm_client,
)
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

    def test_http_401_raises_auth_error(self):
        client = self._make_client()
        mock_response = MagicMock()
        mock_response.code = 401
        mock_response.read.return_value = b'{"error":"invalid api key"}'

        with patch("app.agent.llm_client.request.urlopen", side_effect=urllib_error.HTTPError(
            url="", code=401, msg="Unauthorized", hdrs=None, fp=mock_response
        )):
            with pytest.raises(LLMAuthError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "401" in str(exc_info.value)

    def test_http_403_raises_auth_error(self):
        client = self._make_client()
        mock_response = MagicMock()
        mock_response.code = 403
        mock_response.read.return_value = b'{"error":"forbidden"}'

        with patch("app.agent.llm_client.request.urlopen", side_effect=urllib_error.HTTPError(
            url="", code=403, msg="Forbidden", hdrs=None, fp=mock_response
        )):
            with pytest.raises(LLMAuthError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "403" in str(exc_info.value)

    def test_http_404_raises_config_error(self):
        client = self._make_client()
        mock_response = MagicMock()
        mock_response.code = 404
        mock_response.read.return_value = b'{"error":"model not found"}'

        with patch("app.agent.llm_client.request.urlopen", side_effect=urllib_error.HTTPError(
            url="", code=404, msg="Not Found", hdrs=None, fp=mock_response
        )):
            with pytest.raises(LLMConfigurationError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "404" in str(exc_info.value)

    def test_http_429_raises_llm_error(self):
        client = self._make_client()
        mock_response = MagicMock()
        mock_response.code = 429
        mock_response.read.return_value = b'{"error":"rate limit"}'

        with patch("app.agent.llm_client.request.urlopen", side_effect=urllib_error.HTTPError(
            url="", code=429, msg="Too Many Requests", hdrs=None, fp=mock_response
        )):
            with pytest.raises(LLMError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "429" in str(exc_info.value)

    def test_http_500_raises_connection_error(self):
        client = self._make_client()
        mock_response = MagicMock()
        mock_response.code = 500
        mock_response.read.return_value = b'{"error":"internal server error"}'

        with patch("app.agent.llm_client.request.urlopen", side_effect=urllib_error.HTTPError(
            url="", code=500, msg="Internal Server Error", hdrs=None, fp=mock_response
        )):
            with pytest.raises(LLMConnectionError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "500" in str(exc_info.value)

    def test_url_error_raises_connection_error(self):
        client = self._make_client()
        with patch("app.agent.llm_client.request.urlopen", side_effect=urllib_error.URLError(
            reason="Connection refused"
        )):
            with pytest.raises(LLMConnectionError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "Cannot reach" in str(exc_info.value)

    def test_timeout_error_raises_timeout_error(self):
        client = self._make_client()
        with patch("app.agent.llm_client.request.urlopen", side_effect=TimeoutError()):
            with pytest.raises(LLMTimeoutError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "timed out" in str(exc_info.value)

    def test_url_timeout_raises_timeout_error(self):
        client = self._make_client()
        with patch("app.agent.llm_client.request.urlopen", side_effect=urllib_error.URLError(
            reason=TimeoutError()
        )):
            with pytest.raises(LLMTimeoutError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "timed out" in str(exc_info.value)

    def test_malformed_response_raises_response_error(self):
        client = self._make_client()
        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_response.read.return_value = b'{"not_choices": true}'

        with patch("app.agent.llm_client.request.urlopen", return_value=mock_response):
            with pytest.raises(LLMResponseError) as exc_info:
                client.complete([{"role": "user", "content": "test"}])
            assert "missing expected structure" in str(exc_info.value)

    def test_successful_response(self):
        client = self._make_client()
        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_response.read.return_value = json.dumps({
            "choices": [{"message": {"content": '{"result": "ok"}'}}]
        }).encode("utf-8")

        with patch("app.agent.llm_client.request.urlopen", return_value=mock_response):
            result = client.complete([{"role": "user", "content": "test"}])
            assert result == '{"result": "ok"}'


# ===========================================================================
# Diagnostic endpoint tests
# ===========================================================================


class TestLLMDiagnostic:
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
        req = LLMDiagnosticRequest(provider="openai", api_key=None)
        result = run_diagnostic(req)
        assert result.status == "error"
        assert "LLM_API_KEY" in result.detail

    def test_real_provider_auth_failure(self):
        """Simulate a 401 from the provider."""
        mock_response = MagicMock()
        mock_response.code = 401
        mock_response.read.return_value = b'{"error":"unauthorized"}'

        with patch("app.agent.llm_client.request.urlopen", side_effect=urllib_error.HTTPError(
            url="", code=401, msg="Unauthorized", hdrs=None, fp=mock_response
        )):
            req = LLMDiagnosticRequest(provider="openai", api_key="sk-bad-key")
            result = run_diagnostic(req)
            assert result.status == "error"
            assert "LLM_API_KEY" in result.detail

    def test_real_provider_timeout(self):
        with patch("app.agent.llm_client.request.urlopen", side_effect=TimeoutError()):
            req = LLMDiagnosticRequest(provider="openai", api_key="sk-test", timeout_seconds=1.0)
            result = run_diagnostic(req)
            assert result.status == "error"
            assert "Timeout" in result.detail

    def test_real_provider_connection_failure(self):
        with patch("app.agent.llm_client.request.urlopen", side_effect=urllib_error.URLError(
            reason="Connection refused"
        )):
            req = LLMDiagnosticRequest(provider="openai", api_key="sk-test")
            result = run_diagnostic(req)
            assert result.status == "error"
            assert "Connection" in result.detail

    def test_real_provider_success(self):
        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_response.read.return_value = json.dumps({
            "choices": [{"message": {"content": "ok"}}]
        }).encode("utf-8")

        with patch("app.agent.llm_client.request.urlopen", return_value=mock_response):
            req = LLMDiagnosticRequest(provider="openai", api_key="sk-test")
            result = run_diagnostic(req)
            assert result.status == "ok"
            assert result.provider == "openai"


# ===========================================================================
# API key masking / non-leak tests
# ===========================================================================


class TestAPIKeyMasking:
    """API key values must never appear in responses, logs, or timeline snapshots."""

    def test_diagnostic_response_has_no_api_key_field(self):
        """LLMDiagnosticResponse model must not have an api_key field."""
        fields = LLMDiagnosticResponse.model_fields
        assert "api_key" not in fields, "LLMDiagnosticResponse must not expose api_key"

    def test_diagnostic_response_never_contains_key_value(self):
        """Even after a real diagnostic run, the response text must not contain the key."""
        mock_response = MagicMock()
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)
        mock_response.read.return_value = json.dumps({
            "choices": [{"message": {"content": "ok"}}]
        }).encode("utf-8")

        secret_key = "sk-super-secret-key-12345"
        with patch("app.agent.llm_client.request.urlopen", return_value=mock_response):
            req = LLMDiagnosticRequest(provider="openai", api_key=secret_key)
            result = run_diagnostic(req)
            # Serialize the response to JSON — the key must not appear
            result_json = result.model_dump_json()
            assert secret_key not in result_json, "API key leaked in diagnostic response"

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
