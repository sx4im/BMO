/**
 * Incremental streaming renderer for BMO's assistant bubbles.
 *
 * Replaces the token-loop's full `bubble.innerHTML = renderMarkdown(all)`
 * (O(n²) parse cost, total DOM churn, lost scroll/code-copy state) with:
 *
 *   1. rAF batching   — tokens mutate local strings only; all parsing and
 *                       DOM writes happen at most once per animation frame.
 *   2. Frozen blocks  — the accumulating text is cut into stable block
 *                       chunks (see stream-splitter.js). A chunk is parsed
 *                       exactly once when it closes; completed paragraphs,
 *                       lists, tables and code blocks are NEVER re-parsed
 *                       or re-created.
 *   3. Tail-only work — only the open tail chunk is re-parsed per frame,
 *                       and its HTML is diffed against the previous write
 *                       so idle frames cost nothing.
 *   4. Typewriter     — rendered text chases arrived text each frame
 *                       (floor speed + proportional drain), so bursts flow
 *                       out as one steady stream instead of chunk pops.
 *   5. Single caret   — at most ONE orange ▋ exists, always at the very
 *                       end of the newest rendered text. It is a persistent
 *                       node MOVED each frame, never baked into block HTML;
 *                       leaked caret glyphs in the model's text are scrubbed.
 *
 * Scroll-followership does NOT live here: MessageFeed owns a permanent
 * ScrollFollower for the page lifetime, and this renderer simply asks it to
 * chase the bottom while it paints. `feed` is injected by the caller.
 */

import { renderMarkdown } from "../components/markdown.js?v=34";
import { splitStreamBlocks } from "./stream-splitter.js?v=2";
import { stripStrayCursors } from "./caret.js?v=1";
import { el, clear } from "../utils.js?v=30";

// Typewriter pacing: floor speed keeps slow drips flowing; proportional
// drain eats bursts fast (~130ms exponential catch-up time constant) so
// output reads as one steady stream instead of per-chunk pops.
const TYPE_MIN_STEP = 2.0;   // chars/frame floor (~120 cps @60Hz)
const TYPE_DRAIN = 0.12;     // fraction of the remaining backlog consumed per frame

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

export class StreamingRenderer {
  /** @param {HTMLElement} bubble the `.streaming-bubble[data-streaming]` element */
  constructor(bubble) {
    this.bubble = bubble;

    this.blocksWrap = el("div", { class: "stream-blocks" });
    this.cursor = el("span");
    this.cursor.className = "cursor";
    this.cursor.textContent = "▋";
    clear(bubble);
    // The caret lives INSIDE blocksWrap, after the tail block, so it sits
    // exactly at the text edge — and moves every frame instead of being
    // baked into any block's HTML.
    bubble.append(this.blocksWrap);
    this.blocksWrap.append(this.cursor);

    this.blockEls = [];      // frozen <div> per closed chunk
    this.tailEl = null;      // open chunk (re-parsed per frame)
    this.tailSrc = null;     // last source written into tailEl
    this.reasoningEl = null;
    this.framePending = false;

    // Typewriter pacing state.
    this.renderedChars = 0;

    /** Injected by streamingBubbleNode(): the owning MessageFeed. Its
     *  follower handles pinning + the jump button; we just ask it to chase. */
    this.feed = null;

    this.done = false;
  }

  /**
   * Push new accumulated state. Strings only — safe to call per token.
   * @returns {boolean} true while the target bubble is still attached
   */
  update(text, reasoning = "") {
    this.pendingText = text || "";
    this.pendingReasoning = reasoning || "";
    if (!this.framePending && !this.done) {
      // Reduced motion: no typewriter pacing — render everything as it lands.
      this.framePending = requestAnimationFrame(() =>
        prefersReducedMotion() ? this._flush() : this._tick()
      );
    }
    return true;
  }

  /** Final synchronous paint: close every chunk, drop the caret. */
  finish(text, reasoning = "") {
    if (this.framePending) {
      cancelAnimationFrame(this.framePending);
      this.framePending = false;
    }
    this.pendingText = text ?? this.pendingText ?? "";
    this.pendingReasoning = reasoning ?? this.pendingReasoning ?? "";
    // Flush at FULL length (it refuses to run once done), then latch done so
    // any straggler rAF/token after completion is ignored.
    this._flush(this.pendingText.length);
    this.done = true;
    this.cursor.remove();
  }

  // -- internals ------------------------------------------------------------

  _chase() {
    // Delegate follow-ship to the feed's permanent ScrollFollower.
    this.feed?.follower?.chase();
  }

