import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { moduleLoader } from "./modules.mjs";

const fixture = name => new URL(`../../backend/tests/fixtures/${name}`, import.meta.url);
const cases = JSON.parse(await readFile(fixture("highlight_span_cases.json"), "utf8"));
function app() {
  return moduleLoader({}, { globals: { console: { ...console, error() {} } }, append: {
    "markdown.js": `\nexport function prepareTestLibraries(value) { lib = value; ensureCodeCopyHandler(); }`,
  } });
}
for (const row of cases) {
  test(`source cleanup: ${row.name}`, async () => {
    const loader = app();
    const markdown = await loader.load("js/components/markdown.js");
    assert.equal(markdown.stripLeakedHighlightSpans(row.source), row.expected);
    loader.dom.window.close();
  });
}
test("live calculator rendered and copied source retains display IDs", async () => {
  const loader = app();
  const markdown = await loader.load("js/components/markdown.js");
  const source = await readFile(fixture("calculator_response.md"), "utf8");
  const unfence = value => value.replace(/^```html\n/, "").replace(/\n```\s*$/, "");
  const code = unfence(source);
  let copied;
  loader.dom.window.navigator.clipboard = { writeText: async value => { copied = value; } };
  const escape = value => value.replace(/[&<>]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);
  // Isolate the source-cleanup and copy pipeline from CDN parser availability.
  markdown.prepareTestLibraries({
    marked: { parse: value => `<pre><code>${escape(unfence(value))}</code></pre>` },
    DOMPurify: { sanitize: value => value },
  });
  loader.dom.window.document.querySelector("#app").innerHTML = markdown.renderMarkdown(source);
  assert.equal(loader.dom.window.document.querySelector("pre code").textContent, code);
  loader.dom.window.document.querySelector(".code-copy").click();
  await Promise.resolve();
  assert.equal(copied, code);
  assert.match(copied, /id="history"/);
  assert.match(copied, /id="result"/);
  clearTimeout(loader.dom.window.document.querySelector(".code-copy")._copyTimeout);
  loader.dom.window.close();
});
