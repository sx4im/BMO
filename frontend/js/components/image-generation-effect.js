const MAX_ANIMATION_MS = 12000;

if (typeof customElements !== "undefined" && !customElements.get("bmo-image-generation")) {
  customElements.define("bmo-image-generation", class extends HTMLElement {
    async connectedCallback() {
      const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
      const lifecycle = this.lifecycle = new AbortController();
      const { signal } = lifecycle;
      const age = Date.now() - Number(this.dataset.startedAt);
      const remaining = MAX_ANIMATION_MS - (Number.isFinite(age) ? Math.max(0, age) : 0);
      let expired = false;
      let syncPlayback;
      const stopMotion = () => {
        expired = true;
        this.querySelector("thinking-orb")?.setAttribute("paused", "");
        syncPlayback?.();
        this.dispatchEvent(new Event("animationtimeout"));
      };
      const fallback = this.querySelector("thinking-orb");
      fallback?.removeAttribute("paused");
      if (remaining <= 0) {
        stopMotion();
        return;
      }
      const animationTimer = setTimeout(stopMotion, remaining);
      signal.addEventListener("abort", () => clearTimeout(animationTimer), { once: true });
      if (motion.matches) return;

      const resources = new AbortController();
      signal.addEventListener("abort", () => resources.abort(), { once: true });
      let canvas;
      try {
        const engine = await import("../vendor/img-fx/engine.js?v=1");
        if (signal.aborted || motion.matches || expired) return;

        const presets = engine.PRESETS["pixels-mechanic"].modes;
        const root = document.documentElement;
        const preset = () => presets[root.dataset.theme === "dark" ? "dark" : "light"];
        const { clientWidth, clientHeight } = this;
        canvas = document.createElement("canvas");
        this.append(canvas);
        const instance = engine.createInstance({ canvas, cssWidth: clientWidth, cssHeight: clientHeight, preset: preset() });

        resources.signal.addEventListener("abort", () => {
          engine.destroyInstance(instance);
          canvas.remove();
        }, { once: true });
        const size = new ResizeObserver(() => {
          engine.updateInstanceSize(instance, this.clientWidth, this.clientHeight);
        });
        const visibility = new IntersectionObserver(([entry]) => {
          engine.setInstanceVisible(instance, entry.isIntersecting);
        });
        const theme = new MutationObserver(() => engine.setInstancePreset(instance, preset()));
        syncPlayback = () => engine.setInstancePaused(instance, expired || document.hidden || motion.matches);
        resources.signal.addEventListener("abort", () => {
          size.disconnect();
          visibility.disconnect();
          theme.disconnect();
        }, { once: true });
        size.observe(this);
        visibility.observe(this);
        theme.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
        document.addEventListener("visibilitychange", syncPlayback, { signal: resources.signal });
        motion.addEventListener("change", syncPlayback, { signal: resources.signal });
        syncPlayback();
        fallback?.remove();
      } catch {
        syncPlayback = null;
        resources.abort();
        canvas?.remove();
      }
    }

    disconnectedCallback() {
      this.lifecycle?.abort();
    }
  });
}
