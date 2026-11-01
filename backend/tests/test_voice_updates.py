"""Selective voice retrieval, delivery metadata, and documented TTS controls."""
import json

import pytest

from app import deepgram_tts, nvidia_client, search_router
from app.config import get_aeon_model
from app.prompts import AEON_SYSTEM_PROMPT, DEFAULT_SYSTEM_PROMPT, NATURAL_WRITING_PROMPT, VoiceReplyFilter
from app.routes import chat_routes
from .test_regressions import db, gateway, headers


@pytest.mark.parametrize('tone', ['neutral', 'gentle', 'lively'])
def test_voice_marker_survives_every_stream_boundary(tone):
    raw = f'[[voice:{tone}]] This is a complete reply. Here is the next sentence.'
    for split in range(len(raw) + 1):
        parser = VoiceReplyFilter()
        events = [parser.feed(raw[:split]), parser.feed(raw[split:]), parser.feed('', final=True)]
        assert ''.join(text for _, text in events) == 'This is a complete reply. Here is the next sentence.'
        assert [value for value, _ in events if value] == [tone]


@pytest.mark.parametrize('raw,expected', [
    ('A normal answer without metadata.', 'A normal answer without metadata.'),
    ('[[voice:unknown]] Still useful.', 'Still useful.'),
    ('[[voice:gentle', ''),
    ('[[voice:' + 'a' * 70, ''),
])
def test_missing_or_malformed_voice_marker_never_leaks(raw, expected):
    parser = VoiceReplyFilter()
    tone, text = parser.feed(raw, final=True)
    assert tone == 'neutral'
    assert text == expected


def events(response):
    return [json.loads(line[6:]) for line in response.get_data(as_text=True).splitlines() if line.startswith('data: ')]


@pytest.mark.parametrize('endpoint', ['/chat', '/chat/incognito'])
@pytest.mark.parametrize('needs_search', [False, True])
def test_aeon_uses_selective_search_and_only_streams_its_answer(gateway, headers, db, monkeypatch, endpoint, needs_search):
    decisions, searches, captured = [], [], []
    monkeypatch.setattr(chat_routes, 'get_usage_status', lambda _: {'blocked': False})
    def decide(query, **kwargs):
        decisions.append(query)
        return needs_search, 'latest forecast'
    monkeypatch.setattr(search_router, 'should_search', decide)
    def retrieve(query):
        searches.append(query)
        return [{'url': 'https://weather.invalid/today', 'title': 'Forecast', 'content': 'Retrieved temperature is 21 degrees.'}]
    monkeypatch.setattr(search_router, 'run_search', retrieve)
    def respond(messages, **kwargs):
        captured.append((messages, kwargs))
        for chunk in ('[[voi', 'ce:gentle]] ', 'It is mild today. ', 'Bring a light jacket.'):
            yield {'type': 'delta', 'data': chunk}
        yield {'type': 'done', 'content': '[[voice:gentle]] It is mild today. Bring a light jacket.'}
    monkeypatch.setattr(nvidia_client, 'iter_response_with_fallback', respond)
    response = gateway.post(endpoint, headers=headers, json={'model': 'aeon', 'message': 'What is the weather today?' if needs_search else 'Tell me about triangles', 'auto_search': True})
    assert response.status_code == 200
    items = events(response)
    assert len(decisions) == 1
    assert len(searches) == int(needs_search)
    assert len([e for e in items if e['type'] == 'searching']) == int(needs_search)
    assert [e['data']['tone'] for e in items if e['type'] == 'voice_style'] == ['gentle']
    answer = ''.join(e['data']['delta'] for e in items if e['type'] == 'token')
    assert answer == 'It is mild today. Bring a light jacket.'
    assert '[[voice:' not in items[-1].get('data', {}).get('content', '')
    assert captured[0][1]['max_tokens'] == 450
    assert captured[0][1]['model'] == get_aeon_model()
    assert ('Retrieved temperature' in str(captured[0][0])) == needs_search
    assert all('[[voice:' not in row['content'] for row in db.rows['messages'])
    if endpoint.endswith('incognito'):
        assert not db.rows['messages']


@pytest.mark.parametrize('speed,expression', [('nan', 0), ('inf', 0), (0.4, 0), (1.03, 0), (1, 3), (1, 0.5), (1, 'bad')])
def test_voice_controls_reject_invalid_values(speed, expression):
    with pytest.raises(ValueError):
        deepgram_tts.voice_controls('flux-sienna-en', speed, expression)


def test_voice_controls_follow_flux_protocol_and_preserve_aura():
    assert deepgram_tts.voice_controls('flux-sienna-en', '1.05', '-1') == '&speed=1.05&expressivity=-1'
    assert deepgram_tts.voice_controls('aura-2-rhea-nl') == ''
    with pytest.raises(ValueError, match='Flux'):
        deepgram_tts.voice_controls('aura-2-rhea-nl', 1.05, -1)


def test_main_and_voice_share_natural_writing_defaults():
    assert NATURAL_WRITING_PROMPT in DEFAULT_SYSTEM_PROMPT
    assert NATURAL_WRITING_PROMPT in AEON_SYSTEM_PROMPT
    assert 'Do not add emojis by default' in DEFAULT_SYSTEM_PROMPT
    assert 'Do not use em dashes or en dashes' in DEFAULT_SYSTEM_PROMPT
    assert 'Explicit user writing preferences can override' in DEFAULT_SYSTEM_PROMPT
    assert 'three or four useful spoken sentences' in AEON_SYSTEM_PROMPT
