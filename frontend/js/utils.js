// ---------- DOM helpers ----------

export function $(sel, parent = document) {
  return parent.querySelector(sel);
}

export function $$(sel, parent = document) {
  return [...parent.querySelectorAll(sel)];
}

/**
 * Tiny tagged-template-style DOM builder.
 * Usage: el("div", { class: "card" }, [el("p", {}, ["hi"])])
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === "class" || key === "className") {
      node.className = value;
    } else if (key === "html") {
      node.innerHTML = value;
    } else if (key === "text") {
      node.textContent = value;
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && typeof value !== "string") {
      node[key] = value;
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children || [])) {
    if (child == null || child === false) continue;
    if (child instanceof Node) {
      node.append(child);
    } else if (typeof child === "string" && /^\s*</.test(child)) {
      // ponytail: icon() returns SVG markup — append as HTML, not a text node
      node.insertAdjacentHTML("beforeend", child);
    } else {
      node.append(document.createTextNode(String(child)));
    }
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---------- string / date helpers ----------

export function cx(...classes) {
  return classes.filter(Boolean).join(" ");
}

export function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function initialsFromName(name) {
  if (!name) return "U";
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

export function formatRelative(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

export function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function scrambleElement(el, htmlContent, duration = 800) {
  if (el._scrambleInterval) {
    clearInterval(el._scrambleInterval);
  }

  el.innerHTML = htmlContent;
  const textNodes = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while (node = walk.nextNode()) {
    textNodes.push({
      node: node,
      originalText: node.nodeValue,
    });
  }

  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+";
  const steps = 15;
  const intervalTime = duration / steps;
  let step = 0;

  el._scrambleInterval = setInterval(() => {
    step++;
    if (step >= steps) {
      clearInterval(el._scrambleInterval);
      el._scrambleInterval = null;
      for (const item of textNodes) {
        item.node.nodeValue = item.originalText;
      }
      return;
    }

    for (const item of textNodes) {
      const orig = item.originalText;
      let result = "";
      for (let i = 0; i < orig.length; i++) {
        const charProgress = i / orig.length;
        const totalProgress = step / steps;
        if (charProgress < totalProgress) {
          result += orig[i];
        } else if (orig[i] === " " || orig[i] === "\n") {
          result += orig[i];
        } else {
          result += charset[Math.floor(Math.random() * charset.length)];
        }
      }
      item.node.nodeValue = result;
    }
  }, intervalTime);
}

export function formatTitle(raw) {
  if (!raw) return "";
  let t = String(raw).trim();
  if (!t.includes(" ") && /[a-z][A-Z]/.test(t)) {
    t = t.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  }
  return t.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/\s+/g, " ").trim();
}

