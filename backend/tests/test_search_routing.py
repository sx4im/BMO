"""Regressions for selective search and bounded provider work."""
from types import SimpleNamespace

import httpx
from openai import OpenAI
import pytest

from app import search_router as router


@pytest.mark.parametrize(
    'prompt',
    [
        'latest news',
        'BTC price',
        'weather',
        'Write code using the latest React API',
        "Draft an article about today's election results",
        'Explain current AI model benchmarks',
        'What is the best laptop for programming?',
    ],
)
def test_live_requests_bypass_generic_exclusions(prompt, monkeypatch):
    monkeypatch.setattr(router, '_classify', lambda *a, **kw: None)
    assert router.should_search(prompt)[0]


def test_attachment_recency(monkeypatch):
    monkeypatch.setattr(router, '_classify', lambda *a, **kw: None)
    assert router.should_search('What is the latest React?', has_attachments=True)[0]


@pytest.mark.parametrize(
    'prompt',
    [
        'hello',
        'thanks!',
        'Write a quicksort function',
        'Explain photosynthesis',
        '2 + 2',
    ],
)
def test_stable_stays_instant(prompt, monkeypatch):
    def unexpected(*a, **kw):
        pytest.fail('unnecessary classifier')

    monkeypatch.setattr(router, '_classify', unexpected)
    assert router.should_search(prompt) == (False, '')


def test_explicit_search_and_opt_out(monkeypatch):
    monkeypatch.setattr(router, '_classify', lambda *a, **kw: None)
    assert router.should_search('Search the web for photosynthesis')[0]
    assert router.should_search("Don't search the web; explain today's example") == (False, '')


def test_contextual_followup(monkeypatch):
    def classify(query, history=None, reformulate_only=False):
        assert history[0]['content'] == 'Weather in Lahore' and reformulate_only
        return True, 'Lahore weather tomorrow'

    monkeypatch.setattr(router, '_classify', classify)
    history = [{'role': 'user', 'content': 'Weather in Lahore'}]
    assert router.should_search('What about tomorrow?', history=history) == (
        True, 'Lahore weather tomorrow'
    )


@pytest.mark.parametrize(
    'raw',
    [
        '{}',
        '{"search":"false","query":"x"}',
        '{"search":0}',
        '{"search":null}',
    ],
)
def test_strict_verdict(raw):
    assert router._parse_verdict(raw, 'fallback', False) is None


@pytest.mark.parametrize(
    'raw',
    [
        'nan',
        'inf',
        '-10',
        '100',
    ],
)
def test_classifier_timeout_is_finite_and_bounded(raw, monkeypatch):
    monkeypatch.setenv('SEARCH_CLASSIFIER_TIMEOUT_S', raw)
    assert 0 < router._classifier_timeout() <= 1.5


def test_classifier_does_not_retry_sdk_requests(monkeypatch):
    calls = []

    def fail(req):
        calls.append(req)
        raise httpx.ReadTimeout('simulated', request=req)

    c = OpenAI(
        api_key='test',
        max_retries=2,
        http_client=httpx.Client(transport=httpx.MockTransport(fail)),
    )
    monkeypatch.setattr(
        router, '_classifier_backends', lambda: [('test', lambda: c, 'test')]
    )
    try:
        assert router._classify('ambiguous') is None
        assert len(calls) == 1
    finally:
        c.close()


def test_classifier_fallback_shares_one_budget(monkeypatch):
    clock = [0.0]
    calls = []

    class Client:
        def with_options(self, **kw):
            assert kw['max_retries'] == 0
            return self

        @property
        def chat(self):
            return SimpleNamespace(completions=SimpleNamespace(create=self.create))

        def create(self, **kw):
            calls.append(kw['timeout'])
            clock[0] += 2
            raise TimeoutError('simulated')

    monkeypatch.setattr(router.time, 'monotonic', lambda: clock[0])
    monkeypatch.setattr(
        router, '_classifier_backends',
        lambda: [('a', Client, 'a'), ('b', Client, 'b')],
    )
    assert router._classify('ambiguous') is None
    assert calls == [1.5]


def test_sources_retained():
    ctx = router.build_search_context(
        'query',
        [{'title': 'source', 'content': 'snippet',
          'url': 'https://example.com/source'}],
    )
    assert 'https://example.com/source' in ctx
    assert 'authoritative and override' not in ctx


