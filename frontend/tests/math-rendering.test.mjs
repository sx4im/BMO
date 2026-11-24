import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { moduleLoader } from "./modules.mjs";

const styles = await readFile(new URL("../css/styles.css", import.meta.url), "utf8");

for (const event of ["load", "error"]) {
  test(`KaTeX uses the visual copy only after its stylesheet loads (${event})`, async t => {
    const { dom, load } = moduleLoader({}, {
      append: { "markdown.js": "\nexport { injectKatexCss };" },
      globals: { console: { ...console, error() {} } },
    });
    t.after(() => dom.window.close());
    const { document, Event, getComputedStyle } = dom.window;
    const { injectKatexCss } = await load("js/components/markdown.js");

    const style = document.createElement("style");
    style.textContent = styles;
    document.head.append(style);
    document.querySelector("#app").innerHTML = `<span class="katex">
      <span class="katex-mathml"><math><mi>log</mi><mn>0</mn></math></span>
      <span class="katex-html" aria-hidden="true">log 0</span>
    </span>`;
    injectKatexCss();

    const visual = document.querySelector(".katex-html");
    const math = document.querySelector(".katex-mathml");
    assert.equal(getComputedStyle(visual).display, "none");
    assert.notEqual(getComputedStyle(math).display, "none");

    document.querySelector("link[data-katex-css]").dispatchEvent(new Event(event));
    assert.equal(getComputedStyle(visual).display, event === "load" ? "inline" : "none");
    assert.notEqual(getComputedStyle(math).display, "none");
  });
}
