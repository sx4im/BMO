// Markdown rendering for BMO's assistant messages.
//
// The heavy libraries (marked, marked-highlight, highlight.js, DOMPurify,
// KaTeX) are LAZY-loaded from an ESM CDN via dynamic import() rather than
// static top-level imports. That keeps them OUT of the app's boot module
// graph, so the shell + composer paint immediately instead of waiting on
// ~hundreds of KB of CDN JS — the cause of the long blank screen on mobile /
// cold caches. They start downloading in the background the moment this module
// is imported; until they're ready, renderMarkdown() returns a safe escaped
// plain-text fallback, and registered callbacks (whenMarkdownReady) re-render
// to upgrade it once the libraries land.

import { icon } from "../icons.js?v=30";
import { escapeHtml } from "../utils.js?v=30";

const CDN = {
  marked: "https://esm.sh/marked@13",
  markedHighlight: "https://esm.sh/marked-highlight@2",
  hljs: "https://esm.sh/highlight.js@11.10.0",
  dompurify: "https://esm.sh/dompurify@3.1.7",
  katex: "https://esm.sh/katex@0.16",
};
const KATEX_CSS = "https://esm.sh/katex@0.16/dist/katex.min.css";

let lib = null;           // { marked, hljs, DOMPurify, katex } once loaded
let loadPromise = null;   // in-flight load
const readyCbs = [];      // fired once, when the libraries become available
let codeCopyBound = false;

// One delegated listener handles copy clicks for every code block, including
// blocks that appear later via streaming re-renders. Bound once, lazily.
function ensureCodeCopyHandler() {
  if (codeCopyBound) return;
  codeCopyBound = true;
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest(".code-copy");
    if (!btn) return;
    const code = btn.closest(".code-block")?.querySelector("pre code");
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent || "");
      if (btn._copyTimeout) clearTimeout(btn._copyTimeout);
      btn.classList.add("copied");
      btn.setAttribute("aria-label", "Copied");
      btn.innerHTML = `${icon("check", { width: 13, height: 13 })}<span class="code-copy-label">Copied</span>`;
      btn._copyTimeout = setTimeout(() => {
        btn.classList.remove("copied");
        btn.setAttribute("aria-label", "Copy code");
        btn.innerHTML = `${icon("copy", { width: 13, height: 13 })}<span class="code-copy-label">Copy</span>`;
        btn._copyTimeout = null;
      }, 1400);
    } catch {
      /* clipboard unavailable — ignore */
    }
  });
}

