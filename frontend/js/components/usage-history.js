import { el, clear } from "../utils.js?v=30";
import { getUsageHistory } from "../api.js?v=31";

// Native SVG adaptation of the EasyUI interactive area-chart design:
// https://github.com/Surajmaurya1/easyui/blob/main/src/components/registry/previews/items/interactive-area-chart.tsx
const models = { thinking: "Stanza", deep: "Nexos", image: "Images", aeon: "Voice", other: "Other" };
const dateLabel = value => new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const number = new Intl.NumberFormat();
const shiftDate = (value, offset) => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};
function svgNode(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

export function usageHistory(token) {
  let days = 30, end = new Date().toISOString().slice(0, 10), data = null, sequence = 0, disposed = false;
  const today = end;
  const status = el("p", { class: "usage-history-status", role: "status" });
  const period = el("span", { class: "usage-history-period" });
  const plot = el("div", { class: "usage-history-plot", hidden: true });
  const legend = el("div", { class: "usage-history-legend" });
  const filters = el("div", { class: "seg-control", role: "group", "aria-label": "Usage history period" });
  for (const value of [7, 30]) filters.append(el("button", {
    class: `seg-btn ${days === value ? "active" : ""}`, type: "button", text: `${value}d`,
    "aria-pressed": String(days === value), onclick: () => {
      if (days === value) return;
      days = value;
      for (const button of filters.children) {
        const active = button.textContent === `${days}d`;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      }
      load();
    },
  }));
  const model = el("select", { class: "usage-history-select", "aria-label": "Filter usage by model", onchange: () => draw() }, [
    el("option", { value: "all", text: "All models" }),
    ...Object.entries(models).map(([value, text]) => el("option", { value, text })),
  ]);
  const previous = el("button", { class: "btn secondary usage-history-arrow", type: "button", text: "‹", "aria-label": "Previous period", onclick: () => { end = shiftDate(end, -days); load(); } });
  const next = el("button", { class: "btn secondary usage-history-arrow", type: "button", text: "›", "aria-label": "Next period", onclick: () => { end = [today, shiftDate(end, days)].sort()[0]; load(); } });
  const card = el("section", { class: "settings-card glass usage-history" }, [
    el("div", { class: "section-title" }, [el("h2", { text: "Usage history" })]),
    el("p", { class: "field-hint usage-history-hint", text: "Daily usage across your models, using the same weights as your plan. Dates in UTC." }),
    el("div", { class: "usage-history-controls" }, [filters, model]),
    el("div", { class: "usage-history-range" }, [period, el("div", { class: "usage-history-navigation" }, [previous, next])]),
    status, plot, legend,
  ]);

  function draw() {
    if (!data || disposed) return;
    clear(plot); clear(legend);
    const values = data.points.map(point => model.value === "all" ? point.total : point.models[model.value] || 0);
    const peak = Math.max(1, ...values);
    const x = index => index * 800 / (values.length - 1);
    const y = index => 170 - values[index] / peak * 150;
    const svg = svgNode("svg", { viewBox: "0 0 800 180", preserveAspectRatio: "none", tabindex: "0", role: "img", "aria-label": "Daily usage chart. Use left and right arrow keys to explore each day." });
    for (const height of [20, 95, 170]) svg.append(svgNode("line", { x1: 0, x2: 800, y1: height, y2: height, class: "usage-history-gridline" }));
    const line = values.map((value, index) => `${index ? "L" : "M"}${x(index)},${y(index)}`).join(" ");
    svg.append(svgNode("path", { d: `${line} L800,170 L0,170 Z`, class: "usage-history-area" }));
    svg.append(svgNode("path", { d: line, class: "usage-history-line", "vector-effect": "non-scaling-stroke" }));
    const crosshair = svgNode("line", { y1: 0, y2: 180, class: "usage-history-crosshair", visibility: "hidden" });
    const dot = svgNode("circle", { r: 4, class: "usage-history-dot", visibility: "hidden", "vector-effect": "non-scaling-stroke" });
    svg.append(crosshair, dot);
    const tooltip = el("div", { class: "usage-history-tooltip", role: "status", hidden: true });
    const canvas = el("div", { class: "usage-history-canvas" }, [svg, tooltip]);
    let selected = values.length - 1;
    const select = index => {
      selected = Math.max(0, Math.min(values.length - 1, index));
      const point = data.points[selected];
      tooltip.textContent = `${dateLabel(point.date)} · ${number.format(values[selected])} units`;
      tooltip.hidden = false;
      // Keep the tooltip readable at either edge, including narrow mobile cards.
      tooltip.style.left = `${Math.max(0, Math.min(100, selected / (values.length - 1) * 100))}%`;
      tooltip.style.transform = `translateX(-${selected < values.length / 3 ? 0 : selected > values.length * 2 / 3 ? 100 : 50}%)`;
      crosshair.setAttribute("x1", x(selected)); crosshair.setAttribute("x2", x(selected)); crosshair.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x(selected)); dot.setAttribute("cy", y(selected)); dot.setAttribute("visibility", "visible");
    };
    svg.addEventListener("pointermove", event => {
      const rect = svg.getBoundingClientRect();
      select(Math.round((event.clientX - rect.left) / rect.width * (values.length - 1)));
    });
    svg.addEventListener("pointerdown", event => {
      const rect = svg.getBoundingClientRect();
      select(Math.round((event.clientX - rect.left) / rect.width * (values.length - 1)));
    });
    const hide = () => { tooltip.hidden = true; crosshair.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
    svg.addEventListener("pointerleave", hide);
    svg.addEventListener("blur", hide);
    svg.addEventListener("focus", () => select(selected));
    svg.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      select(event.key === "Home" ? 0 : event.key === "End" ? values.length - 1 : selected + (event.key === "ArrowLeft" ? -1 : 1));
    });
    plot.append(el("div", { class: "usage-history-yaxis", "aria-hidden": "true" }, [
      el("span", { text: compact.format(peak) }), el("span", { text: compact.format(peak / 2) }), el("span", { text: "0" }),
    ]), canvas, el("div", { class: "usage-history-xaxis", "aria-hidden": "true" }, [
      ...[0, Math.floor(values.length / 2), values.length - 1].map(index => el("span", { text: dateLabel(data.points[index].date) })),
    ]));
    const total = Object.values(data.totals).reduce((sum, value) => sum + value, 0);
    for (const [key, label] of Object.entries(models)) {
      const amount = data.totals[key] || 0;
      if (!amount && key !== "thinking" && key !== "deep") continue;
      legend.append(el("div", { class: `usage-history-stat usage-model-${key}` }, [
        el("span", { text: label }), el("strong", { text: total ? `${number.format(Math.round(amount / total * 1000) / 10)}%` : "0%" }),
      ]));
    }
    status.textContent = values.some(Boolean) ? "" : "No usage in this period.";
    plot.hidden = false;
  }

  async function load() {
    const request = ++sequence;
    data = null;
    status.textContent = "Loading usage history…";
    plot.hidden = true; clear(legend);
    period.textContent = `${dateLabel(shiftDate(end, 1 - days))} – ${dateLabel(end)}, ${end.slice(0, 4)}`;
    previous.disabled = next.disabled = true;
    try {
      const result = await getUsageHistory(token, { days, end });
      if (disposed || request !== sequence) return;
      data = result;
      draw();
    } catch {
      if (disposed || request !== sequence) return;
      clear(status);
      status.append(document.createTextNode("Could not load usage history. "), el("button", { type: "button", class: "usage-history-retry", text: "Try again", onclick: load }));
    } finally {
      if (!disposed && request === sequence) {
        previous.disabled = false;
        next.disabled = end >= today;
      }
    }
  }
  load();
  return { card, destroy: () => { disposed = true; sequence++; } };
}
