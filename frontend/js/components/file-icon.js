// FileIcon - one component for every file-type icon in the app.
// (FileIcon(ext, size) in this codebase's string-icon idiom.)
//
// Design: the file-type reference - a solid page in the per-type accent
// color with a lighter folded corner, a one-color white glyph in the middle
// and the extension label in white at the bottom. Identical in light and
// dark mode.
//
// Glyph artwork adapted from file-icon-vectors
// (https://github.com/dmhendricks/file-icon-vectors) by Daniel Hendricks,
// MIT license - recolored white and repositioned; page colors and layout
// follow the file-type reference image.

const GLYPH_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

// Exact page colors sampled from the file-type reference image.
const COLORS = {
  pdf: "#f42a2a",
  pptx: "#ff600c",
  csv: "#0aa563",
  md: "#2861ee",
  txt: "#6d6f7b",
  json: "#e79203",
  docx: "#2563eb",
};

// White glyphs, drawn in the middle of the page (24x24 canvas).
// Vector glyphs come from the vivid file-icon-vectors set; the json
// braces are drawn as text to match the reference ("{ }" with no gear).
const GLYPHS = {
  pdf: `<g transform="translate(4.08,-4.91) scale(0.22)"><path d="M33.5 46.538c-2.3 0-4.1 1.9-4.1 4.1 0 2.8 1.6 6.3 3.2 9.6-1.3 4-2.7 8.3-4.6 11.9-3.8 1.5-7.2 2.6-9.2 4.3l-.1.1c-.7.8-1.2 1.8-1.2 2.9 0 2.3 1.9 4.1 4.1 4.1 1.1 0 2.2-.4 2.9-1.2 0 0 .1 0 .1-.1 1.5-1.8 3.3-5.1 4.9-8 3.6-1.4 7.5-2.9 11.1-3.8 2.7 2.2 6.6 3.6 9.8 3.6 2.3 0 4.1-1.9 4.1-4.1 0-2.3-1.9-4.1-4.1-4.1-2.6 0-6.3.9-9.1 1.9-2.3-2.2-4.4-4.9-6-7.8 1.1-3.4 2.4-6.7 2.4-9.3-.1-2.3-1.9-4.1-4.2-4.1zm0 2.4c.9 0 1.6.7 1.6 1.6 0 1.2-.7 3.5-1.4 5.9-1-2.4-1.9-4.7-1.9-5.9.1-.8.8-1.6 1.7-1.6zm.7 14.1c1.2 2 2.7 3.8 4.3 5.4-2.4.7-4.8 1.5-7.2 2.4 1.2-2.5 2.1-5.2 2.9-7.8zm16.2 5.3c.9 0 1.6.7 1.6 1.6 0 .9-.7 1.6-1.6 1.6-1.9 0-4.5-.8-6.6-2 2.4-.6 5.1-1.2 6.6-1.2zm-24.5 7.3c-1.2 2.1-2.3 4-3.1 5-.3.3-.6.4-1.1.4-.9 0-1.6-.7-1.6-1.6 0-.4.2-.9.4-1.1.9-.8 3-1.7 5.4-2.7z" fill="#ffffff" stroke="#ffffff" stroke-width=".75" stroke-miterlimit="10"/></g>`,
  pptx: `<g transform="translate(4.08,-4.91) scale(0.22)"><path fill="#ffffff" d="M53 47.7H19c-1.7 0-3.1 1.4-3.1 3.1v21.8c0 1.7 1.4 3.1 3.1 3.1h14.2L31.8 81h-1.6c-.7 0-1.2.5-1.2 1.2s.5 1.2 1.2 1.2h11.5c.7 0 1.2-.5 1.2-1.2s-.5-1.2-1.2-1.2H40l-1.4-5.4H53c1.7 0 3.1-1.4 3.1-3.1V50.8c0-1.7-1.4-3.1-3.1-3.1zm.3 25.1H18.7V50.6h34.5l.1 22.2z"/><path fill="#ffffff" d="M27.6 63.9h2.8v5.6h-2.8zm4.7-1.8h2.8v7.4h-2.8zm4.6-1.9h2.8v9.3h-2.8zm4.6-1.8h2.8v11.1h-2.8zm-.2-4.1L36.4 57l-3.6-1.2-6.1 3.3.9 1 5.4-2.8 3.6 1.2 5.6-3.1.9 1 2.1-3.5-4.8.3z"/></g>`,
  csv: `<g transform="translate(4.08,-4.91) scale(0.22)"><path d="M14 54h8.5m3.3 0h8.5m3.4 0h8.5m3.3 0H58m-44 5.9h8.5m3.3 0h8.5m3.4 0h8.5m3.3 0H58m-44 5.9h8.5m3.3 0h8.5m3.4 0h8.5m3.3 0H58m-44 5.9h8.5m3.3 0h8.5m3.4 0h8.5m3.3 0H58m-44 5.9h8.5m3.3 0h8.5m3.4 0h8.5m3.3 0H58" fill="none" stroke="#ffffff" stroke-width="3" stroke-miterlimit="10"/></g>`,
  md: `<g transform="translate(4.08,-4.91) scale(0.22)"><path fill="#ffffff" d="M13.5 76.4V54.6h6.4l6.4 8 6.4-8h6.4v21.8h-6.4V63.9l-6.4 8-6.4-8v12.5h-6.4zm38.4 0l-9.6-10.6h6.4V54.6h6.4v11.2h6.4l-9.6 10.6z"/></g>`,
  txt: `<g transform="translate(4.08,-4.91) scale(0.22)"><path fill="#ffffff" d="M14.6 77.2h42.8v6.2H14.6zm0-14.8h42.8v6.2H14.6zm0-15h42.8v6.2H14.6z"/></g>`,
  docx: `<g transform="translate(4.08,-4.91) scale(0.22)"><path fill="#ffffff" d="M19.5 67.1l-4.8-14.8c-.2-.6-.3-.8-.4-.8-.1-.1-.2-.1-.3-.2l-1.7-.5-.1-2.1h9l.2 2.1-1.7.5v.2c0 .2.1.6.3 1l1.8 5.7 3.2-9.5 2.4-.1 2.9 9.5 2-5.7c.1-.4.3-.8.3-1v-.1l-1.5-.4-.1-2.2h7l.2 2.1-1.9.6c-.1 0-.2.1-.3.1 0 .1-.2.2-.3.7l-5.3 14.7-2.5.2-2.7-9.1-3.2 8.9-2.5.2z"/><path d="M42.4 48.6H60v2.8H42.4zm0 7.4H60v2.8H42.4zm0 7.7H60v2.8H42.4zM13 71.5h47v2.8H13zm0 7.6h47v2.8H13z" fill="#ffffff" stroke="#ffffff" stroke-width=".5" stroke-miterlimit="10"/></g>`,
  json: `<text x="12" y="13.4" font-family="${GLYPH_FONT}" font-size="8.4" font-weight="700" fill="#ffffff" text-anchor="middle" letter-spacing="1.6">{ }</text>`,
};

