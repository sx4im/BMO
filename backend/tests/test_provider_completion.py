"""Completion metadata must distinguish finished, capped, and broken answers."""
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app import groq_client, nvidia_client


@pytest.fixture(params=[groq_client, nvidia_client])
def provider(request, monkeypatch):
    adapter = request.param
    client = MagicMock()
    monkeypatch.setattr(adapter, '_client', lambda *args: client)
    return adapter, client


def chunk(content=None, finish_reason=None, usage=None):
    return SimpleNamespace(choices=[SimpleNamespace(
        delta=SimpleNamespace(content=content), finish_reason=finish_reason,
    )], usage=usage)


@pytest.mark.parametrize('reason', ['stop', 'length', 'content_filter', 'tool_calls'])
def test_done_preserves_provider_terminal_reason_and_usage_trailer(provider, reason):
    adapter, client = provider
    usage = {'prompt_tokens': 12, 'completion_tokens': 8, 'total_tokens': 20}
    client.chat.completions.create.return_value = [
        chunk('answer', reason), SimpleNamespace(choices=[], usage=usage),
    ]
    events = list(adapter.iter_response([], model='requested-model'))
    done = events[-1]
    assert done['content'] == 'answer'
    assert done['finish_reason'] == reason
    assert done['complete'] is (reason == 'stop')
    assert done['usage'] == usage


@pytest.mark.parametrize('partial', ['', 'partial code ='])
def test_eof_without_terminal_reason_never_claims_success(provider, partial):
    adapter, client = provider
    client.chat.completions.create.return_value = [chunk(partial)] if partial else []
    events = []
    with pytest.raises(RuntimeError, match='before a finish reason'):
        events.extend(adapter.iter_response([], model='requested-model'))
    assert not any(event['type'] == 'done' for event in events)
    assert ''.join(event['data'] for event in events if event['type'] == 'delta') == partial


def test_provider_usage_object_is_serializable(provider):
    adapter, client = provider
    usage = MagicMock()
    usage.model_dump.return_value = {'total_tokens': 20}
    client.chat.completions.create.return_value = [chunk('answer', 'stop', usage)]
    done = list(adapter.iter_response([], model='requested-model'))[-1]
    assert done['usage'] == {'total_tokens': 20}


def test_stream_is_closed_on_caller_cancellation(provider):
    adapter, client = provider
    stream = MagicMock()
    stream.__iter__.return_value = iter([chunk('partial'), chunk('rest', 'stop')])
    client.chat.completions.create.return_value = stream
    events = adapter.iter_response([], model='requested-model')
    next(events)  # inference
    next(events)  # first answer
    events.close()
    stream.close.assert_called_once()


@pytest.mark.parametrize('configured, expected', [(None, 16384), ('8192', 8192), ('999999', 16384), ('bad', 16384), ('0', 16384)])
def test_qwen_default_output_budget_is_explicit_and_supported(monkeypatch, configured, expected):
    client = MagicMock()
    client.chat.completions.create.return_value = [chunk('ok', 'stop')]
    monkeypatch.setattr(groq_client, '_client', lambda: client)
    if configured is None:
        monkeypatch.delenv('GROQ_MAX_TOKENS', raising=False)
    else:
        monkeypatch.setenv('GROQ_MAX_TOKENS', configured)
    list(groq_client.iter_response([], model='qwen/qwen3.8-27b'))
    assert client.chat.completions.create.call_args.kwargs['max_completion_tokens'] == expected


def test_explicit_small_completion_budget_is_preserved(monkeypatch):
    client = MagicMock()
    client.chat.completions.create.return_value = [chunk('ok', 'stop')]
    monkeypatch.setattr(groq_client, '_client', lambda: client)
    list(groq_client.iter_response([], model='qwen/qwen3.8-27b', max_tokens=24))
    assert client.chat.completions.create.call_args.kwargs['max_completion_tokens'] == 24


def test_closing_fallback_wrapper_signals_primary_worker_to_stop(monkeypatch):
    monkeypatch.setattr(nvidia_client, 'get_nexos_model', lambda: 'primary')
    monkeypatch.setattr(nvidia_client, 'get_stanza_model', lambda: 'fallback')
    stop = MagicMock()
    monkeypatch.setattr(nvidia_client.threading, 'Event', lambda: stop)
    monkeypatch.setattr(nvidia_client.threading, 'Thread', lambda **kwargs: MagicMock())
    pending = MagicMock()
    pending.get.return_value = ('data', {'type': 'delta', 'data': 'partial'})
    monkeypatch.setattr(nvidia_client.queue, 'Queue', lambda: pending)
    events = nvidia_client.iter_response_with_fallback([], model='primary')
    assert next(events) == {'type': 'delta', 'data': 'partial'}
    events.close()
    stop.set.assert_called_once()


def test_groq_preserves_usage_from_provider_specific_metadata(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr(groq_client, '_client', lambda: client)
    client.chat.completions.create.return_value = [
        chunk('answer', 'stop'),
        SimpleNamespace(choices=[], x_groq={'usage': {'total_tokens': 20}}),
    ]
    assert list(groq_client.iter_response([], model='requested-model'))[-1]['usage'] == {'total_tokens': 20}


def test_groq_provider_error_chunk_is_not_success(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr(groq_client, '_client', lambda: client)
    client.chat.completions.create.return_value = [
        chunk('partial', 'stop'), SimpleNamespace(choices=[], x_groq={'error': 'upstream disconnected'}),
    ]
    with pytest.raises(RuntimeError, match='stopped early'):
        list(groq_client.iter_response([], model='requested-model'))
