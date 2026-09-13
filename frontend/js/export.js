/**
 * Export module for BMO AI assistant responses.
 *
 * Coordinates canonical Markdown construction, format definitions, export intent
 * detection in chat prompts, filename sanitization, and browser Blob downloads.
 */

import { stripLeakedHighlightSpans } from "./components/markdown.js?v=33";

export const EXPORT_FORMATS = {
  md: {
    id: "md",
    label: "Markdown",
    ext: ".md",
    mime: "text/markdown; charset=utf-8",
    badge: "MD",
    icon: "fileText",
    description: "Raw Markdown source document",
  },
  pdf: {
    id: "pdf",
    label: "PDF",
    ext: ".pdf",
    mime: "application/pdf",
    badge: "PDF",
    icon: "fileText",
    description: "Formatted, text-based PDF document",
  },
  docx: {
    id: "docx",
    label: "Word (DOCX)",
    ext: ".docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    badge: "DOCX",
    icon: "fileText",
    description: "Editable Microsoft Word document",
  },
};

/**
 * Detect whether a user prompt contains an export request.
 *
 * Distinguishes between:
 * 1. `exportOnly`: user ONLY wants to export the previous response (e.g. "I need this as a PDF", "Export this response").
 * 2. `composite`: user is asking a question AND requesting an export (e.g. "Explain photosynthesis and give me a PDF").
 */
export function detectExportIntent(rawPrompt) {
  const text = (rawPrompt || "").trim();
  if (!text) {
    return { isExport: false, exportOnly: false, formats: ["md", "pdf", "docx"], cleanPrompt: text };
  }

  const lower = text.toLowerCase().replace(/\s+/g, " ");

  // Formats detected in prompt
  const detectedFormats = [];
  if (/\b(pdf|adobe|\.pdf)\b/.test(lower)) detectedFormats.push("pdf");
  if (/\b(docx?|word(?:\s+doc(?:ument)?)?|\.docx?)\b/.test(lower)) detectedFormats.push("docx");
  if (/\b(markdown|md(?:\s+file)?|\.md)\b/.test(lower)) detectedFormats.push("md");

  // Fallback to all formats if generic "export", "download", or "all formats"
  const formats = detectedFormats.length > 0 ? detectedFormats : ["md", "pdf", "docx"];

  // Patterns that indicate an EXPORT-ONLY turn referencing previous message
  const exportOnlyPatterns = [
    /^(?:please\s+)?(?:export|download|save|give me|i need|can i (?:get|have)|provide|make|generate)(?:\s+(?:all|this|the|that|it|previous|last|latest|completed))?\s*(?:response|message|answer|chat|conversation|text|file|document|doc)?\s*(?:as|in|to|into|for)?\s*(?:a|an)?\s*(?:pdf|word|docx|doc|markdown|md|all formats|files|documents)?(?:\s+(?:format|file|doc|document|version))?[.!?]*$/i,
    /^(?:i\s+need\s+this\s+(?:as|in)\s+(?:a\s+)?(?:pdf|word(?:\s+document)?|docx|markdown|md)(?:[,\s]+and\s+(?:word(?:\s+document)?|docx|pdf|markdown|md))?)[.!?]*$/i,
    /^(?:i\s+need\s+this\s+in\s+pdf[,\s]+markdown[,\s]+(?:and\s+)?word(?:\s+format)?)[.!?]*$/i,
    /^(?:export|download)\s+(?:this|the|that|it|last|previous|latest|completed)?\s*(?:response|message|answer|chat|conversation)?[.!?]*$/i,
    /^(?:give\s+me|send\s+me|get\s+me)\s+(?:a\s+)?(?:pdf|word\s+doc(?:ument)?|docx|markdown|md)(?:\s+file|\s+document|\s+version)?[.!?]*$/i,
    /^(?:download\s+this\s+as\s+markdown|give\s+me\s+a\s+word\s+document|i\s+need\s+this\s+as\s+a\s+pdf)[.!?]*$/i,
    /^(?:pdf|docx|word\s+document|markdown|md)\s*(?:please|export|download)?[.!?]*$/i,
  ];

  const isExportOnly = exportOnlyPatterns.some((pattern) => pattern.test(lower));

  // Check if it's a composite export request (e.g. "Explain photosynthesis and give me a PDF")
  const compositeKeywords = [
    /\b(?:and|also|plus)?\s*(?:give|send|provide|make|export|download|save|generate)\s*(?:me\s+)?(?:it\s+|this\s+)?(?:as\s+|in\s+)?(?:a\s+)?(?:pdf|word|docx|markdown|md)(?:\s+format|\s+file|\s+doc)?\b/i,
    /\b(?:in|as)\s+(?:pdf|word|docx|markdown|md)\s+(?:format|file|document)\b/i,
    /\b(?:give me|need)\s+(?:a\s+)?(?:pdf|word document|docx|markdown)\b/i,
  ];

  const isComposite = compositeKeywords.some((kw) => kw.test(lower));

  const isExport = isExportOnly || isComposite;

  // Clean prompt for model if composite (optional strip of trailing export clause)
  let cleanPrompt = text;
  if (isComposite && !isExportOnly) {
    cleanPrompt = text
      .replace(/,\s*(?:and\s+)?(?:please\s+)?(?:give me|provide|make|export|download|save|generate|send)\s+(?:me\s+)?(?:a\s+)?(?:pdf|word\s+doc(?:ument)?|docx|markdown|md)(?:\s+format|\s+file)?[.!?]*$/i, "")
      .trim() || text;
  }

  return {
    isExport,
    exportOnly: isExportOnly,
    formats,
    cleanPrompt,
  };
}

