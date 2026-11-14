// Inline record of a web search Bmo ran for a turn: the query it settled on,
// the pages it read, and how long the round trip took. The same card covers
// both phases — placeholder rows while the search is in flight, then the results
// — so it fills in rather than being swapped out under the reader.

import { el } from "../utils.js?v=30";
import { icon } from "../icons.js?v=48";
import { searchOrb } from "./orb.js?v=3";

const COLLAPSED_COUNT = 3;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Freshness matters more than the exact date for search results, so recent
// pages get a relative age and older ones fall back to a plain date.
export function freshness(published) {
  if (!published) return "";
  const then = new Date(published);
  if (isNaN(then.getTime())) return "";

  const now = new Date();
  const days = Math.floor((now - then) / 86_400_000);
  if (days < 0) return "";
  if (days === 0) return "updated today";
  if (days === 1) return "updated yesterday";
  if (days < 30) return `updated ${days} days ago`;

  const opts = then.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };
  return `updated ${then.toLocaleDateString([], opts)}`;
}

function formatElapsed(ms) {
  if (ms == null || !isFinite(ms)) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function resultRow(result) {
  const host = hostOf(result.url);
  const age = freshness(result.published_date);

  const head = [
    el("a", {
      class: "search-result-title",
      href: result.url,
      target: "_blank",
      rel: "noopener noreferrer",
      text: result.title || host || result.url,
    }),
  ];
  if (host) head.push(el("span", { class: "search-result-host", text: host }));
  if (age) head.push(el("span", { class: "search-result-age", text: `· ${age}` }));

  const children = [el("div", { class: "search-result-head" }, head)];
  if (result.snippet) {
    children.push(el("p", { class: "search-result-snippet", text: result.snippet }));
  }
  return el("li", { class: "search-result" }, children);
}

// Note: "pending" rather than the global .skeleton utility, which paints a
// full-width shimmer of its own and would sit behind these bars.
function pendingRow() {
  return el("li", { class: "search-result pending" }, [
    el("div", { class: "search-result-head" }, [el("span", { class: "pending-bar wide" })]),
    el("p", { class: "search-result-snippet" }, [el("span", { class: "pending-bar" })]),
  ]);
}

/**
 * Build the search card.
 * @param {object} opts
 * @param {string} [opts.query] The query Bmo searched for.
 * @param {Array<{title,url,snippet,published_date}>} [opts.results]
 * @param {number|null} [opts.elapsedMs] Round-trip time, shown once finished.
 * @param {boolean} [opts.searching] True while the request is still open.
 */
export function searchCard({ query = "", results = [], elapsedMs = null, searching = false, status = "empty" } = {}) {
  const mark = el("span", { class: "orb-slot" });
  if (searching) {
    mark.append(searchOrb(16));
  } else {
    mark.innerHTML = icon("globe", { width: 15, height: 15 });
  }

  const head = [
    mark,
    el("span", { class: "search-card-title", text: searching ? "Searching" : "Search" }),
  ];
  if (query) {
    head.push(el("span", { class: "search-card-sep", text: "·" }));
    head.push(el("span", { class: "search-card-query", text: `\u201C${query}\u201D` }));
  }

  const list = el("ol", { class: "search-results" });
  const card = el("div", { class: `search-card${searching ? " searching" : ""}` }, [
    el("div", { class: "search-card-head" }, head),
    list,
  ]);

  if (searching) {
    list.append(pendingRow(), pendingRow(), pendingRow());
    return card;
  }

  if (!results.length) {
    list.append(el("li", { class: "search-result empty" }, [
      el("p", { class: "search-result-snippet", text: status === "unavailable" ? "Web search is temporarily unavailable. Current information could not be verified." : "No results came back for this one." }),
    ]));
  }

  for (const r of results.slice(0, COLLAPSED_COUNT)) list.append(resultRow(r));

  const elapsed = formatElapsed(elapsedMs);
  const hidden = results.slice(COLLAPSED_COUNT);

  if (hidden.length) {
    // The toggle is the last item on the trail, so it carries a bullet of its
    // own and the connecting line runs all the way down to it.
    const collapsedLabel = `+ ${hidden.length} more result${hidden.length === 1 ? "" : "s"}`;
    let rows = [];
    const more = el("button", {
      type: "button",
      class: "search-more",
      "aria-expanded": "false",
      text: collapsedLabel,
      onclick: () => {
        const expanded = rows.length === 0;
        more.setAttribute("aria-expanded", String(expanded));
        if (expanded) {
          rows = hidden.map(resultRow);
          for (const row of rows) list.insertBefore(row, foot);
          more.textContent = "Show fewer results";
        } else {
          for (const row of rows) row.remove();
          rows = [];
          more.textContent = collapsedLabel;
        }
      },
    });
    const foot = el("li", { class: "search-result search-foot" }, [
      more,
      ...(elapsed ? [el("span", { class: "search-elapsed", text: elapsed })] : []),
    ]);
    list.append(foot);
  } else if (elapsed) {
    // Nothing left to expand, so the timing stands alone without a bullet.
    card.append(el("div", { class: "search-card-foot" }, [
      el("span", { class: "search-elapsed", text: elapsed }),
    ]));
  }

  return card;
}
