/**
 * SSE Stream handler for Bmo chat completions.
 * Manages token assembly, reasoning timer, background buffering, status phrases, and stream cancellation.
 */

import * as api from "../api.js?v=76";
import { getRandomPhrase } from "./waiting-phrases.js?v=2";
export { ROTATING_PHRASES, getRandomPhrase } from "./waiting-phrases.js?v=2";

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

    this.run = null;
    this.controller = null;
    this.currentStreamId = null;
    this.rotateInterval = null;
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

  startStatusRotation() {
    this.stopStatusRotation();
    const rotate = () => {
      this.currentPhrase = getRandomPhrase();
      this.onStatusChange({ phrase: this.currentPhrase });
    };
    rotate();
    this.rotateInterval = setInterval(rotate, 3000);
  }

  stopStatusRotation() {
    if (this.rotateInterval !== null) clearInterval(this.rotateInterval);
    this.rotateInterval = null;
  }

  cancel() {
    const partial = { content: this.streamingText, reasoning: this.streamingReasoning };
    const retryMessageId = this.run?.retryMessageId;
    const token = this.getAuthToken();
    if (this.currentStreamId && token) {
      api.cancelChat(token, this.currentStreamId).catch(() => {});
    }
    if (this.controller) {
      this.controller.abort();
    }
    this.cleanup();
    if (partial.content.trim() || partial.reasoning.trim()) {
      this.onError(new DOMException("Response stopped", "AbortError"), partial, retryMessageId);
    }
  }

  cleanup({ invalidate = true } = {}) {
    if (invalidate) this.run = null;
    this.stopStatusRotation();
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
    const run = { retryMessageId: payload.retry_message_id };
    this.run = run;
    const ownsRun = () => this.run === run;
    const controller = new AbortController();
    this.controller = controller;
    this.currentStreamId = streamId;
    this.streamingText = "";
    this.streamingReasoning = "";
    this.lastReasoningSeconds = null;

    const token = this.getAuthToken();
    if (!token) { this.cleanup(); throw new Error("Not authenticated"); }

    this.startStatusRotation();

    let errorReported = false;
    let receivedAssistant = false;
    const reportError = (err) => {
      if (!ownsRun() || errorReported) return;
      errorReported = true;
      const partial = { content: this.streamingText, reasoning: this.streamingReasoning };
      this.cleanup();
      this.onError(err, partial, payload.retry_message_id);
    };
    const firstOutputTimer = setTimeout(() => {
      if (!ownsRun()) return;
      controller.abort();
      reportError(Object.assign(new Error("Chat did not respond. Try sending again."), { retryable: true }));
    }, 90_000);
    const receivedOutput = () => clearTimeout(firstOutputTimer);

    try {
      await api.streamChat(
        token,
        { ...payload, stream_id: streamId },
        {
          signal: controller.signal,
          onConversation: (convo) => { if (ownsRun()) this.onConversation(convo); },
          onVoiceStyle: (data) => { if (ownsRun()) onVoiceStyle?.(data); },
          onUserMessage: (msg) => { if (ownsRun()) this.onUserMessage(msg); },
          onSearchStatus: ({ status, label }) => {
            if (!ownsRun()) return;
            if (status === "checking") return;
            if (label) {
              this.stopStatusRotation();
              this.currentPhrase = label;
              this.onStatusChange({ phrase: label });
            }
          },
          onSearching: ({ query }) => {
            if (!ownsRun()) return;
            this.stopStatusRotation();
            this.isSearching = true;
            this.onSearching({ query, preamble: getSearchPreamble() });
          },
          onSearchComplete: (done) => {
            if (!ownsRun()) return;
            if (!this.streamingText) this.startStatusRotation();
            this.endSearch(done);
          },
          onReasoningToken: ({ delta }) => {
            if (!ownsRun()) return;
            receivedOutput();
            if (this.isSearching) this.startStatusRotation();
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
            if (!ownsRun()) return;
            receivedOutput();
            this.stopStatusRotation();
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
            if (!ownsRun()) return;
            receivedOutput();
            this.stopStatusRotation();
            this.onComplete();
          },
          onAssistantMessage: (msg) => {
            if (!ownsRun()) return;
            receivedOutput();
            receivedAssistant = true;
            if (this.lastReasoningSeconds != null) {
              msg.reasoning_seconds = this.lastReasoningSeconds;
            }
            if (!msg.reasoning && this.streamingReasoning) {
              msg.reasoning = this.streamingReasoning;
            }
            this.cleanup({ invalidate: false });
            this.onAssistantMessage(msg, payload.retry_message_id);
          },
          onError: reportError,
        }
      );
      if (ownsRun() && !receivedAssistant && !errorReported) {
        const hasOutput = this.streamingText.trim() || this.streamingReasoning.trim();
        reportError(new Error(hasOutput
          ? "The connection closed before saving was confirmed. Keep this page open and copy the answer if needed."
          : "The connection closed before Bmo replied. Try again."));
      }
    } catch (err) {
      if (err?.name !== "AbortError") reportError(err);
      throw err;
    } finally {
      clearTimeout(firstOutputTimer);
      if (ownsRun()) this.cleanup();
    }
  }
}
