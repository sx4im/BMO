from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app import voice_turns
from app.routes import media_routes
from .test_regressions import gateway, headers


@pytest.mark.parametrize('complete', [True, False])
def test_semantic_turn_verdict_is_bounded_and_uses_existing_groq(complete, monkeypatch):
    monkeypatch.delenv('VOICE_TURN_MODEL', raising=False)
    create = Mock(return_value=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"complete":%s}' % str(complete).lower()))]))
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    options = Mock(return_value=client)
    monkeypatch.setattr(voice_turns.groq_client, 'is_configured', lambda: True)
    monkeypatch.setattr(voice_turns.groq_client, 'default_model', lambda: 'qwen/qwen3.8-27b')
    monkeypatch.setattr(voice_turns.groq_client, '_client', lambda: SimpleNamespace(with_options=options))
    result = voice_turns.check_turn('What is photosynthesis?', 'What would you like to know?')
    assert result == {'available': True, 'complete': complete}
    options.assert_called_once_with(max_retries=0)
    call = create.call_args.kwargs
    assert call['timeout'] <= 1.2
    assert call['max_tokens'] <= 40
    assert call['reasoning_effort'] == 'none'
    assert 'photosynthesis' in call['messages'][1]['content']
    assert 'Do not answer' in call['messages'][0]['content']


@pytest.mark.parametrize('raw', ['{}', '{"complete":"true"}', '{"complete":1}', 'not json'])
def test_malformed_semantic_output_is_not_permission_to_submit(raw, monkeypatch):
    create = Mock(return_value=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=raw))]))
    monkeypatch.setattr(voice_turns.groq_client, 'is_configured', lambda: True)
    monkeypatch.setattr(voice_turns.groq_client, '_client', lambda: SimpleNamespace(with_options=lambda **_: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))))
    assert voice_turns.check_turn('I wanted to ask you about') == {'available': False, 'complete': False}


def test_semantic_provider_failure_does_not_leak_speech_or_key(monkeypatch, caplog):
    monkeypatch.setattr(voice_turns.groq_client, 'is_configured', lambda: True)
    monkeypatch.setattr(voice_turns.groq_client, '_client', Mock(side_effect=RuntimeError('SECRET and private transcript')))
    assert voice_turns.check_turn('private transcript') == {'available': False, 'complete': False}
    assert 'SECRET' not in caplog.text and 'private transcript' not in caplog.text


def test_turn_endpoint_requires_auth_and_validates_input(gateway, headers, monkeypatch):
    decide = Mock(return_value={'available': True, 'complete': True})
    monkeypatch.setattr(media_routes.voice_turns, 'check_turn', decide)
    assert gateway.post('/voice/turn', json={'transcript':'Hello'}).status_code == 401
    for value in [None, [], {}, {'transcript':42}, {'transcript':' '}, {'transcript':'a'*6001}, {'transcript':'Hello','previous_assistant':[]}]:
        assert gateway.post('/voice/turn', headers=headers, json=value).status_code == 422
    decide.assert_not_called()
    response = gateway.post('/voice/turn', headers=headers, json={'transcript':'How are you?', 'previous_assistant':'Hello'})
    assert response.status_code == 200
    assert response.json == {'available':True,'complete':True}
    assert response.headers['Cache-Control'] == 'no-store'
    decide.assert_called_once_with('How are you?', 'Hello')


def test_semantic_check_can_use_existing_mistral_when_groq_is_absent(monkeypatch):
    create = Mock(return_value=SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"complete":true}'))]))
    monkeypatch.setattr(voice_turns.groq_client, 'is_configured', lambda: False)
    monkeypatch.setattr(voice_turns.mistral_client, 'is_configured', lambda: True)
    monkeypatch.setattr(voice_turns.mistral_client, '_client', lambda: SimpleNamespace(with_options=lambda **_: SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))))
    assert voice_turns.check_turn('موسم کیسا ہے؟') == {'available': True, 'complete': True}
    assert create.call_args.kwargs['timeout'] == 1.0
    assert 'reasoning_effort' not in create.call_args.kwargs


def test_semantic_check_without_a_provider_is_explicitly_unavailable(monkeypatch):
    monkeypatch.setattr(voice_turns.groq_client, 'is_configured', lambda: False)
    monkeypatch.setattr(voice_turns.mistral_client, 'is_configured', lambda: False)
    assert voice_turns.check_turn('Hello') == {'available': False, 'complete': False}
