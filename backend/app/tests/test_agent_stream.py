from app.agent.llm_client import MockLLMClient


def test_mock_stream_complete_yields_characters():
    client = MockLLMClient(responses=["Hello"])
    tokens = list(client.stream_complete([{"role": "user", "content": "hi"}]))
    assert tokens == ["H", "e", "l", "l", "o"]


def test_mock_stream_complete_empty_response():
    client = MockLLMClient(responses=["{}"])
    tokens = list(client.stream_complete([{"role": "user", "content": "hi"}]))
    assert tokens == ["{", "}"]


def test_mock_stream_complete_multiple_calls():
    client = MockLLMClient(responses=["AB", "CD"])
    first = list(client.stream_complete([{"role": "user", "content": "a"}]))
    second = list(client.stream_complete([{"role": "user", "content": "b"}]))
    assert first == ["A", "B"]
    assert second == ["C", "D"]


def test_sse_event_format():
    from app.services.agent_conversation_service import _sse_event
    result = _sse_event("status", {"phase": "planning", "message": "test"})
    assert result == 'event: status\ndata: {"phase": "planning", "message": "test"}\n\n'
