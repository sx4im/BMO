// FileIcon — one component for every file-type icon in the app.
// (<FileIcon ext="pdf" size={24} /> expressed in this codebase's idiom as FileIcon(ext, size))
//
// Design: a thin outlined page with a fold line, a one-color accent glyph, and a
// small tinted extension pill. Page fill and border come from the theme tokens
// (--input-bar / --hairline-strong) so the icon adapts to light and dark mode;
// the glyph, pill tint and pill label use the per-type accent color.
//
// Each function returns a complete SVG string. Use via
// `el("span", { html: FileIcon(ext, 16) })`.

const GLYPH_FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

// Per-type accent colors (sampled from the file-type reference image).
const ACCENTS = {
  pdf: "#f42a2a",
  pptx: "#ff600c",
  csv: "#0aa563",
  md: "#2861ee",
  txt: "#6d6f7b",
  json: "#e79203",
};

// Extension aliases resolved to a known type.
const ALIASES = {
  ppt: "pptx",
  markdown: "md",
  text: "txt",
  jsonl: "json",
  tsv: "csv",
};

// Neutral gray for extensions the app does not know.
const FALLBACK_GRAY = "#9aa0a6";

function resolveType(ext) {
  const e = String(ext || "").trim().replace(/^\.+/, "").toLowerCase();
  if (ACCENTS[e]) return e;
  if (ALIASES[e]) return ALIASES[e];
  return null;
}

// One-color glyph per type, drawn in the page's upper area (x centered on 12,
// roughly y 7.5–13.5). Glyphs are simplified versions of the reference image:
// Acrobat-style squiggle, bar chart in a frame, data grid, "M↓", text lines,
// curly braces.
function glyph(type, accent) {
  const stroke = `stroke="${accent}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  switch (type) {
    case "pdf":
      // Acrobat-style squiggle (adapted from the previous pdf icon's path).
      return `<g transform="translate(2,-1)" stroke="${accent}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M9.8 11.5c.3 1.3 1.3 2.9 2.5 3.4.4.2.8.2 1 .1.3-.2.3-.6.1-1-.4-.8-1.5-1.5-3.6-2.5zm0 0c-.8-1.2-1.3-2.6-1.1-3.2.1-.3.4-.5.7-.5.5 0 .8.8.4 2.2zm0 0c-1.3.8-3.1 1.6-4 1.7-.4.1-.6.3-.6.6 0 .4.4.7 1 .7 1 0 2.3-.9 3.6-2.5z"/></g>`;
    case "pptx":
      return `<rect x="7.6" y="8" width="8.8" height="5.4" rx="1" ${stroke}/><path d="M9.7 12v-1.4M12 12V9.8M14.3 12V8.8" ${stroke}/>`;
    case "csv":
      return `<rect x="7.6" y="8" width="8.8" height="5.4" rx="1" ${stroke}/><path d="M7.6 9.8h8.8M7.6 11.6h8.8M11.4 8v5.4" ${stroke} stroke-width="1.1"/>`;
    case "md":
      return `<text x="8.9" y="12.6" font-family="${GLYPH_FONT}" font-size="6" font-weight="800" fill="${accent}" text-anchor="middle">M</text><path d="M15.2 8.6v3.6M13.5 10.5l1.7 1.7 1.7-1.7" ${stroke}/>`;
    case "txt":
      return `<path d="M8.2 9h7.6M8.2 11.2h5.4M8.2 13.4h7.6" ${stroke}/>`;
    case "json":
      return `<text x="12" y="13.2" font-family="${GLYPH_FONT}" font-size="7" font-weight="700" fill="${accent}" text-anchor="middle" letter-spacing="1">{ }</text>`;
    default:
      // Neutral fallback: plain document lines.
      return `<path d="M8.2 9h7.6M8.2 11.2h5.4M8.2 13.4h7.6" ${stroke}/>`;
  }
}

/**
 * FileIcon(ext, size) → SVG string.
 * ext: file extension, with or without a leading dot ("pdf", ".PDF", "jsonl" …).
 *      Aliases: ppt→pptx, markdown→md, text→txt, jsonl→json, tsv→csv.
 *      Anything else gets the neutral gray fallback with the raw ext in the pill.
 * size: rendered width/height in px (default 24).
 */
export function FileIcon(ext, size = 24) {
  const type = resolveType(ext);
  const accent = type ? ACCENTS[type] : FALLBACK_GRAY;
  const pillTint = `${accent}26`; // ~15% alpha over the page
  const label = (type ? type : String(ext || "").trim().replace(/^\.+/, "") || "?")
    .toUpperCase()
    .slice(0, 5);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" class="file-icon" role="img" aria-label="${label} file">`
    // Page: thin outline with folded corner. Fill/border from theme tokens.
    + `<path d="M6.5 3.2a1.8 1.8 0 0 1 1.8-1.8h5.4l4.6 4.6v13.4a1.8 1.8 0 0 1-1.8 1.8H8.3a1.8 1.8 0 0 1-1.8-1.8z" fill="var(--input-bar)" stroke="var(--hairline-strong)" stroke-width="1.4"/>`
    + `<path d="M13.7 1.4v3.2a1.4 1.4 0 0 0 1.4 1.4h3.2" stroke="var(--hairline-strong)" stroke-width="1.2" stroke-linecap="round"/>`
    // One-color accent glyph.
    + glyph(type, accent)
    // Tinted extension pill.
    + `<rect x="7" y="15.6" width="10" height="4.8" rx="2.4" fill="${pillTint}"/>`
    + `<text x="12" y="19.1" font-family="${GLYPH_FONT}" font-size="3.3" font-weight="800" fill="${accent}" text-anchor="middle" letter-spacing="0.4">${label}</text>`
    + `</svg>`;
}

export default FileIcon;
