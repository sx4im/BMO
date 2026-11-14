/**
 * SSE Stream handler for Bmo chat completions.
 * Manages token assembly, reasoning timer, background buffering, status phrases, and stream cancellation.
 */

import * as api from "../api.js?v=65";

export const INITIAL_STATUS = "Preparing response…";

// Shown for the moment between "Bmo decided to search" and the results
// landing. Transient chrome, never persisted into the reply.
export const SEARCH_PREAMBLES = [
  "Let me check the latest on that.",
  "One moment, checking current sources.",
  "Let me look that up for you.",
  "Checking the most recent information.",
  "Give me a second, pulling this up live.",
];

let _lastPreambleIndex = -1;
export function getSearchPreamble() {
  let i = 0;
  do {
    i = Math.floor(Math.random() * SEARCH_PREAMBLES.length);
  } while (i === _lastPreambleIndex && SEARCH_PREAMBLES.length > 1);
  _lastPreambleIndex = i;
  return SEARCH_PREAMBLES[i];
}

export function formatElapsedSeconds(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

export class StreamHandler {
  constructor({
    getAuthToken,
    onConversation,
    onUserMessage,
    onToken,
    onReasoningToken,
    onComplete,
    onAssistantMessage,
    onError,
    onStatusChange,
    onSearching,
    onSearchComplete,
  }) {
    this.getAuthToken = getAuthToken;
    this.onConversation = onConversation || (() => {});
    this.onUserMessage = onUserMessage || (() => {});
    this.onToken = onToken || (() => {});
    this.onReasoningToken = onReasoningToken || (() => {});
    this.onComplete = onComplete || (() => {});
    this.onAssistantMessage = onAssistantMessage || (() => {});
    this.onError = onError || (() => {});
    this.onStatusChange = onStatusChange || (() => {});
    this.onSearching = onSearching || (() => {});
    this.onSearchComplete = onSearchComplete || (() => {});

    this.controller = null;
    this.currentStreamId = null;
    this.reasoningInterval = null;
    this.reasoningStartTime = null;
    this.lastReasoningSeconds = null;
    this.streamingText = "";
    this.streamingReasoning = "";
    this.hiddenBuffer = [];
    this.currentPhrase = "";
    this.isSearching = false;
  }

  get isStreaming() {
    return Boolean(this.controller && !this.controller.signal.aborted);
  }

  // Idempotent so the search card is settled exactly once, whether the server
  // closes it explicitly or the first token simply arrives.
  endSearch({ count = 0, elapsedMs = null, results = [], status = results.length ? "ok" : "empty" } = {}) {
    if (!this.isSearching) return;
    this.isSearching = false;
    this.onSearchComplete({ count, elapsedMs, results, status });
  }

  startReasoningTimer(onTick) {
    if (this.reasoningInterval) return;
    this.reasoningStartTime = Date.now();
    this.reasoningInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - this.reasoningStartTime) / 1000);
      if (onTick) onTick(elapsed);
    }, 1000);
  }

  stopReasoningTimer() {
    if (this.reasoningInterval) {
      clearInterval(this.reasoningInterval);
      this.reasoningInterval = null;
    }
    if (this.reasoningStartTime) {
      this.lastReasoningSeconds = Math.round((Date.now() - this.reasoningStartTime) / 1000);
    }
    this.reasoningStartTime = null;
  }

  cancel() {
    const token = this.getAuthToken();
    if (this.currentStreamId && token) {
      api.cancelChat(token, this.currentStreamId).catch(() => {});
    }
    if (this.controller) {
      this.controller.abort();
    }
    this.cleanup();
  }

  cleanup() {
    this.stopReasoningTimer();
    this.endSearch();
    this.controller = null;
    this.currentStreamId = null;
    this.hiddenBuffer = [];
    this.streamingText = "";
    this.streamingReasoning = "";
  }

  async executeStream({
    payload,
    streamId,
    onDeltaVoice,
    onVoiceStyle,
  }) {
    this.cleanup();
    this.controller = new AbortController();
    this.currentStreamId = streamId;
    this.streamingText = "";
    this.streamingReasoning = "";
    this.lastReasoningSeconds = null;

    const token = this.getAuthToken();
    if (!token) throw new Error("Not authenticated");

    this.currentPhrase = INITIAL_STATUS;
    this.onStatusChange({ phrase: this.currentPhrase });

    try {
      await api.streamChat(
        token,
        { ...payload, stream_id: streamId },
        {
          signal: this.controller.signal,
          onConversation: (convo) => this.onConversation(convo),
          onVoiceStyle,
          onUserMessage: (msg) => this.onUserMessage(msg),
          onSearchStatus: ({ label }) => {
            if (label) {
              this.currentPhrase = label;
              this.onStatusChange({ phrase: label });
            }
          },
          onSearching: ({ query }) => {
            this.isSearching = true;
            this.onSearching({ query, preamble: getSearchPreamble() });
          },
          onSearchComplete: (done) => {
            this.currentPhrase = "Preparing response…";
            this.onStatusChange({ phrase: this.currentPhrase });
            this.endSearch(done);
          },
          onReasoningToken: ({ delta }) => {
            this.endSearch();
            this.streamingReasoning += delta;
            this.startReasoningTimer((elapsed) => {
              this.onStatusChange({ reasoningElapsed: elapsed });
            });
            if (document.hidden) {
              this.hiddenBuffer.push({ type: "reasoning", delta });
            }
            this.onReasoningToken({
              delta,
              streamingText: this.streamingText,
              streamingReasoning: this.streamingReasoning,
            });
          },
          onToken: ({ delta }) => {
            this.endSearch();
            this.streamingText += delta;
            if (onDeltaVoice) {
              try { onDeltaVoice(this.streamingText); } catch {}
            }
            if (this.reasoningInterval) {
              this.stopReasoningTimer();
              this.onStatusChange({ reasoningElapsed: this.lastReasoningSeconds, reasoningDone: true });
            }
            if (document.hidden) {
              this.hiddenBuffer.push({ type: "content", delta });
            }
            this.onToken({
              delta,
              streamingText: this.streamingText,
              streamingReasoning: this.streamingReasoning,
            });
          },
          onComplete: () => {
            this.onComplete();
          },
          onAssistantMessage: (msg) => {
            if (this.lastReasoningSeconds != null) {
              msg.reasoning_seconds = this.lastReasoningSeconds;
            }
            if (!msg.reasoning && this.streamingReasoning) {
              msg.reasoning = this.streamingReasoning;
            }
            this.cleanup();
            this.onAssistantMessage(msg);
          },
          onError: (err) => {
            this.cleanup();
            this.onError(err);
          },
        }
      );
    } finally {
      this.cleanup();
    }
  }
}
