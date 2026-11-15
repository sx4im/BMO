from types import SimpleNamespace
from unittest.mock import Mock
import io

import pytest
import requests

from app.routes import media_routes
from app.prompts import AEON_SYSTEM_PROMPT
from .test_regressions import gateway, headers


def test_voice_prompt_supports_flux_languages_and_contextual_delivery():
    assert 'STRICT 7-LANGUAGE' not in AEON_SYSTEM_PROMPT
    for language in ('Urdu', 'Bengali', 'Vietnamese', 'Gujarati', 'Modern Greek'):
        assert language in AEON_SYSTEM_PROMPT
    assert 'pace and volume' in AEON_SYSTEM_PROMPT
    assert 'current spoken language' in AEON_SYSTEM_PROMPT


def test_stream_token_requires_auth(gateway, monkeypatch):
    post = Mock()
    monkeypatch.setattr(media_routes.requests, 'post', post)
    assert gateway.post('/transcribe/token').status_code == 401
    post.assert_not_called()


def test_stream_token_is_short_lived_and_never_returns_key(gateway, headers, monkeypatch):
    monkeypatch.setenv('DEEPGRAM_API_KEY', 'permanent-secret')
    post = Mock(return_value=SimpleNamespace(status_code=200, ok=True,
        json=lambda: {'access_token': 'temporary-jwt', 'expires_in': 30, 'private': 'discard'}))
    monkeypatch.setattr(media_routes.requests, 'post', post)
    response = gateway.post('/transcribe/token', headers=headers)
    assert response.status_code == 200
    assert response.json == {'access_token': 'temporary-jwt', 'expires_in': 30, 'model': 'nova-3', 'language': 'multi'}
    assert response.headers['Cache-Control'] == 'no-store'
    assert 'permanent-secret' not in response.text
    assert 'discard' not in response.text
    assert post.call_args.args == ('https://api.deepgram.com/v1/auth/grant',)
    assert post.call_args.kwargs['headers']['Authorization'] == 'Token permanent-secret'
    assert post.call_args.kwargs['json'] == {'ttl_seconds': 30}
    assert post.call_args.kwargs['timeout'] <= 10


@pytest.mark.parametrize('failure', ['missing', 'forbidden', 'timeout', 'malformed'])
def test_stream_token_failure_is_actionable_and_does_not_leak_credentials(gateway, headers, monkeypatch, failure):
    monkeypatch.setenv('DEEPGRAM_API_KEY', '' if failure == 'missing' else 'permanent-secret')
    post = Mock(return_value=SimpleNamespace(ok=failure != 'forbidden', status_code=403,
        json=lambda: {'access_token': 'permanent-secret'} if failure == 'forbidden' else {}))
    if failure == 'timeout':
        post.side_effect = requests.Timeout('permanent-secret')
    monkeypatch.setattr(media_routes.requests, 'post', post)
    response = gateway.post('/transcribe/token', headers=headers)
    assert response.status_code in {502, 503}
    assert response.json['detail']
    assert 'permanent-secret' not in response.text
    if failure == 'forbidden':
        assert 'Member' in response.json['detail']
    if failure == 'missing':
        post.assert_not_called()


@pytest.mark.parametrize('language', ['multi', 'ur'])
def test_recorded_transcription_uses_nova3_without_temporary_token_grant(gateway, headers, monkeypatch, language):
    monkeypatch.setenv('DEEPGRAM_API_KEY', 'usage-only-key')
    audio = b'RIFF' + b'\x00' * 4 + b'WAVE' + b'\x00' * 32
    post = Mock(return_value=SimpleNamespace(ok=True, status_code=200, json=lambda: {
        'results': {'channels': [{'alternatives': [{'transcript': 'Recognized recording.'}]}]}}))
    monkeypatch.setattr(media_routes.requests, 'post', post)
    response = gateway.post('/transcribe', headers=headers, data={
        'audio': (io.BytesIO(audio), 'recording.wav'), 'language': language})
    assert response.status_code == 200
    assert response.json == {'text': 'Recognized recording.'}
    assert post.call_count == 1
    assert post.call_args.args == ('https://api.deepgram.com/v1/listen',)
    assert post.call_args.kwargs['params']['model'] == 'nova-3'
    assert post.call_args.kwargs['params']['language'] == language
    assert post.call_args.kwargs['data'] == audio
    assert post.call_args.kwargs['headers']['Authorization'] == 'Token usage-only-key'


@pytest.mark.parametrize('failure', ['forbidden', 'timeout', 'malformed'])
def test_recorded_transcription_failures_preserve_credential_confidentiality(gateway, headers, monkeypatch, failure):
    monkeypatch.setenv('DEEPGRAM_API_KEY', 'permanent-secret')
    post = Mock(return_value=SimpleNamespace(ok=failure != 'forbidden', status_code=403, json=lambda: {}))
    if failure == 'timeout':
        post.side_effect = requests.Timeout('permanent-secret')
    monkeypatch.setattr(media_routes.requests, 'post', post)
    response = gateway.post('/transcribe', headers=headers, data={
        'audio': (io.BytesIO(b'RIFF' + b'\x00' * 4 + b'WAVE' + b'\x00' * 32), 'recording.wav')})
    assert response.status_code in {502, 503}
    assert 'permanent-secret' not in response.text
