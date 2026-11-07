import { deployment } from "./deployment.js";
import { config } from "./config.js?v=30";
import * as auth from "./auth.js";
import { el } from "./utils.js?v=51";
import { mountDialog } from "./components/dialog.js";

let cached = null;
let pending = null;
let sdkPromise = null;
const aborted = () => new DOMException("Verification cancelled.", "AbortError");

// This only keys an in-memory UI cache. The server verifies the JWT and binding.
function sessionKey(token) {
  try {
    const claims = JSON.parse(window.atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof claims.sub === "string" && typeof claims.session_id === "string") return `${claims.sub}:${claims.session_id}`;
  } catch {}
  return null;
}
function currentKey() { return sessionKey(auth.getAuth().auth?.token || ""); }
export function hasTurnstile() { return !!deployment.turnstileSiteKey; }
export function invalidateClearance() { cached = null; }

function loadSDK() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const fail = () => { clearTimeout(timer); script.remove(); sdkPromise = null; reject(new Error("Verification could not load. Please try again.")); };
    const timer = setTimeout(fail, 10000);
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onerror = fail;
    script.onload = () => {
      if (!window.turnstile) { fail(); return; }
      clearTimeout(timer); resolve(window.turnstile);
    };
    document.head.append(script);
  });
  return sdkPromise;
}

async function verifySession(token, key, controller) {
  const sdk = await loadSDK();
  const { signal } = controller;
  if (signal.aborted || currentKey() !== key) throw aborted();
  return new Promise((resolve, reject) => {
    let settled = false, submitting = false, widget = null, dialog = null, unsubscribe = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      unsubscribe?.();
      if (widget !== null) { try { sdk.remove(widget); } catch {} }
      dialog?.close();
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => finish(aborted());
    const timeout = setTimeout(() => controller.abort(), 120000);
    const title = el("h2", {class:"confirm-modal-title", text:"Quick verification"});
    const status = el("p", {class:"confirm-modal-message", role:"status", text:"Please verify you're human to continue."});
    const target = el("div", {});
    const retry = el("button", {type:"button",class:"confirm-modal-btn primary",hidden:true,text:"Try again",onclick:()=>{
      retry.hidden = true; status.textContent = "Please verify you're human to continue.";
      if (widget !== null) sdk.reset(widget);
    }});
    const cancelButton = el("button", {type:"button",class:"confirm-modal-btn cancel",text:"Cancel",onclick:()=>controller.abort()});
    const overlay = el("div", {class:"confirm-modal-overlay"}, [el("div", {class:"confirm-modal-card"}, [title,status,target,
      el("div", {class:"confirm-modal-actions"}, [cancelButton,retry])])]);
    dialog = mountDialog(overlay, {title,initialFocus:cancelButton,onClose:()=>{if(!settled)controller.abort();}});
    signal.addEventListener("abort", cancel, {once:true});
    unsubscribe = auth.onAuthChange?.(() => { if (currentKey() !== key) { cached = null; controller.abort(); } });
    const retryWidget = () => { if (!settled) { status.textContent = "Verification failed. Please try again."; retry.hidden = false; } };
    try {
      widget = sdk.render(target, {
        sitekey:deployment.turnstileSiteKey, action:"bimo_paid", size:"compact",
        "error-callback":retryWidget, "expired-callback":retryWidget, "timeout-callback":retryWidget,
        callback:async proof => {
          if (settled || submitting || signal.aborted) return;
          submitting = true; retry.hidden = true; status.textContent = "Verifying…";
          try {
            const response = await fetch(`${config.apiUrl}/security/clearance`, {method:"POST",signal,
              headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`},body:JSON.stringify({token:proof})});
            const result = await response.json();
            if (signal.aborted || currentKey() !== key) throw aborted();
            if (!response.ok) { const error = new Error(result.detail || "Verification failed. Please try again."); error.status = response.status; throw error; }
            if (!/^[A-Za-z0-9_-]{43}$/.test(result.clearance) || !(result.expires_in > 0 && result.expires_in <= 900)) throw new Error("Verification failed. Please try again.");
            cached = {key,value:result.clearance,expires:Date.now() + result.expires_in * 1000 - 5000};
            finish(null, result.clearance);
          } catch (error) { finish(error); }
        },
      });
    } catch (error) { finish(error); }
  });
}

function waitFor(job, signal) {
  return new Promise((resolve, reject) => {
    const waiter = {};
    job.waiters.add(waiter);
    const cleanup = () => { job.waiters.delete(waiter); signal?.removeEventListener("abort", cancel); };
    const cancel = () => {
      cleanup(); reject(aborted());
      if (!job.waiters.size) job.controller.abort();
    };
    signal?.addEventListener("abort", cancel, {once:true});
    if (signal?.aborted) { cancel(); return; }
    job.promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

export function getClearance(token, {signal,force=false} = {}) {
  if (signal?.aborted) return Promise.reject(aborted());
  const key = sessionKey(token);
  if (!key || currentKey() !== key) return Promise.reject(aborted());
  if (!hasTurnstile()) return Promise.reject(new Error("Verification is unavailable. Please try again later."));
  if (force) cached = null;
  if (cached?.key === key && cached.expires > Date.now()) return Promise.resolve(cached.value);
  if (!pending || pending.key !== key || pending.controller.signal.aborted) {
    pending?.controller.abort();
    const job = {key,controller:new AbortController(),waiters:new Set()};
    pending = job;
    job.promise = verifySession(token,key,job.controller).finally(() => { if (pending === job) pending = null; });
  }
  return waitFor(pending,signal);
}
