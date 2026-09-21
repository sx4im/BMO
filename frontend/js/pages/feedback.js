import { el, clear } from "../utils.js?v=30";
import { icon } from "../icons.js?v=57";
import { mountAppShell } from "../app-shell.js?v=72";
import { getAuth } from "../auth.js?v=31";
import { toast } from "../components/toast.js?v=58";
import { navigate } from "../router.js?v=31";

// Posts straight to Formspree (-> the team's inbox). No backend involved; the
// CSP allows https connect-src, so the fetch works from the browser.
const FORMSPREE_ENDPOINT = "https://formspree.io/f/mzdqndwb";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

function field(label, input, hint) {
  return el("div", { class: "settings-field" }, [
    el("label", { class: "field-label", text: label }),
    input,
    hint ? el("p", { class: "field-hint", text: hint }) : null,
  ]);
}

export async function renderFeedback() {
  const { auth } = getAuth();
  if (!auth) {
    navigate("#/", { replace: true });
    return;
  }

  const shell = await mountAppShell();
  shell.setActiveConversation(null);
  shell.setIncognitoActive?.(false);
  const host = shell.content;
  clear(host);

  const email = auth.user?.email || "";

  const page = el("div", { class: "page-shell" });
  page.append(
    el("header", { class: "page-head" }, [
      el("h1", { text: "Support" }),
      el("p", { text: "Hit a bug or have an idea to make BMO better? Tell us, and it goes straight to the team." }),
    ])
  );

  const nameInput = el("input", {
    class: "settings-input", type: "text", value: auth.user?.name || "",
    placeholder: "Your name", maxlength: "80", autocomplete: "name",
  });
  const emailInput = el("input", {
    class: "settings-input", type: "email", value: email,
    placeholder: "you@example.com", readonly: Boolean(email),
  });
  const messageInput = el("textarea", {
    class: "feedback-textarea", rows: "6", maxlength: "5000",
    placeholder: "What went wrong, what you expected, and how we could improve BMO…",
  });

  // Optional screenshot — images only (any image format), never PDF/other files.
  const fileInput = el("input", { type: "file", accept: "image/*", style: "display:none" });
  let chosenFile = null;
  const fileName = el("span", { class: "file-name muted", text: "No screenshot attached" });
  const removeBtn = el("button", {
    type: "button", class: "btn ghost sm", style: "display:none", text: "Remove",
    onclick: () => setFile(null),
  });
  function setFile(f) {
    chosenFile = f;
    fileName.textContent = f ? f.name : "No screenshot attached";
    fileName.classList.toggle("muted", !f);
    removeBtn.style.display = f ? "" : "none";
    if (!f) fileInput.value = "";
  }
  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      toast("Images only", { tone: "error" });
      fileInput.value = "";
      return;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      toast("Max 10 MB", { tone: "error" });
      fileInput.value = "";
      return;
    }
    setFile(f);
  });
  const attachBtn = el("button", {
    type: "button", class: "btn secondary sm",
    onclick: () => fileInput.click(),
    html: `${icon("image", { width: 14, height: 14 })} <span>Attach screenshot</span>`,
  });

  const sendBtn = el("button", {
    type: "submit", class: "btn primary feedback-send-btn",
    html: `<span>Send</span> ${icon("send", { width: 14, height: 14, class: "send-arrow-icon" })}`,
  });
  const sendHtml = sendBtn.innerHTML;

  const form = el("form", { class: "feedback-form" }, [
    field("Your name", nameInput),
    field("Email", emailInput, "Auto-filled from your account so we can reply."),
    field("Message", messageInput),
    el("div", { class: "settings-field" }, [
      el("label", { class: "field-label", text: "Screenshot (optional)" }),
      el("div", { class: "file-row" }, [attachBtn, removeBtn, fileName, fileInput]),
      el("p", { class: "field-hint", text: "Images only (PNG, JPG, GIF, WebP…). Max 10 MB." }),
    ]),
    el("div", { class: "settings-actions" }, [sendBtn]),
  ]);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = messageInput.value.trim();
    if (!message) {
      toast("Add a description", { tone: "error" });
      messageInput.focus();
      return;
    }
    sendBtn.disabled = true;
    sendBtn.innerHTML = "Sending…";
    const payload = {
      name: nameInput.value.trim() || auth.user?.name || "Anonymous",
      email: emailInput.value.trim(),
      message,
      _subject: "BMO support request",
    };
    try {
      let res;
      if (chosenFile) {
        // multipart so the screenshot rides along (Formspree file uploads).
        const fd = new FormData();
        for (const [k, v] of Object.entries(payload)) fd.append(k, v);
        fd.append("screenshot", chosenFile, chosenFile.name);
        res = await fetch(FORMSPREE_ENDPOINT, { method: "POST", body: fd, headers: { Accept: "application/json" } });
      } else {
        res = await fetch(FORMSPREE_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
        });
      }
      if (!res.ok) {
        let detail = "";
        try {
          const j = await res.json();
          detail = (j.errors || []).map((x) => x.message).filter(Boolean).join(", ");
        } catch { /* ignore */ }
        throw new Error(detail || `Could not send (${res.status})`);
      }
      toast("Sent", { tone: "success" });
      messageInput.value = "";
      setFile(null);
    } catch (err) {
      toast(err.message || "Couldn't send", { tone: "error" });
    } finally {
      sendBtn.disabled = false;
      sendBtn.innerHTML = sendHtml;
    }
  });

  page.append(
    el("div", { class: "settings-card glass" }, [
      el("div", { class: "section-title" }, [
        el("div", { class: "icon-box", html: icon("messageText", { width: 16, height: 16 }) }),
        el("h2", { text: "Send a message" }),
      ]),
      form,
    ])
  );

  host.append(page);
}