// Extension aliases resolved to a known icon.
const ALIASES = {
  ppt: "pptx",
  markdown: "md",
  text: "txt",
  jsonl: "json",
  tsv: "csv",
  doc: "docx",
  word: "docx",
};

const FALLBACK_GRAY = "#9aa0a6";

function page(color) {
  return `<path d="M9 2.5h5.5l4 4v13a2.5 2.5 0 0 1-2.5 2.5H9a2.5 2.5 0 0 1-2.5-2.5v-15a2.5 2.5 0 0 1 2.5-2.5z" fill="${color}"/>`
    + `<path d="M14.5 2.5h4v4z" fill="#ffffff" opacity="0.38"/>`;
}

/**
 * FileIcon(ext, size) -> SVG string.
 * ext: file extension, with or without a leading dot ("pdf", ".PDF", "jsonl").
 *      Aliases: ppt->pptx, markdown->md, text->txt, jsonl->json, tsv->csv,
 *      doc/word->docx. Anything else gets the neutral gray fallback with the
 *      raw ext as the bottom label.
 * size: rendered width/height in px (default 24).
 */
export function FileIcon(ext, size = 24) {
  const e = String(ext || "").trim().replace(/^\.+/, "").toLowerCase();
  const type = GLYPHS[e] ? e : ALIASES[e];
  const raw = e || "?";
  const label = (type ? type : raw).toUpperCase().slice(0, 5);
  const color = type ? COLORS[type] : FALLBACK_GRAY;
  const glyph = type ? GLYPHS[type] : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"`
    + ` viewBox="0 0 24 24" fill="none" class="file-icon" role="img"`
    + ` aria-label="${label} file">`
    + page(color) + glyph
    + `<text x="12" y="19.6" font-family="${GLYPH_FONT}" font-size="4.3"`
    + ` font-weight="800" fill="#ffffff" text-anchor="middle"`
    + ` letter-spacing="0.4">${label}</text></svg>`;
}

export default FileIcon;
