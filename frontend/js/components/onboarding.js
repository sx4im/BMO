// One features card per account and release, with a local offline backstop.
import { el } from "../utils.js?v=52";
import { icon } from "../icons.js?v=77";
import { getAuth } from "../auth.js?v=2";
import { saveOnboarding } from "../api.js?v=74";

const RELEASE = "6.0";
const seenKey = auth => `bmo-release-${RELEASE}:${auth?.user?.id || ""}`;
const acknowledgments = new Map();

function remember(auth, pending = false) {
  try { localStorage.setItem(seenKey(auth), pending ? "pending" : "1"); } catch { /* Storage may be disabled. */ }
}

function localState(auth) {
  try { return localStorage.getItem(seenKey(auth)); } catch { return null; }
}

export function syncOnboarding(auth, force = false) {
  if (!auth?.user?.id || getAuth().auth?.user?.id !== auth.user.id || (!force && localState(auth) !== "pending")) return Promise.resolve();
  const key = seenKey(auth);
  if (acknowledgments.has(key)) return acknowledgments.get(key);
  const task = saveOnboarding(auth.token, { release: RELEASE })
    .then(result => {
      if (result?.release !== RELEASE) throw new Error("Release acknowledgment is not confirmed");
      remember(auth);
    })
    .catch(() => { /* Retry on the next auth check without reopening the card. */ })
    .finally(() => acknowledgments.delete(key));
  acknowledgments.set(key, task);
  return task;
}

export function hasSeenOnboarding(auth, profile) {
  if (profile?.onboarding_release === RELEASE) {
    remember(auth);
    return true;
  }
  return ["1", "pending"].includes(localState(auth));
}

export function showOnboarding(auth) {
  if (!auth?.user?.id || hasSeenOnboarding(auth) || document.getElementById("onboarding")) return;
  const previousFocus = document.activeElement;
  const previousOverflow = document.documentElement.style.overflow;
  const feature = (name, title, text) => el("div", { class: "ob-feature" }, [
    el("div", { class: "ob-feature-ic", html: icon(name, { width: 20, height: 20 }) }),
    el("div", {}, [el("div", { class: "ob-feature-title", text: title }), el("div", { class: "ob-feature-desc", text })]),
  ]);
  const button = el("button", { type: "button", class: "btn primary wide", text: "Start using Bmo 6.0", onclick: finish });
  const card = el("div", { class: "ob-card ob-in" }, [
    el("h2", { id: "bmo-release-title", class: "ob-title", text: "What's new in Bmo 6.0" }),
    el("div", { class: "ob-features" }, [
      feature("globe", "Smarter web search", "Find more relevant news and information from a broader set of sources."),
      feature("mic", "Natural voice conversations", "Talk hands-free with multilingual voices and automatic microphone restart."),
      feature("blocks", "Smoother chat", "Read consistently formatted answers while replies arrive."),
      feature("galleryVerticalEnd", "Projects and skills", "Organize related chats, reference files, and custom instructions."),
    ]),
    el("div", { class: "ob-actions" }, [button]),
  ]);
  const overlay = el("div", { id: "onboarding", class: "ob-overlay", role: "dialog", "aria-modal": "true", "aria-labelledby": "bmo-release-title" }, [card]);
  document.body.append(overlay);
  document.documentElement.style.overflow = "hidden";
  button.focus();
  overlay.addEventListener("keydown", event => {
    if (event.key === "Tab") { event.preventDefault(); button.focus(); }
    if (event.key === "Escape") { event.preventDefault(); finish(); }
  });

  async function finish() {
    overlay.remove();
    document.documentElement.style.overflow = previousOverflow;
    if (previousFocus?.isConnected) previousFocus.focus();
    if (getAuth().auth?.user?.id !== auth.user.id) return;
    remember(auth, true);
    await syncOnboarding(auth, true);
  }
}