/**
 * Builds the standardized canonical Markdown document from message content and metadata.
 */
export function buildCanonicalMarkdown({ title, content, date } = {}) {
  const cleanTitle = (title || "").trim() || "Bmo AI response";
  const d = date instanceof Date ? date : new Date();
  const dateStr = d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const body = stripLeakedHighlightSpans((content || "").trim());
  const startsWithH1 = body.startsWith(`# ${cleanTitle}`);

  const headerParts = [];
  if (!startsWithH1) {
    headerParts.push(`# ${cleanTitle}\n`);
  }
  headerParts.push(`*Generated on ${dateStr} · Created with Bmo*\n`);
  headerParts.push("---\n");

  return `${headerParts.join("\n")}\n${body}\n`;
}

/**
 * Produces a sanitized, safe filename for browser download.
 */
export function formatExportFilename(title, ext = "md") {
  const cleanExt = (ext || "md").replace(/^\./, "").toLowerCase();
  const rawTitle = (title || "").trim() || "bimo-ai-response";

  const slug = rawTitle
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "bimo-ai-response";

  return `${slug}.${cleanExt}`;
}

/**
 * Triggers a browser file download using URL.createObjectURL and a temporary anchor tag.
 */
export function downloadBlob(blob, filename) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.style.position = "fixed";
  a.style.left = "-9999px";
  a.href = url;
  a.download = filename || "bimo-export";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {}
  }, 2000);
}

/**
 * Builds a clean Word-compatible document blob from HTML markup.
 */
export function buildClientDocxBlob({ title, htmlContent } = {}) {
  const cleanTitle = (title || "Bmo AI Document").trim();
  const docHtml = `<!DOCTYPE html>
<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
<head>
  <meta charset="utf-8">
  <title>${cleanTitle}</title>
  <style>
    body { font-family: Calibri, 'Segoe UI', Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; margin: 1in; }
    h1 { font-size: 20pt; font-weight: bold; color: #1e3a8a; border-bottom: 1.5pt solid #3b82f6; padding-bottom: 4pt; margin-bottom: 14pt; }
    h2 { font-size: 14pt; font-weight: bold; color: #1e293b; margin-top: 14pt; margin-bottom: 6pt; }
    h3 { font-size: 12pt; font-weight: bold; color: #334155; margin-top: 10pt; margin-bottom: 4pt; }
    p { margin-bottom: 8pt; }
    ul, ol { margin-top: 4pt; margin-bottom: 8pt; padding-left: 24pt; }
    li { margin-bottom: 3pt; }
    table { border-collapse: collapse; width: 100%; margin-top: 8pt; margin-bottom: 12pt; }
    th, td { border: 1pt solid #cbd5e1; padding: 6pt 8pt; text-align: left; }
    th { background-color: #f1f5f9; font-weight: bold; }
    code { font-family: Consolas, 'Courier New', monospace; background: #f8fafc; padding: 1pt 3pt; border-radius: 2pt; font-size: 9.5pt; }
    pre { font-family: Consolas, 'Courier New', monospace; background: #f8fafc; border: 1pt solid #e2e8f0; padding: 8pt; font-size: 9.5pt; margin-bottom: 8pt; }
    hr { border: 0; border-top: 1pt solid #e2e8f0; margin: 12pt 0; }
  </style>
</head>
<body>
  ${htmlContent || ""}
</body>
</html>`;
  return new Blob([docHtml], { type: "application/vnd.ms-word;charset=utf-8" });
}

/**
 * Opens a print dialog formatted for clean saving to PDF.
 */
export function printDocumentToPdf({ title, htmlContent } = {}) {
  const cleanTitle = (title || "Bmo AI Document").trim();
  const printWindow = window.open("", "_blank", "width=850,height=900");
  if (!printWindow) {
    window.print();
    return;
  }
  printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${cleanTitle}</title>
  <style>
    @page { size: A4; margin: 18mm; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 11pt; line-height: 1.6; color: #111827; background: #fff; margin: 0; padding: 20px; }
    h1 { font-size: 22pt; font-weight: 700; color: #0f172a; margin-top: 0; margin-bottom: 12px; border-bottom: 2px solid #3b82f6; padding-bottom: 6px; }
    h2 { font-size: 15pt; font-weight: 600; color: #1e293b; margin-top: 18px; margin-bottom: 8px; }
    h3 { font-size: 12pt; font-weight: 600; color: #334155; margin-top: 12px; margin-bottom: 6px; }
    p { margin-bottom: 10px; }
    ul, ol { margin-top: 6px; margin-bottom: 12px; padding-left: 22px; }
    li { margin-bottom: 4px; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    th, td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }
    th { background: #f3f4f6; font-weight: 600; }
    code { font-family: monospace; background: #f3f4f6; padding: 2px 4px; border-radius: 3px; font-size: 9.5pt; }
    pre { font-family: monospace; background: #f9fafb; border: 1px solid #e5e7eb; padding: 10px; border-radius: 4px; overflow-x: auto; margin-bottom: 12px; }
    hr { border: 0; border-top: 1px solid #e5e7eb; margin: 16px 0; }
    @media print {
      body { padding: 0; }
      @page { margin: 15mm; }
    }
  </style>
</head>
<body>
  ${htmlContent || ""}
  <script>
    window.onload = () => {
      window.print();
    };
  <\/script>
</body>
</html>`);
  printWindow.document.close();
}