def test_software_index_and_relative_date(monkeypatch):
    monkeypatch.setenv('TINYFISH_API_KEY', 'test')
    calls = []

    def get(url, **kw):
        calls.append(kw['params'])
        return SimpleNamespace(
            raise_for_status=lambda: None, json=lambda: {'results': []}
        )

    monkeypatch.setattr(router.requests, 'get', get)
    router.fetch_results('latest React API documentation')
    assert len(calls) == 1 and 'domain_type' not in calls[0]
    calls.clear()
    router.fetch_results('election results yesterday')
    assert calls[0]['query'] == 'election results yesterday'


def test_shared_retrieval_budget(monkeypatch):
    monkeypatch.setenv('TINYFISH_API_KEY', 'test')
    clock = [0.0]
    calls = []
    monkeypatch.setattr(router.time, 'monotonic', lambda: clock[0])

    def get(url, **kw):
        calls.append(kw['timeout'])
        clock[0] += 9
        return SimpleNamespace(
            raise_for_status=lambda: None, json=lambda: {'results': []}
        )

    monkeypatch.setattr(router.requests, 'get', get)
    with pytest.raises(TimeoutError):
        router.fetch_results('news today', timeout=8)
    assert len(calls) == 1


def test_outage_distinguished_from_empty(monkeypatch):
    monkeypatch.delenv('TINYFISH_API_KEY', raising=False)
    assert router.run_search('news').status == 'unavailable'
    monkeypatch.setattr(router, 'fetch_results', lambda *a, **kw: [])
    assert router.run_search('news').status == 'empty'


@pytest.mark.parametrize(
    'prompt',
    [
        'Implement a binary search algorithm',
        'Write a poem about tomorrow',
    ],
)
def test_search_word_and_creative_time_are_not_lookup_requests(prompt, monkeypatch):
    monkeypatch.setattr(router, '_classify', lambda *a, **kw: None)
    assert router.should_search(prompt) == (False, '')


def test_historical_search_does_not_inject_today(monkeypatch):
    monkeypatch.setenv('TINYFISH_API_KEY', 'test')
    calls = []

    def get(url, **kw):
        calls.append(kw['params'])
        return SimpleNamespace(
            raise_for_status=lambda: None, json=lambda: {'results': []}
        )

    monkeypatch.setattr(router.requests, 'get', get)
    router.fetch_results('Bitcoin price in 2020')
    assert calls == [{'query': 'Bitcoin price in 2020'}]


@pytest.mark.parametrize(
    'prompt',
    [
        'Write a function to update a list',
        'Write an email scheduling our meeting tomorrow',
        'Explain why stock prices change',
        'What is Google?',
    ],
)
def test_task_words_do_not_imply_live_facts(prompt, monkeypatch):
    monkeypatch.setattr(router, '_classify', lambda *a, **kw: None)
    assert router.should_search(prompt) == (False, '')


def test_explicit_search_resolves_contextual_references(monkeypatch):
    def classify(query, history=None, reformulate_only=False):
        assert history and reformulate_only
        return True, 'React versus Vue benchmarks'

    monkeypatch.setattr(router, '_classify', classify)
    history = [{'role': 'user', 'content': 'Compare React and Vue'}]
    assert router.should_search('search for both benchmarks', history=history) == (
        True, 'React versus Vue benchmarks'
    )


@pytest.mark.parametrize(
    'prompt',
    [
        'Write a blog post about the latest AI research',
        'Draft an article about the latest React release',
        'Compose an essay about current AI model updates',
    ],
)
def test_current_factual_composition_does_not_skip_search(prompt, monkeypatch):
    def unexpected(*args, **kwargs):
        pytest.fail('Explicit current facts should not need the classifier')

    monkeypatch.setattr(router, '_classify', unexpected)
    assert router.should_search(prompt)[0] is True


@pytest.mark.parametrize(
    'prompt',
    [
        'Explain how the election results changed',
        'Explain why Bitcoin prices fell',
    ],
)
def test_explanation_of_volatile_events_reaches_classifier(prompt, monkeypatch):
    calls = []

    def classify(query, **kwargs):
        calls.append(query)
        return True, 'verified event coverage'

    monkeypatch.setattr(router, '_classify', classify)
    assert router.should_search(prompt) == (True, 'verified event coverage')
    assert calls == [prompt]


@pytest.mark.parametrize('prompt', ['Search algorithms explained', 'Search trees explained'])
def test_search_data_structure_topics_are_not_browse_commands(prompt, monkeypatch):
    def unexpected(*args, **kwargs):
        pytest.fail('A stable data-structure topic needs no classifier or web request')

    monkeypatch.setattr(router, '_classify', unexpected)
    assert router.should_search(prompt) == (False, '')
