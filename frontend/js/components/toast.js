import { $, el } from "../utils.js?v=52";
import { icon } from "../icons.js?v=77";

// Claude-style: outlined status glyphs (no filled badge circle).
const ICONS = {
  success: "checkCircle",
  error: "xCircle",
  warning: "alert",
  info: "info",
};

export function toast(message, { tone = "info", duration = 2000 } = {}) {
  const container = $("#toast-container");
  if (!container) return;

  const node = el("div", { class: `toast ${tone}`, role: "status" }, [
    el("div", { class: "icon", html: icon(ICONS[tone] || "info", { width: 16, height: 16 }) }),
    el("div", { class: "body", text: message }),
  ]);

  const remove = () => {
    node.style.transition = "opacity 180ms ease, transform 180ms ease";
    node.style.opacity = "0";
    node.style.transform = "translateY(-8px) scale(0.96)";
    setTimeout(() => node.remove(), 200);
  };

  container.appendChild(node);
  if (duration > 0) setTimeout(remove, duration);
}
