/**
 * Incremental stream splitter for Bmo's streaming renderer.
 *
 * Splits the accumulating response text into BLOCK-LEVEL chunks whose
 * boundaries are stable as the text grows: a chunk, once closed, never
 * changes, so the renderer can freeze its parsed HTML and never touch it
 * again. Only the open tail chunk is re-parsed while tokens arrive.
 *
 * Boundary rules (line-granular, CommonMark-aware):
 *   - An opening code fence (``` / ~~~, indented 0-3 spaces) always starts
 *     a new chunk — fenced code can interrupt paragraphs.
 *   - A closing fence stays GLUED to its code block, which then ENDS:
 *     everything after the fence is ordinary flow and may freeze separately.
 *   - A blank line closes the preceding block — BUT the flush is deferred
 *     until the next non-blank line: if that line continues a container
 *     (a loose list "- a ⏎ ⏎ - b", or "> quoted ⏎ ⏎ > quoted"), the
 *     boundary is cancelled so the container stays whole. Everything else
 *     (new paragraph, heading, table…) commits the split.
 *   - Lines inside a fenced code block OR a multi-line $$…$$ display-math
 *     block are exempt from blank-line splits. Splitting a fence mid-body
 *     freezes the opener alone; later indented lines then parse as their
 *     own CommonMark code blocks (the "many Copy buttons" flash during
 *     HTML/CSS streams).
 *
 * Prefix stability: every decision depends only on lines already seen plus
 * the current line. Appending text can COMMIT a deferred boundary or cancel
 * it before it ever existed — it can never move or remove a committed one.
 * Worst case on unusual nesting is one extra small re-parse; the settled
 * message is always re-rendered canonically from the full text afterwards.
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/;
const QUOTE_RE = /^ {0,3}>/;
const DOLLAR_OPEN_RE = /^\s*\$\$/;

export function splitStreamBlocks(src) {
  const raw = String(src || "");
  const lines = raw.split("\n");
  // The trailing line, while unterminated (no \n yet), is still being typed —
  // its classification ("- " -> "- item") can change, and a decision taken on
  // it now could be contradicted later. Hold it back from ALL boundary
  // decisions and just glue it onto the open tail.
  const hasPartial = raw.length > 0 && !raw.endsWith("\n");
  if (hasPartial) lines.pop();

  const blocks = [];
  let cur = [];
  let inCode = false;       // inside a ``` / ~~~ fence
  let inDollarMath = false; // inside a multi-line $$ … $$ pair
  let pendingBlank = false; // saw a blank line; boundary undecided
  let lastNonBlank = "";    // previous non-blank line (container detection)

  const flush = () => {
    if (cur.length) {
      blocks.push(cur.join("\n"));
      cur = [];
    }
  };

  for (const line of lines) {
    const dollarPairs = (line.match(/\$\$/g) || []).length;

    // ---- fenced code -----------------------------------------------------
    if (!inCode && !inDollarMath && FENCE_RE.test(line)) {
      pendingBlank = false;
      flush();                 // opening fence is always a boundary
      inCode = true;
      cur.push(line);
      lastNonBlank = line;
      continue;
    }
    if (inCode && FENCE_RE.test(line)) {
      inCode = false;
      cur.push(line);          // closer glued to its block…
      flush();                 // …then the chunk ends
      lastNonBlank = line;
      continue;
    }

    // ---- $$ display math ---------------------------------------------------
    if (!inCode && !inDollarMath && DOLLAR_OPEN_RE.test(line)) {
      pendingBlank = false;
      flush();                 // math opener sits at block level
      cur.push(line);
      lastNonBlank = line;
      if (dollarPairs % 2 === 1) inDollarMath = true;
      continue;
    }
    if (inDollarMath) {
      cur.push(line);          // math body: blanks never split here
      if (line.includes("$$")) {
        if (dollarPairs % 2 === 1) {
          inDollarMath = false;
          flush();             // math closed → its chunk ends
        }
        lastNonBlank = line;
      }
      continue;
    }

    // ---- ordinary flow -------------------------------------------------------
    // Fenced code: blanks stay inside the open chunk. Never flush here —
    // freezing mid-fence leaves indented body lines as separate code blocks.
    if (inCode) {
      cur.push(line);
      if (line.trim()) lastNonBlank = line;
      continue;
    }

    if (!line.trim()) {
      pendingBlank = true;     // maybe-boundary; keep the line in the chunk
      cur.push(line);
      continue;
    }

    if (pendingBlank) {
      const continuesContainer =
        (LIST_ITEM_RE.test(line) && LIST_ITEM_RE.test(lastNonBlank)) ||
        (QUOTE_RE.test(line) && QUOTE_RE.test(lastNonBlank));
      if (!continuesContainer) flush(); // commit the boundary before this line
      pendingBlank = false;
    }

    cur.push(line);
    lastNonBlank = line;
  }
  // The open construct (code fence / $$ math / undecided blank boundary) plus
  // any partial trailing line stay TOGETHER as the one unfrozen tail chunk —
  // freezing them apart would let a later token change already-frozen text.
  if (hasPartial) {
    cur.push(raw.slice(raw.lastIndexOf("\n") + 1));
  }
  flush();
  return blocks;
}
