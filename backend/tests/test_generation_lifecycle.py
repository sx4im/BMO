"""End-to-end generation outcomes must agree with provider completion and storage."""
import subprocess
from types import SimpleNamespace

import pytest

from app import nvidia_client
from app.routes import chat_routes
from tests.test_chat_persistence import events
from tests.test_regressions import db, gateway, headers


@pytest.fixture(autouse=True)
def no_external_calls(monkeypatch):
    monkeypatch.setattr(chat_routes, "get_usage_status", lambda _: {"blocked": False})
    monkeypatch.setattr(nvidia_client, "generate_title", lambda *a: None)


def send(gateway, headers):
    return list(events(gateway.post('/chat', headers=headers, json={
        'message': 'Build a complete calculator.', 'model': 'thinking', 'auto_search': False,
    })))


def test_output_limit_continues_remaining_code_and_saves_one_complete_answer(gateway, headers, db, monkeypatch):
    first = '```html\n<!doctype html><html><body><script>\nfunction add(a,b){return a'
    rest = '+b;}window.answer=add(2,3);\n</script></body></html>\n```'
    calls = []
    def stream(messages, **options):
        calls.append((messages, options))
        text, reason = (first, 'length') if len(calls) == 1 else (rest, 'stop')
        yield {'type': 'delta', 'data': text}
        yield {'type': 'done', 'content': text, 'finish_reason': reason, 'complete': reason == 'stop'}
    monkeypatch.setattr(nvidia_client, 'iter_response_with_fallback', stream)
    received = send(gateway, headers)
    text = ''.join(e['data']['delta'] for e in received if e['type'] == 'token')
    assert text == first + rest
    assert len(calls) == 2
    assert calls[1][0][-2]['role'] == 'assistant'
    assert calls[1][0][-2]['content'] == first
    assert [e['type'] for e in received].count('complete') == 1
    saved = next(e['data'] for e in received if e['type'] == 'assistant_message')
    assert saved['content'] == text
    assert len([m for m in db.rows['messages'] if m['role'] == 'assistant']) == 1
    script = text.split('<script>', 1)[1].split('</script>', 1)[0]
    subprocess.run(['node', '-e', 'const window={};\n' + script + '\nif(window.answer!==5)process.exit(1);'], check=True, capture_output=True)


def test_continuation_exhaustion_keeps_partial_but_never_claims_complete(gateway, headers, db, monkeypatch):
    calls = []
    def stream(*args, **options):
        calls.append(True)
        yield {'type': 'delta', 'data': 'unfinished\n'}
        yield {'type': 'done', 'content': 'unfinished\n', 'finish_reason': 'length', 'complete': False}
    monkeypatch.setattr(nvidia_client, 'iter_response_with_fallback', stream)
    received = send(gateway, headers)
    assert len(calls) == 3
    assert not any(e['type'] == 'complete' for e in received)
    error = next(e for e in received if e['type'] == 'error')
    assert error['code'] == 'output_limit'
    saved = next(e['data'] for e in received if e['type'] == 'assistant_message')
    assert saved['content'] == 'unfinished\n' * 3
    assert saved['generation_status'] == 'incomplete'


def test_provider_rate_limit_is_an_error_not_a_successful_busy_answer(gateway, headers, db, monkeypatch):
    class Limited(RuntimeError):
        status_code = 429
        response = SimpleNamespace(headers={'retry-after': '0'})
    calls = []
    def stream(*args, **options):
        calls.append(True)
        raise Limited('rate limit exceeded')
        yield
    monkeypatch.setattr(nvidia_client, 'iter_response_with_fallback', stream)
    received = send(gateway, headers)
    assert len(calls) == 3
    assert not any(e['type'] in ('token', 'complete', 'assistant_message') for e in received)
    error = next(e for e in received if e['type'] == 'error')
    assert error['code'] == 'rate_limited'
    assert error['retryable'] is True
    assert not any(m['role'] == 'assistant' for m in db.rows['messages'])


