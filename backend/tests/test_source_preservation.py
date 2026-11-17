"""Generated source survives persistence without losing legitimate HTML nodes."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app import nvidia_client

FIXTURES = Path(__file__).parent / 'fixtures'
CASES = json.loads((FIXTURES / 'highlight_span_cases.json').read_text())


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['name'])
def test_only_balanced_highlighter_serialization_is_removed(case):
    assert nvidia_client.sanitize_reply(case['source']) == case['expected']


def test_live_calculator_source_roundtrips_without_losing_display_ids():
    source = (FIXTURES / 'calculator_response.md').read_text()
    assert 'id="history"' in source and 'id="result"' in source
    assert nvidia_client.sanitize_reply(source) == source


@pytest.mark.parametrize('split', [1, 10, 23, 35, 46])
def test_provider_chunks_preserve_html_and_matching_closers(monkeypatch, split):
    source = '<span class="history" id="history">&lt;literal&gt;</span>'
    client = MagicMock()
    client.chat.completions.create.return_value = [SimpleNamespace(choices=[SimpleNamespace(
        delta=SimpleNamespace(content=part), finish_reason='stop' if index else None,
    )]) for index, part in enumerate([source[:split], source[split:]])]
    monkeypatch.setattr(nvidia_client, '_client', lambda *args: client)
    events = list(nvidia_client.iter_response([], model='requested-model'))
    assert ''.join(event['data'] for event in events if event['type'] == 'delta') == source
    assert nvidia_client.sanitize_reply(events[-1]['content']) == source


@pytest.mark.parametrize('split', [7, 25, 39])
def test_stream_defers_highlighter_cleanup_until_matching_tags_are_assembled(monkeypatch, split):
    source = '<span class="hljs-string">&lt;vector&gt;</span> &amp;literal;'
    client = MagicMock()
    client.chat.completions.create.return_value = [SimpleNamespace(choices=[SimpleNamespace(
        delta=SimpleNamespace(content=part), finish_reason='stop' if index else None,
    )]) for index, part in enumerate([source[:split], source[split:]])]
    monkeypatch.setattr(nvidia_client, '_client', lambda *args: client)
    events = list(nvidia_client.iter_response([], model='requested-model'))
    streamed = ''.join(event['data'] for event in events if event['type'] == 'delta')
    assert streamed == source
    assert nvidia_client.sanitize_reply(streamed) == '<vector> &amp;literal;'
    assert nvidia_client.sanitize_reply(events[-1]['content']) == '<vector> &amp;literal;'
