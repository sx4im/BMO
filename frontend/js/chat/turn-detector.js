// A short quiet window allows a semantic verdict; silence alone cannot commit
// a turn. Each new transcript/audio revision invalidates earlier decisions.
export class SemanticTurnDetector {
  constructor({ check, onComplete, onUnavailable, settleMs = 300, timeoutMs = 1800 }) {
    Object.assign(this, { check, onComplete, onUnavailable, settleMs, timeoutMs });
    this.text = "";
    this.speaking = true;
    this.revision = 0;
    this.checkedRevision = -1;
    this.unavailable = false;
    this.closed = false;
  }

  update(text) {
    text = (text || "").trim();
    if (this.closed || text === this.text) return;
    this.text = text;
    this.invalidate();
    this.queue();
  }

  setSpeaking(speaking) {
    if (this.closed || this.speaking === speaking) return;
    this.speaking = speaking;
    if (speaking) this.invalidate();
    else this.queue();
  }

  invalidate() {
    this.revision++;
    clearTimeout(this.timer);
    if (this.pending) {
      clearTimeout(this.pending.deadline);
      this.pending.controller.abort();
      this.pending = null;
    }
  }

  queue() {
    if (this.closed || this.unavailable || this.speaking || !this.text || this.checkedRevision === this.revision) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.evaluate(), this.settleMs);
  }

  async evaluate() {
    const revision = this.revision;
    const text = this.text;
    const pending = { controller: new AbortController() };
    this.pending = pending;
    this.checkedRevision = revision;
    const current = () => !this.closed && this.pending === pending && revision === this.revision && !this.speaking;
    let onAbort;
    try {
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(new Error("Turn check canceled"));
        pending.controller.signal.addEventListener("abort", onAbort, { once: true });
        pending.deadline = setTimeout(() => pending.controller.abort(), this.timeoutMs);
      });
      const verdict = await Promise.race([
        this.check(text, { signal: pending.controller.signal }), aborted,
      ]);
      if (!current()) return;
      if (verdict?.available !== true || typeof verdict.complete !== "boolean") {
        this.unavailable = true;
        this.onUnavailable?.();
      } else if (verdict.complete) {
        this.cancel();
        this.onComplete(text);
      }
    } catch {
      if (!current()) return;
      this.unavailable = true;
      this.onUnavailable?.();
    } finally {
      clearTimeout(pending.deadline);
      pending.controller.signal.removeEventListener("abort", onAbort);
      if (this.pending === pending) this.pending = null;
    }
  }

  cancel() {
    this.closed = true;
    this.invalidate();
  }
}
