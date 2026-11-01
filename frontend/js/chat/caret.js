// Bmo — live-streaming caret policy (single source of truth).
//
// The streaming bubble shows AT MOST ONE caret: a single orange ▋ at the
// very end of the newest text. Nothing else in any block ever renders one.
// The typewriter pacing layer may hold back characters; the caret always
// sits at the RENDERED edge, so it doubles as the pacing indicator.

export const CARET_HTML = '<span class="cursor">▋</span>';

/**
 * Strip every stray inline caret from rendered markdown HTML. Handles:
 *  - raw spans:            <span class="cursor">▋</span>
 *  - entity-escaped forms: &lt;span class="cursor"&gt;▋&lt;/span&gt;
 *    (produced when a caret leaks into fenced code and gets re-escaped)
 *  - bare glyphs:          ▋ / █ that arrived inside the model's text itself
 */
export function stripStrayCursors(html) {
  if (!html || (html.indexOf("▋") === -1 && html.indexOf("█") === -1)) return html;
  return String(html)
    .replace(/<span class="cursor"[^>]*>▋<\/span>/g, "")
    .replace(/&(amp;)?lt;span( &(amp;)?gt;| class=(\&quot;|"|")cursor(\&quot;|"|"))[^&]*&(amp;)?gt;▋&(amp;)?lt;\/span&(amp;)?gt;/g, "")
    .replace(/▋/g, "")
    .replace(/█/g, "");
}
