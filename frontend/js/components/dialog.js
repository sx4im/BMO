// Shared focus/modality lifecycle for existing vanilla-JS overlays.
const stack = [];
const background = new Map();
let sequence = 0;
let previousOverflow = "";

export function closeDialogs() {
  for (const entry of [...stack].reverse()) entry.close();
}

function synchronize() {
  const top = stack.at(-1);
  if (!top) {
    for (const [node, original] of background) {
      if (original.inert === null) node.removeAttribute("inert");
      else node.setAttribute("inert", original.inert);
      if (original.hidden === null) node.removeAttribute("aria-hidden");
      else node.setAttribute("aria-hidden", original.hidden);
    }
    background.clear();
    document.body.style.overflow = previousOverflow;
    return;
  }
  for (const node of document.body.children) {
    if (!background.has(node)) background.set(node, { inert: node.getAttribute("inert"), hidden: node.getAttribute("aria-hidden") });
    if (node === top.overlay) {
      node.removeAttribute("inert"); node.removeAttribute("aria-hidden");
    } else {
      node.setAttribute("inert", ""); node.setAttribute("aria-hidden", "true");
    }
  }
  document.body.style.overflow = "hidden";
}

function focusable(root) {
  return [...root.querySelectorAll('button, input, textarea, select, iframe, a[href], [tabindex]')].filter(node => {
    if (node.disabled || node.tabIndex < 0 || node.closest('[hidden], [inert]') || node.type === "hidden") return false;
    for (let current = node; current && current !== root.parentElement; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  });
}

export function mountDialog(overlay, { title, initialFocus, onClose, closeDelay = 0 } = {}) {
  const invoker = document.activeElement;
  const target = overlay.matches('[role="dialog"]') ? overlay : overlay.querySelector('[role="dialog"]') || overlay;
  target.setAttribute("role", "dialog"); target.setAttribute("aria-modal", "true"); target.tabIndex = -1;
  if (title) { title.id = `bimo-dialog-title-${++sequence}`; target.setAttribute("aria-labelledby", title.id); }
  let open = true;
  const entry = { overlay, target };
  const focusInside = () => {
    const nodes = focusable(target);
    (nodes.includes(initialFocus) ? initialFocus : nodes[0] || target).focus({ preventScroll: true });
  };
  const close = () => {
    if (!open) return;
    open = false;
    const wasTop = stack.at(-1) === entry;
    stack.splice(stack.indexOf(entry), 1);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("focusin", onFocus, true);
    overlay.removeEventListener("click", onBackdrop);
    overlay.classList.remove("open");
    synchronize();
    overlay.setAttribute("inert", ""); overlay.setAttribute("aria-hidden", "true");
    if (closeDelay) setTimeout(() => overlay.remove(), closeDelay);
    else overlay.remove();
    if (wasTop) {
      const next = stack.at(-1);
      if (next) {
        if (invoker?.isConnected && next.target.contains(invoker)) invoker.focus({ preventScroll: true });
        else (focusable(next.target)[0] || next.target).focus({ preventScroll: true });
      } else if (invoker?.isConnected && !invoker.closest("[inert]")) invoker.focus({ preventScroll: true });
    }
    onClose?.();
  };
  const onKey = event => {
    if (stack.at(-1) !== entry) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === "Tab") {
      const nodes = focusable(target);
      const current = document.activeElement;
      if (!nodes.length || !target.contains(current) || (event.shiftKey ? current === nodes[0] : current === nodes.at(-1))) {
        event.preventDefault();
        (event.shiftKey ? nodes.at(-1) || target : nodes[0] || target).focus();
      }
    }
  };
  const onFocus = event => { if (open && stack.at(-1) === entry && !target.contains(event.target)) focusInside(); };
  const onBackdrop = event => { if (event.target === overlay) close(); };
  if (!stack.length) previousOverflow = document.body.style.overflow;
  entry.close = close;
  document.body.append(overlay);
  stack.push(entry); synchronize(); overlay.classList.add("open");
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("focusin", onFocus, true);
  overlay.addEventListener("click", onBackdrop);
  focusInside();
  return { close, get isOpen() { return open; } };
}
