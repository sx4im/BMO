/**
 * ScrollFollower — permanent scroll-followership for the chat stream.
 *
 * Owns the "am I pinned to the bottom?" state for the MessageFeed's whole
 * life (not just while a response streams):
 *
 *   - While PINNED, any content growth keeps the view glued to the bottom.
 *     The feed calls notifyContentAppended() after it adds messages.
 *   - The moment the user scrolls up beyond PIN_THRESHOLD, the pin detaches
 *     and the jump-to-latest BUTTON appears — whether or not a response is
 *     being generated. Scrolling back to the bottom (or tapping the button)
 *     re-attaches the pin and hides the button.
 *   - CSS anchors the button to .composer-wrap, so it stays centred above
 *     the input as drafts, attachments, or viewport dimensions change.
 *
 * This used to live inside StreamingRenderer, which made scroll-up support
 * exist only during generation — a lifecycle bug. Follow-ship belongs to the
 * feed; the renderer merely asks the follower to chase the bottom while it
 * paints tokens.
 */

const PIN_THRESHOLD = 140; // px above the bottom that still counts as "at the bottom"

export class ScrollFollower {
  /** @param {HTMLElement} scroller the .chat-stream element */
  constructor(scroller) {
    this.scroller = scroller;
    this.pinned = true;
    this.button = null;

    this._lastTop = typeof scroller?.scrollTop === "number" ? scroller.scrollTop : null;
    this._lastHeight = typeof scroller?.scrollHeight === "number" ? scroller.scrollHeight : null;
    this._lastViewport = typeof scroller?.clientHeight === "number" ? scroller.clientHeight : null;

    this._onScroll = () => {
      const el = this.scroller;
      if (!el) return;
      // Two rules keep user intent and layout noise apart:
      //  1. Only a genuine USER upward scroll may detach the pin — and a
      //     gesture NEVER coincides with a layout-dimension change. When
      //     content is written/removed (feed re-render, images loading) the
      //     browser clamps scrollTop and fires a scroll event that looks
      //     exactly like an upward drag; treating it as one silently killed
      //     auto-scroll for the whole response. Viewport resizes (soft
      //     keyboard, mobile URL bar, scroll-anchoring reflows) play the
      //     same trick through clientHeight, so BOTH dimensions are
      //     watched: churn in either means the event is layout noise,
      //     never a drag.
      //  2. Re-pin happens ONLY on arrival at bottom, so a user gliding down
      //     manually is never teleported mid-scroll.
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD;
      const heightChanged =
        this._lastHeight != null &&
        Math.abs(el.scrollHeight - this._lastHeight) > 1;
      const viewportChanged =
        this._lastViewport != null &&
        Math.abs(el.clientHeight - this._lastViewport) > 1;
      const goingUp = !heightChanged && !viewportChanged &&
        this._lastTop != null && el.scrollTop < this._lastTop - 1;

      if (atBottom) {
        if (!this.pinned) this.attach();
      } else if (goingUp && this.pinned) {
        this.detach();
      }
      // Everything else (downward drift, clamps, resizes): state untouched.
      this._lastTop = el.scrollTop;
      this._lastHeight = el.scrollHeight;
      this._lastViewport = el.clientHeight;
    };
  }

  mount() {
    if (this._mounted) return;
    this._mounted = true;
    this.scroller.addEventListener("scroll", this._onScroll, { passive: true });
  }

  unmount() {
    if (!this._mounted) return;
    this._mounted = false;
    this.scroller.removeEventListener("scroll", this._onScroll);
    this.removeButton();
  }

  attach() {
    this.pinned = true;
    this.removeButton();
    this.chase();
  }

  detach() {
    this.pinned = false;
    this._showButton();
  }

  /** Snap to the bottom (only when pinned). Called by painters. */
  chase() {
    if (!this.pinned) return;
    const el = this.scroller;
    if (el) el.scrollTop = el.scrollHeight;
  }

  /** Force-scroll to the bottom and re-pin (the button's action). */
  jumpToBottom() {
    const el = this.scroller;
    if (!el) return;
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else {
      el.scrollTop = el.scrollHeight; // older browsers / test environments
    }
    this.attach();
  }

  /** The feed added settled messages / swapped the streaming bubble. */
  notifyContentAppended() {
    this.chase();
  }

  _page() {
    return this.scroller.closest(".chat-page");
  }

  _showButton() {
    if (this.button?.isConnected || !this._mounted) return;
    const page = this._page() || document.body; // page context preferred; body fallback
    const b = document.createElement("button");
    b.type = "button";
    b.className = "stream-jump-pill";
    b.setAttribute("aria-label", "Jump to latest");
    b.innerHTML =
      `<span class="pill-ic"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ` +
      `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ` +
      `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
      `<path d="m6 9 6 6 6-6"/></svg></span>`;
    b.addEventListener("click", () => this.jumpToBottom());
    this.button = b;
    (page.querySelector(".composer-wrap") || page).append(b);
  }

  removeButton() {
    this.button?.remove();
    this.button = null;
  }
}