// Inject KaTeX's stylesheet only once the math library is actually in use.
// Kept out of index.html so it never render-blocks the initial paint.
function injectKatexCss() {
  if (document.querySelector("link[data-katex-css]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = KATEX_CSS;
  link.setAttribute("data-katex-css", "");
  document.head.appendChild(link);
}

/**
 * Load the markdown/highlight/math libraries in the background. Idempotent —
 * returns the same promise on every call. Resolves to the `lib` bag.
 */
export function ensureMarkdown() {
  if (loadPromise) return loadPromise;
  loadPromise = Promise.all([
    import(CDN.marked),
    import(CDN.markedHighlight),
    import(CDN.hljs),
    import(CDN.dompurify),
    import(CDN.katex),
  ])
    .then(([m, mh, hl, dp, kt]) => {
      const marked = m.marked || m.default;
      const markedHighlight = mh.markedHighlight || mh.default;
      const hljs = hl.default || hl;
      const DOMPurify = dp.default || dp;
      const katex = kt.default || kt;

      marked.use(
        markedHighlight({
          langPrefix: "hljs language-",
          highlight(code, lang) {
            const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
            try {
              return hljs.highlight(code, { language, ignoreIllegals: true }).value;
            } catch {
              return code;
            }
          },
        })
      );
      marked.setOptions({ gfm: true, breaks: false });

      injectKatexCss();
      ensureCodeCopyHandler();
      lib = { marked, hljs, DOMPurify, katex };
      for (const cb of readyCbs.splice(0)) {
        try { cb(); } catch { /* a re-render callback must never break loading */ }
      }
      return lib;
    })
    .catch((err) => {
      // Don't re-throw: nobody awaits this, and the app stays usable on the
      // escaped plain-text fallback. Reset so a later render can retry.
      console.error("markdown libraries failed to load", err);
      loadPromise = null;
      return null;
    });
  return loadPromise;
}

/**
 * Run `cb` once the markdown libraries are ready (immediately if already
 * loaded). Used by the chat page to re-render messages that were first shown
 * with the plain-text fallback, so they upgrade to full markdown.
 */
export function whenMarkdownReady(cb) {
  if (lib) { cb(); return; }
  readyCbs.push(cb);
  ensureMarkdown();
}

// Start downloading immediately, but DO NOT block module evaluation on it.
ensureMarkdown();

// Pull a friendly language name out of the highlight.js class list, e.g.
// "hljs language-python" -> "python". Returns "" for unlabeled blocks.
function langFromClass(cls) {
  const m = /language-([\w+-]+)/.exec(cls || "");
  if (!m || m[1] === "plaintext") return "";
  return m[1];
}

// Wrap marked's `<pre><code>` output in a card with a header bar that carries
// the language label and a copy button (top-right). Applied after sanitize so
// the injected control markup is our own trusted HTML.
function decorateCodeBlocks(html) {
  html = html.replace(
    /<pre><code(\s+class="([^"]*)")?>/g,
    (_match, attr, cls) => {
      const lang = langFromClass(cls);
      const copyBtn =
        `<button type="button" class="code-copy" aria-label="Copy code">` +
        `${icon("copy", { width: 13, height: 13 })}` +
        `<span class="code-copy-label">Copy</span></button>`;
      const head =
        `<div class="code-block-head">` +
        `<span class="code-lang">${lang}</span>${copyBtn}</div>`;
      return `<div class="code-block">${head}<pre><code${attr || ""}>`;
    }
  );
  return html.replace(/<\/code><\/pre>/g, "</code></pre></div>");
}

// ---------------------------------------------------------------------------
// Leaked highlight.js markup scrub.
//
// The upstream model sometimes pastes PRE-RENDERED highlight.js output into
// its code fences instead of plain source:
//   raw form:     <span class="hljs-keyword">int</span>
//   escaped form: &lt;span class=&quot;hljs-keyword&quot;&gt;int&lt;/span&gt;
// If rendered as-is, marked escapes it again and the user sees literal span
// tags. hljs also entity-escapes the code itself (&lt;iostream&gt;), so once
// a leak is proven every remaining entity is decoded back to source chars.
// Runs on every render, which also heals old messages already stored with
// leaked markup. Mirrors backend nvidia_client._strip_leaked_highlight_spans.
// ---------------------------------------------------------------------------
const HLJS_SPAN_RE = /<\/?span\b[^>]*>/gi;
const HLJS_ESCAPED_SPAN_RE = /&(?:amp;|)lt;(?:amp;|)\s*span\b/i;

function decodeEntities(text) {
  const el = document.createElement("textarea");
  el.innerHTML = text;
  return el.value;
}

function stripLeakedHighlightSpans(text) {
  if (!text || (text.toLowerCase().indexOf("span") === -1 && text.indexOf("&") === -1)) {
    return text;
  }
  let leaked = false;
  let prev = null;
  while (prev !== text) {
    prev = text;
    const stripped = text.replace(HLJS_SPAN_RE, "");
    if (stripped !== text) {
      text = stripped;          // removed a raw <span ...> layer
      leaked = true;
      continue;
    }
    if (HLJS_ESCAPED_SPAN_RE.test(text)) {
      text = decodeEntities(text); // reveal an entity-escaped layer
      leaked = true;
      continue;
    }
    break;
  }
  if (!leaked) return text;
  // Decode whatever the highlighter escaped inside the leaked markup.
  return decodeEntities(text);
}

// Re-exported for consumers that handle raw message text outside the render
// path (e.g. export.js building downloadable documents).
export { stripLeakedHighlightSpans };

const BLOCK_PREFIX = "MATHBLOCK_";
const INLINE_PREFIX = "MATHINLINE_";
const SUFFIX = "_END";

/**
 * Extract LaTeX math from raw markdown, replacing it with unique
 * placeholders so `marked` doesn't try to interpret the LaTeX as markdown.
 * After parsing + sanitisation we swap the placeholders for KaTeX HTML.
 *
 * Delimiters:
 *   $$ ... $$   → display (block) math
 *   \[ ... \]   → display (block) math
 *   $ ... $     → inline math (padding spaces allowed, e.g. "$ x^2 $")
 *   \( ... \)   → inline math
 */
// Map of bare LaTeX commands the model sometimes emits OUTSIDE math
// delimiters (e.g. "a \neq 0" or "x \to y") to their Unicode glyph, so they
// at least render as the correct symbol instead of showing the raw backslash
// command. Applied only to text outside $…$ / code (handled by ordering).
const BARE_LATEX_GLYPH = {
  "\\neq": "≠", "\\ne": "≠", "\\leq": "≤", "\\le": "≤", "\\geq": "≥", "\\ge": "≥",
  "\\to": "→", "\\rightarrow": "→", "\\Rightarrow": "⇒", "\\leftarrow": "←",
  "\\implies": "⇒", "\\in": "∈", "\\notin": "∉", "\\times": "×", "\\div": "÷",
  "\\pm": "±", "\\cdot": "·", "\\infty": "∞", "\\approx": "≈", "\\equiv": "≡",
  "\\sum": "∑", "\\int": "∫", "\\sqrt": "√", "\\Rightarrow ": "⇒",
};

function extractMath(text) {
  const blocks = [];
  const inlines = [];

  const pushBlock = (latex) => {
    const key = `${BLOCK_PREFIX}${blocks.length}${SUFFIX}`;
    blocks.push({ latex: latex.trim(), key });
    return key;
  };
  const pushInline = (latex) => {
    const key = `${INLINE_PREFIX}${inlines.length}${SUFFIX}`;
    inlines.push({ latex: latex.trim(), key });
    return key;
  };

  // 1) Block math: $$ ... $$ (greedy, multiline)
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, inner) => pushBlock(inner));

  // 1b) Block math: \[ ... \]
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner) => pushBlock(inner));

  // 2) Inline math: \( ... \)
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner) => pushInline(inner));

  // 3) Inline math: $ ... $
  //    Padding spaces inside the delimiters ARE allowed (the model emits
  //    "$ x^2 + 1 $"). The OPENING $ may be glued to a word so chemistry
  //    subscripts like "CO$_2$" / "RuBisCO$_2$" render — we only forbid a
  //    preceding $ (which would be the tail of a $$ block). The closing $
  //    must not be followed by a word char or $, and the currency heuristic
  //    below keeps real prices ("$5 to $10") as plain text.
  text = text.replace(
    /(?<!\$)\$(?!\$)([^$\n]+?)\$(?![\w$])/g,
    (match, inner) => {
      const trimmed = inner.trim();
      if (!trimmed) return match;
      // Skip strings that look like a currency amount spanning two $ signs,
      // e.g. "$5 to $10" — there the text between the dollar signs is a plain
      // sentence, not math. We treat it as a price ONLY when it's digits with
      // optional thousands/decimals AND contains a space or letter (real
      // prose), so genuine single-symbol math like "$0$" or "$5$" still
      // renders. A lone number with no spaces is almost always math here.
      if (/^\d[\d,]*(?:\.\d+)?\s+\w/.test(trimmed)) return match;
      return pushInline(trimmed);
    }
  );

  // 4) Any LaTeX command still sitting in the PROSE (the model forgot the
  //    $…$) — swap it for its Unicode glyph so it renders as the right symbol
  //    instead of a literal "\neq". Real math placeholders are already keys by
  //    now, so this only touches un-delimited leftovers. Crucially, mask out
  //    fenced/inline code first so a "\to" inside a code sample (or pasted
  //    LaTeX source) is never altered, then restore it untouched.
  const codeSpans = [];
  text = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g, (m) => {
    codeSpans.push(m);
    return `CODE${codeSpans.length - 1}`;
  });
  text = text.replace(/\\[a-zA-Z]+/g, (cmd) => BARE_LATEX_GLYPH[cmd] || cmd);
  text = text.replace(/CODE(\d+)/g, (_m, i) => codeSpans[Number(i)] ?? _m);

  return { text, blocks, inlines };
}

