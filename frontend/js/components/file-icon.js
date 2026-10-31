// Flat document icons. Fixed fills keep every type identical in both themes.
const TYPES = {
  pdf: { color: "#C84040", mark: '<path d="M10 18c4-5 5-10 3-10-3 0 0 9 6 10 5 1 3-4-9 0Z"/>' },
  pptx: { color: "#B95730", mark: '<path d="M16 9v5h5A5 5 0 0 0 16 9Z" fill="#fff" stroke="none"/><path d="M13 10a5 5 0 1 0 7 7h-7Z"/>' },
  docx: { color: "#326AC4", mark: '<path d="m9 10 2 8 3-6 3 6 2-8"/>' },
  json: { color: "#97651F", mark: '<path d="M12 9h-1c-2 0 0 4-2 5 2 1 0 4 2 4h1m7-9h1c2 0 0 4 2 5-2 1 0 4-2 4h-1"/>' },
  md: { color: "#526780", mark: '<path d="M8 18v-7l3 3 3-3v7m6-7v7m-2-2 2 2 2-2"/>' },
  txt: { color: "#22796F", mark: '<path d="M10 10h8m-8 4h12m-12 4h8"/>' },
  xlsx: { color: "#287749", mark: '<path d="m11 10 8 8m0-8-8 8"/>' },
  csv: { color: "#287749", mark: '<path d="M10 10h12v9H10Zm0 3h12m-8-3v9"/>' },
};

const ALIASES = {
  ppt: "pptx", doc: "docx", word: "docx", markdown: "md", text: "txt",
  jsonl: "json", tsv: "csv", xls: "xlsx",
};

/** File extension (with or without a dot) and square size in pixels → SVG. */
export function FileIcon(ext, size = 24) {
  const extension = String(ext || "").trim().replace(/^\.+/, "").toLowerCase();
  const type = Object.hasOwn(ALIASES, extension) ? ALIASES[extension] : extension;
  const definition = Object.hasOwn(TYPES, type) ? TYPES[type] : { color: "#66717E", mark: TYPES.txt.mark };
  const label = (type.replace(/[^a-z0-9]/g, "").slice(0, 5) || "FILE").toUpperCase();
  const pixels = Number(size) || 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 32 36" fill="none" class="file-icon" role="img" aria-label="${label} file">`
    + `<path d="M6 2h14l8 8v21a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Z" fill="${definition.color}"/>`
    + '<path d="M20 2v5a3 3 0 0 0 3 3h5Z" fill="#fff" fill-opacity=".3"/>'
    + `<g transform="translate(0 6)" stroke="#fff" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${definition.mark}</g></svg>`;
}

export default FileIcon;
