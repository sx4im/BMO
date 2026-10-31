import { $, el, clear } from "../utils.js?v=30";
import { icon } from "../icons.js?v=30";
import { tearDownShell } from "../app-shell.js";

export async function renderNotFound() {
  tearDownShell();
  const root = $("#app");
  clear(root);
  root.className = "app-root";
  root.append(
    el("div", { class: "notfound" }, [
      el("div", { style: "text-align:center" }, [
        el("div", { class: "mark", html: icon("compass", { width: 26, height: 26 }) }),
        el("h1", { text: "404" }),
        el("p", { text: "That route doesn't exist. Head back to the workspace." }),
        el("div", { class: "actions" }, [
          el("a", {
            href: "#/",
            class: "btn primary",
            html: `${icon("arrowLeft", { width: 16, height: 16 })} <span>Back home</span>`,
          }),
        ]),
      ]),
    ])
  );
}
