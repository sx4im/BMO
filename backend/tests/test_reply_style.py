"""Default punctuation survives streaming without rewriting literal content."""
import pytest

from app import nvidia_client, store
from app.reply_style import ProseDashFilter, allows_long_dashes
from app.routes import chat_routes
from .test_regressions import db, gateway, headers
from .test_voice_updates import events


@pytest.mark.parametrize("raw,expected", [
    ("Messi's philanthropy—including his UNICEF work—has helped many.", "Messi's philanthropy, including his UNICEF work, has helped many."),
    ("A good answer — with details — reads naturally.", "A good answer, with details, reads naturally."),
    ("Won in 2009–2012. Keep x − y intact.", "Won in 2009-2012. Keep x − y intact."),
    ('Code `a—b` and ``a`—b``. Then prose—here.', 'Code `a—b` and ``a`—b``. Then prose, here.'),
    ('```python\nvalue = "a—b"\n```\nProse—here.', '```python\nvalue = "a—b"\n```\nProse, here.'),
    ('~~~text\na—b\n~~~\nProse—here.', '~~~text\na—b\n~~~\nProse, here.'),
    ('Math $x—y$, $$a–b$$, \\(c—d\\) and \\[e–f\\]. Prose—here.', 'Math $x—y$, $$a–b$$, \\(c—d\\) and \\[e–f\\]. Prose, here.'),
    ('“literal—quote” and "literal—quote". Prose—here.', '“literal—quote” and "literal—quote". Prose, here.'),
    ("'literal—quote' and ‘literal—quote’. Prose—here.", "'literal—quote' and ‘literal—quote’. Prose, here."),
    ('> A quoted line—intact.\n\nProse—here.', '> A quoted line—intact.\n\nProse, here.'),
    ('[link](https://example.org/a—b(c)) and https://example.org/a—b end—here.', '[link](https://example.org/a—b(c)) and https://example.org/a—b end, here.'),
    ('<a title="a—b">text—here</a>.', '<a title="a—b">text, here</a>.'),
    ('Unclosed `literal—text', 'Unclosed `literal—text'),
    ('``a```—b`` then prose—here.', '``a```—b`` then prose, here.'),
])
def test_punctuation_at_every_chunk_boundary(raw, expected):
    for split in range(len(raw) + 1):
        formatter = ProseDashFilter()
        assert formatter.feed(raw[:split]) + formatter.feed(raw[split:]) + formatter.feed("", final=True) == expected
    formatter = ProseDashFilter()
    assert "".join(formatter.feed(char) for char in raw) + formatter.feed("", final=True) == expected


@pytest.mark.parametrize("instructions,expected", [
    ((), False), (("Keep answers concise.",), False),
    (("Use em dashes.",), True), (("I prefer long dashes in prose.",), True),
    (("Do not use em dashes.",), False), (("Don't use em dashes.",), False),
    (("Never include long dashes.",), False), (("Avoid em dashes.",), False),
    (("Use em dashes.", "Avoid long dashes."), False),
    (("Use em dashes.", "No long dashes."), False),
    (("No long dashes.", "Please use em dashes."), True),
])
def test_only_direct_writing_preferences_override_default(instructions, expected):
    assert allows_long_dashes(*instructions) is expected


def test_ordinary_prose_streams_immediately():
    formatter = ProseDashFilter()
    assert formatter.feed("Cells, tissues, organs.") == "Cells, tissues, organs."
    assert formatter.feed("", final=True) == ""


@pytest.mark.parametrize("endpoint", ["/chat", "/chat/incognito"])
@pytest.mark.parametrize("model", ["thinking", "aeon"])
@pytest.mark.parametrize("override", [False, True])
@pytest.mark.parametrize("streamed", [False, True])
def test_stream_and_saved_reply_share_the_same_punctuation(gateway, headers, db, monkeypatch, endpoint, model, override, streamed):
    monkeypatch.setattr(chat_routes, "get_usage_status", lambda _: {"blocked": False})
    if override:
        store.save_preferences("owner", "Use em dashes in prose.")
    raw = 'Useful—details. Code `a—b` stays intact.'
    def respond(*args, **kwargs):
        text = ("[[voice:gentle]] " if model == "aeon" else "") + raw
        if streamed:
            for char in text:
                yield {"type": "delta", "data": char}
        yield {"type": "done", "content": text}
    monkeypatch.setattr(nvidia_client, "iter_response_with_fallback", respond)
    response = gateway.post(endpoint, headers=headers, json={"model": model, "message": "Explain this", "auto_search": False})
    assert response.status_code == 200
    items = events(response)
    expected = raw if override else 'Useful, details. Code `a—b` stays intact.'
    assert "".join(e["data"]["delta"] for e in items if e["type"] == "token") == expected
    assert [e["data"]["content"] for e in items if e["type"] == "assistant_message"] == [expected]
    assert all(row["content"] == expected for row in db.rows["messages"] if row["role"] == "assistant")