def test_midstream_disconnect_preserves_code_without_appending_busy_or_restarting(gateway, headers, db, monkeypatch):
    calls = []
    partial = '```js\nconst total = '
    def stream(*args, **options):
        calls.append(True)
        yield {'type': 'delta', 'data': partial}
        raise ConnectionError('provider connection lost')
    monkeypatch.setattr(nvidia_client, 'iter_response_with_fallback', stream)
    received = send(gateway, headers)
    assert len(calls) == 1
    assert not any(e['type'] == 'complete' for e in received)
    assert ''.join(e['data']['delta'] for e in received if e['type'] == 'token') == partial
    saved = next(e['data'] for e in received if e['type'] == 'assistant_message')
    assert saved['content'] == partial
    assert saved['generation_status'] == 'incomplete'
    assert next(e for e in received if e['type'] == 'error')['code'] == 'model_connection'


def test_final_reasoning_aggregate_does_not_repeat_streamed_reasoning(gateway, headers, db, monkeypatch):
    def stream(*args, **options):
        yield {'type': 'reasoning_delta', 'data': 'A short analysis'}
        yield {'type': 'delta', 'data': 'The answer'}
        yield {'type': 'done', 'content': 'The answer', 'reasoning': 'A short analysis', 'finish_reason': 'stop', 'complete': True}
    monkeypatch.setattr(nvidia_client, 'iter_response_with_fallback', stream)
    saved = next(e['data'] for e in send(gateway, headers) if e['type'] == 'assistant_message')
    assert saved['reasoning'] == 'A short analysis'


def test_upstream_inference_metadata_reaches_authenticated_stream(gateway, headers, db, monkeypatch):
    metadata = {'provider': 'groq', 'requested_model': 'qwen/test', 'reported_model': 'qwen/test-upstream', 'request_id': 'completion-test'}
    def stream(*args, **options):
        yield {'type': 'inference', **metadata}
        yield {'type': 'delta', 'data': 'Hello'}
        yield {'type': 'done', 'content': 'Hello', 'finish_reason': 'stop', 'complete': True}
    monkeypatch.setattr(nvidia_client, 'iter_response_with_fallback', stream)
    event = next(e for e in send(gateway, headers) if e['type'] == 'inference')
    assert event['data'] == metadata


def test_saved_ack_is_not_blocked_by_secondary_timestamp(gateway, headers, db, monkeypatch):
    import threading
    import time
    from app import chat_persistence, store
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    monkeypatch.setattr(chat_persistence, 'FINAL_FLUSH_TIMEOUT', .05)
    def touch(*args):
        entered.set()
        release.wait(2)
        finished.set()
    monkeypatch.setattr(store, 'touch_conversation', touch)
    monkeypatch.setattr(nvidia_client, 'iter_response_with_fallback', lambda *a, **k: iter([
        {'type': 'delta', 'data': 'A saved answer'},
        {'type': 'done', 'content': 'A saved answer', 'finish_reason': 'stop', 'complete': True},
    ]))
    started = time.monotonic()
    try:
        received = send(gateway, headers)
        assert any(e['type'] == 'assistant_message' for e in received)
        assert not any(e['type'] == 'error' for e in received)
        assert time.monotonic() - started < .5
        assert entered.wait(.5)
    finally:
        release.set()
        finished.wait(1)


def test_chat_retries_transient_user_write_with_stable_ids(gateway, headers, db, monkeypatch):
    from app import store
    original = store.add_message
    calls = []
    def fail_once(*args, **kwargs):
        if kwargs.get('role') == 'user':
            calls.append(kwargs.get('message_id'))
            if len(calls) == 1:
                raise ConnectionError('Temporary transport failure')
        return original(*args, **kwargs)
    monkeypatch.setattr(store, 'add_message', fail_once)
    monkeypatch.setattr(nvidia_client, 'iter_response_with_fallback', lambda *a, **k: iter([
        {'type': 'delta', 'data': 'A complete answer'},
        {'type': 'done', 'content': 'A complete answer', 'finish_reason': 'stop', 'complete': True},
    ]))
    received = send(gateway, headers)
    assert any(e['type'] == 'assistant_message' for e in received)
    assert len(calls) == 2 and calls[0] is not None and calls[0] == calls[1]
    assert len(db.rows['conversations']) == 1
    assert [m['role'] for m in db.rows['messages']] == ['user', 'assistant']


