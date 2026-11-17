"""Normalize streamed provider output into one bounded, completed response."""
from __future__ import annotations

from . import nvidia_client


class GenerationFailure(RuntimeError):
    def __init__(self, code, detail, *, retryable=False):
        super().__init__(detail)
        self.code = code
        self.retryable = retryable


def iter_completed_response(messages, *, cancel_event=None, max_continuations=2, **options):
    """Continue a length-limited answer without restarting text already emitted.

    Adapters enforce transport completion. This layer owns the answer across
    completion windows and emits a single final done event, never a false stop.
    """
    source_messages = list(messages)
    text = ""
    reasoning = ""
    pinned_model = None
    for continuation in range(max_continuations + 1):
        if cancel_event is not None and cancel_event.is_set():
            return
        current_messages = source_messages
        if continuation:
            current_messages = source_messages + [
                {"role": "assistant", "content": text or reasoning},
                {"role": "user", "content": (
                    "Continue the unfinished response exactly after its last character. "
                    "Return only the remaining content. Do not restart, summarize, repeat "
                    "existing text, or add a new opening code fence inside an unfinished "
                    "code block. Finish all remaining code and close its existing fence."
                )},
            ]
        segment_text = ""
        segment_reasoning = ""
        terminal = None
        request_options = dict(options)
        if continuation:
            request_options["model"] = pinned_model or options.get("model")
            request_options["allow_fallback"] = False
        candidate_model = request_options.get("model")
        stream = nvidia_client.iter_response_with_fallback(current_messages, **request_options)
        try:
            for event in stream:
                if cancel_event is not None and cancel_event.is_set():
                    return
                kind = event.get("type")
                if kind == "inference":
                    candidate_model = event.get("requested_model") or candidate_model
                    yield event
                elif kind == "delta":
                    if event.get("data") and pinned_model is None:
                        pinned_model = candidate_model
                    segment_text += event.get("data") or ""
                    yield event
                elif kind == "reasoning_delta":
                    if event.get("data") and pinned_model is None:
                        pinned_model = candidate_model
                    segment_reasoning += event.get("data") or ""
                    yield event
                elif kind == "done":
                    terminal = event
                    # Full aggregates confirm a stream; they must not duplicate
                    # deltas that are already displayed and checkpointed.
                    if not segment_text and event.get("content"):
                        if pinned_model is None:
                            pinned_model = candidate_model
                        segment_text = event["content"]
                        yield {"type": "delta", "data": segment_text}
                    if not segment_reasoning and event.get("reasoning"):
                        segment_reasoning = event["reasoning"]
                        yield {"type": "reasoning_delta", "data": segment_reasoning}
                else:
                    yield event
        finally:
            close = getattr(stream, "close", None)
            if close:
                close()
        text += segment_text
        reasoning += segment_reasoning
        if terminal is None:
            raise GenerationFailure(
                "model_connection", "The model connection ended before completion was confirmed.", retryable=True,
            )
        # Older/custom adapters may omit metadata; current production adapters
        # always supply the actual provider reason and validate premature EOF.
        finish_reason = terminal.get("finish_reason", "stop")
        if finish_reason == "length":
            if continuation >= max_continuations or not (segment_text or segment_reasoning):
                raise GenerationFailure(
                    "output_limit", "The response reached its output limit before finishing. The received content has been kept.",
                    retryable=True,
                )
            yield {"type": "generation_status", "data": {"status": "continuing", "continuation": continuation + 1}}
            continue
        if finish_reason != "stop":
            raise GenerationFailure("model_incomplete", "The model stopped without completing the response.", retryable=True)
        if not text.strip():
            raise GenerationFailure("empty_response", "The model returned no answer. Please try again.", retryable=True)
        yield {"type": "done", "content": "", "reasoning": "", "finish_reason": "stop", "complete": True,
               "usage": terminal.get("usage")}
        return