// Render \neq / \ne as a single Unicode relation glyph instead of KaTeX's
// composite "=" + \not overlay. The overlay is drawn as an absolutely-positioned
// slash that gets clipped/displaced when any ancestor sets overflow, producing a
// stray "/" next to the "=". The macro sidesteps that entirely (katex#2109).
const KATEX_MACROS = {
  "\\neq": "\\mathrel{\\char`≠}",
  "\\ne": "\\mathrel{\\char`≠}",
};

// Normalize common LaTeX variants before KaTeX sees them (e.g. "\not=" → "\neq").
function normalizeLatex(latex) {
  return latex
    .replace(/\\not\s*=/g, "\\neq")
    .replace(/\\ne(?!q)\b/g, "\\neq");
}

function renderKatex(katex, latex, displayMode) {
  return katex.renderToString(normalizeLatex(latex), {
    displayMode,
    throwOnError: false,
    strict: false,
    macros: KATEX_MACROS,
  });
}

function restoreMath(html, blocks, inlines) {
  const katex = lib.katex;
  // NOTE: this runs AFTER DOMPurify, so every fallback string interpolated
  // here must be escaped — raw latex is user/model-controlled content.
  // Block math. Wrap in a scroll container — never put overflow on .katex itself
  // or overlay glyphs (\neq, \frac, \sqrt) break into separate pieces.
  for (const { latex, key } of blocks) {
    try {
      const rendered = renderKatex(katex, latex, true);
      html = html.replace(key, () => `<div class="math-display-wrap">${rendered}</div>`);
    } catch {
      html = html.replace(key, () => `<pre>$$${escapeHtml(latex)}$$</pre>`);
    }
  }

  // Inline math
  for (const { latex, key } of inlines) {
    try {
      const rendered = renderKatex(katex, latex, false);
      html = html.replace(key, () => `<span class="math-inline-wrap">${rendered}</span>`);
    } catch {
      html = html.replace(key, () => `$${escapeHtml(latex)}$`);
    }
  }

  return html;
}

// Safe, readable rendering used while the libraries are still loading. Escapes
// all HTML and preserves the author's line breaks — never raw, never unsafe.
function plainFallback(content) {
  return `<div style="white-space:pre-wrap">${escapeHtml(String(content))}</div>`;
}

export function renderMarkdown(content) {
  if (!content) return "";
  // Scrub leaked highlight.js markup BEFORE markdown parsing — heals both
  // live streams and legacy rows already stored with the pollution.
  content = stripLeakedHighlightSpans(String(content));
  if (!content) return "";
  if (!lib) {
    ensureMarkdown(); // kick/keep the background load going
    return plainFallback(content);
  }
  try {
    const { text, blocks, inlines } = extractMath(String(content));
    let html = lib.DOMPurify.sanitize(lib.marked.parse(text));
    // Wrap each <table> in a horizontally-scrollable container.
    html = html.replace(/<table([^>]*)>/g, '<div class="md-table-wrap"><table$1>');
    html = html.replace(/<\/table>/g, "</table></div>");
    // Add a header bar with language label + copy button to each code block.
    html = decorateCodeBlocks(html);
    html = restoreMath(html, blocks, inlines);
    return html;
  } catch {
    return plainFallback(content);
  }
}