def test_waiting_for_provider_keeps_sse_alive_without_claiming_completion(gateway, headers, db, monkeypatch):
    import threading
    import time
    release = threading.Event()
    monkeypatch.setattr(chat_routes, 'SSE_HEARTBEAT_SECONDS', .02, raising=False)
    def stream(*args, **options):
        yield {'type': 'delta', 'data': 'Beginning'}
        release.wait(2)
        yield {'type': 'delta', 'data': ' complete'}
        yield {'type': 'done', 'content': 'Beginning complete', 'finish_reason': 'stop', 'complete': True}
    monkeypatch.setattr(nvidia_client, 'iter_response_with_fallback', stream)
    response = gateway.post('/chat', headers=headers, json={'message': 'Explain', 'auto_search': False}, buffered=False)
    try:
        started = time.monotonic()
        for chunk in response.response:
            text = chunk.decode()
            assert '"type": "complete"' not in text
            if text.startswith(': keep-alive'):
                break
        else:
            pytest.fail('No heartbeat while provider was waiting')
        assert time.monotonic() - started < .5
    finally:
        release.set()
        response.get_data()
        response.close()


def test_completion_event_exposes_verified_stop_reason(gateway, headers, db, monkeypatch):
    monkeypatch.setattr(nvidia_client, 'iter_response_with_fallback', lambda *a, **k: iter([
        {'type': 'delta', 'data': 'A complete answer'},
        {'type': 'done', 'content': 'A complete answer', 'finish_reason': 'stop', 'complete': True},
    ]))
    complete = next(e for e in send(gateway, headers) if e['type'] == 'complete')
    assert complete.get('finish_reason') == 'stop'


def test_continuations_stay_on_the_model_that_emitted_the_prefix(monkeypatch):
    from app.chat_generation import iter_completed_response
    calls = []
    def stream(messages, **options):
        calls.append(options)
        if len(calls) == 1:
            yield {'type': 'inference', 'provider': 'groq', 'requested_model': 'qwen/fallback', 'reported_model': 'qwen/fallback'}
            yield {'type': 'delta', 'data': 'const total = '}
            yield {'type': 'done', 'content': 'const total = ', 'finish_reason': 'length'}
        else:
            assert options['model'] == 'qwen/fallback'
            assert options['allow_fallback'] is False
            yield {'type': 'delta', 'data': '5;'}
            yield {'type': 'done', 'content': '5;', 'finish_reason': 'stop'}
    monkeypatch.setattr(nvidia_client, 'iter_response_with_fallback', stream)
    output = list(iter_completed_response([], model='nvidia/primary'))
    assert ''.join(e['data'] for e in output if e['type'] == 'delta') == 'const total = 5;'
    assert output[-1]['complete'] is True


def test_disabled_continuation_fallback_does_not_append_another_provider(monkeypatch):
    calls = []
    monkeypatch.setattr(nvidia_client, 'get_nexos_model', lambda: 'nvidia/primary')
    def stream(messages, **options):
        calls.append(options['model'])
        if options['model'] == 'nvidia/primary':
            raise RuntimeError('Primary unavailable')
        yield {'type': 'delta', 'data': 'Different answer'}
    monkeypatch.setattr(nvidia_client, 'iter_response', stream)
    with pytest.raises(RuntimeError, match='Primary unavailable'):
        list(nvidia_client.iter_response_with_fallback([], model='nvidia/primary', allow_fallback=False))
    assert calls == ['nvidia/primary']
