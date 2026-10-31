import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { JSDOM } from "jsdom";

// Execute real ES modules while keeping external services out of DOM tests.
export function moduleLoader(stubs = {}, { append = {}, globals = {} } = {}) {
  const dom = new JSDOM('<div id="app"></div>', { url: "https://test.invalid/" });
  const context = vm.createContext({
    document: dom.window.document, window: dom.window, Node: dom.window.Node,
    CustomEvent: dom.window.CustomEvent, location: dom.window.location, history: dom.window.history,
    localStorage: dom.window.localStorage, navigator: dom.window.navigator,
    URL, URLSearchParams, AbortController, DOMException, FormData: class { append() {} },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    ...globals,
  });
  const modules = new Map();
  async function load(url) {
    if (modules.has(url)) return modules.get(url);
    const filename = fileURLToPath(url).split("/").pop();
    const exports = stubs[filename];
    const module = exports
      ? new vm.SyntheticModule(Object.keys(exports), function () {
          for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        }, { context, identifier: url })
      : new vm.SourceTextModule((await readFile(new URL(url), "utf8")) + (append[filename] || ""), { context, identifier: url });
    modules.set(url, module);
    await module.link((specifier, parent) => load(new URL(specifier, parent.identifier).href));
    return module;
  }
  return {
    dom, context,
    async load(path) {
      const module = await load(new URL(path, new URL("../", import.meta.url)).href);
      await module.evaluate();
      return module.namespace;
    },
  };
}