  /**
   * One animation frame of the typewriter loop: advance the rendered length
   * toward the arrived length, paint, and re-schedule while backlog remains.
   */
  _tick() {
    this.framePending = false;
    if (this.done) return;
    if (!this.bubble.isConnected) return; // feed re-rendered — stop the loop
    const arrived = (this.pendingText ?? "").length;
    const gap = arrived - this.renderedChars;
    if (gap > 0) {
      const step = Math.max(TYPE_MIN_STEP, gap * TYPE_DRAIN);
      const target = Math.min(arrived, Math.floor(this.renderedChars + step));
      this._flush(target);
      if (!this.done && gap - step > 0.5) {
        this.framePending = requestAnimationFrame(() => this._tick());
      }
    } else {
      this._flush(arrived);
    }
  }

  /**
   * One animation frame of work. targetChars = how much of the arrived text
   * to render up to: during streaming it is the typewriter-paced length
   * (steady flow), at finish() it is the full length (everything lands).
   */
  _flush(targetChars = Infinity) {
    this.framePending = false;
    if (this.done) return;
    if (!this.bubble.isConnected) return; // feed re-rendered; drop stale writes

    const text = stripStrayCursors((this.pendingText ?? "").slice(0, Math.max(0, targetChars)));
    const reasoning = this.pendingReasoning ?? "";

    this._updateReasoning(reasoning, Boolean(text));

    if (!text) {
      // No answer tokens yet: nothing but the caret shows.
      if (this.tailSrc !== "") {
        this.tailEl?.remove();
        this.tailEl = null;
        this.tailSrc = "";
      }
      this.renderedChars = 0;
      this._chase();
      return;
    }

    const blocks = splitStreamBlocks(text);

    // Freeze every newly-closed chunk (parse once, never again). The old
    // tail div is RETIRED here — its text now lives inside the frozen block,
    // and leaving it attached would duplicate the text (and strand its caret).
    for (let i = this.blockEls.length; i < blocks.length - 1; i++) {
      const div = el("div", { class: "stream-block" });
      div.innerHTML = renderMarkdown(blocks[i]);
      if (this.tailEl?.isConnected) {
        this.tailEl.remove();
        this.tailEl = null;
        this.tailSrc = null;
      }
      this.blocksWrap.insertBefore(div, this.cursor); // frozen blocks stay under the caret
      this.blockEls.push(div);
    }
    while (this.blockEls.length > blocks.length - 1) {
      this.blockEls.pop()?.remove();
    }

    // Re-parse only the open tail, and only when it actually changed.
    if (!this.tailEl || !this.tailEl.isConnected) {
      this.tailEl = el("div", { class: "stream-block stream-tail" });
      this.blocksWrap.insertBefore(this.tailEl, this.cursor);
      this.tailSrc = null;
    }
    const tailSrc = blocks[blocks.length - 1] ?? "";
    if (tailSrc !== this.tailSrc) {
      this.tailEl.innerHTML = renderMarkdown(tailSrc);
      this.tailSrc = tailSrc;
    }
    this.renderedChars = text.length;

    // Single-caret policy: the ONE live caret node sits after the tail.
    this.tailEl.insertAdjacentElement("afterend", this.cursor);

    this._chase();
  }

  _updateReasoning(reasoning, hasAnswerText) {
    if (!reasoning.trim()) {
      if (this.reasoningEl) {
        this.reasoningEl.remove();
        this.reasoningEl = null;
      }
      return;
    }
    const body = this.bubble.closest(".body");
    if (!body) return;
    // No inline reasoning caret anywhere — the orb + timer already signal
    // liveness, and the single answer caret covers the stream edge.
    const html = stripStrayCursors(renderMarkdown(reasoning));
    let block = this.reasoningEl && this.reasoningEl.isConnected ? this.reasoningEl : null;
    if (!block) {
      block = body.querySelector(".reasoning-block") || null;
    }
    if (block) {
      const content = block.querySelector(".reasoning-content");
      if (content && content.dataset.src !== html) {
        content.innerHTML = html;
        content.dataset.src = html;
      }
    } else {
      // Build through MessageFeed's factory lazily to avoid a cycle.
      // Manual policy: the block stays collapsed until the user clicks it,
      // so pass the options through untouched (no forced open).
      if (typeof this.buildReasoning === "function") {
        block = this.buildReasoning({ reasoning, live: true, hasAnswerText });
        body.insertBefore(block, this.bubble);
      } else {
        block = el("details", { class: "reasoning-block" }, [
          el("summary", {}, ["Thought Process"]),
          el("div", { class: "reasoning-content markdown-body" }),
        ]);
        body.insertBefore(block, this.bubble);
        const content = block.querySelector(".reasoning-content");
        content.innerHTML = html;
        content.dataset.src = html;
      }
    }
    this.reasoningEl = block;
  }
}
