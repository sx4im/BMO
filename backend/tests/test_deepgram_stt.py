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
    assert 'all 42 languages' in AEON_SYSTEM_PROMPT


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


@pytest.mark.parametrize('form', [{'language':'auto'}, {'language':'multi','auto_language':'1'}])
def test_voice_auto_uses_whisper_detection_instead_of_an_english_or_nova_multi_lock(gateway, headers, monkeypatch, form):
    monkeypatch.setenv('DEEPGRAM_API_KEY', 'deepgram-test-secret')
    monkeypatch.setenv('GROQ_API_KEY', 'groq-test-secret')
    monkeypatch.delenv('TRANSCRIBE_BASE_URL', raising=False)
    monkeypatch.delenv('TRANSCRIBE_API_KEY', raising=False)
    post=Mock(return_value=SimpleNamespace(ok=True,status_code=200,json=lambda:{'text':'آپ کیسے ہیں؟','language':'urdu'}))
    monkeypatch.setattr(media_routes.requests,'post',post)
    response=gateway.post('/transcribe',headers=headers,data={
        'audio':(io.BytesIO(b'RIFF'+b'\x00'*4+b'WAVE'+b'\x00'*32),'recording.wav'),**form})
    assert response.status_code==200
    assert response.json=={'text':'آپ کیسے ہیں؟','language':'urdu'}
    assert post.call_args.args==('https://api.groq.com/openai/v1/audio/transcriptions',)
    data=post.call_args.kwargs['data']
    assert data['model']=='whisper-large-v3'
    assert data['response_format']=='verbose_json'
    assert 'language' not in data


def test_recorded_multilingual_response_preserves_detected_language(gateway,headers,monkeypatch):
    monkeypatch.setenv('DEEPGRAM_API_KEY','test-key')
    post=Mock(return_value=SimpleNamespace(ok=True,status_code=200,json=lambda:{
        'results':{'channels':[{'alternatives':[{'transcript':'Bonjour.','languages':['fr','en']}]}]}}))
    monkeypatch.setattr(media_routes.requests,'post',post)
    response=gateway.post('/transcribe',headers=headers,data={
        'audio':(io.BytesIO(b'RIFF'+b'\x00'*4+b'WAVE'+b'\x00'*32),'recording.wav'),'language':'multi'})
    assert response.json=={'text':'Bonjour.','language':'fr'}


def test_auto_without_detection_provider_is_actionable_instead_of_forcing_english(gateway,headers,monkeypatch):
    monkeypatch.setenv('DEEPGRAM_API_KEY','test-key')
    for key in ('TRANSCRIBE_BASE_URL','TRANSCRIBE_API_KEY','GROQ_API_KEY','OPENAI_API_KEY'):
        monkeypatch.delenv(key,raising=False)
    post=Mock();monkeypatch.setattr(media_routes.requests,'post',post)
    response=gateway.post('/transcribe',headers=headers,data={
        'audio':(io.BytesIO(b'RIFF'+b'\x00'*4+b'WAVE'+b'\x00'*32),'recording.wav'),'language':'auto'})
    assert response.status_code==503
    assert 'Select a language' in response.json['detail']
    post.assert_not_called()


def test_auto_requires_provider_language_metadata(gateway,headers,monkeypatch):
    monkeypatch.setenv('GROQ_API_KEY','test-key')
    monkeypatch.delenv('TRANSCRIBE_BASE_URL',raising=False)
    monkeypatch.delenv('TRANSCRIBE_API_KEY',raising=False)
    monkeypatch.setattr(media_routes.requests,'post',Mock(return_value=SimpleNamespace(ok=True,json=lambda:{'text':'A transcript without a language.'})))
    response=gateway.post('/transcribe',headers=headers,data={
        'audio':(io.BytesIO(b'RIFF'+b'\x00'*4+b'WAVE'+b'\x00'*32),'recording.wav'),'language':'auto'})
    assert response.status_code==502
    assert 'Select a language' in response.json['detail']
