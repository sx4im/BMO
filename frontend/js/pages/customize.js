import { el, clear } from "../utils.js?v=51";
import { icon } from "../icons.js?v=75";
import { getAuth } from "../auth.js";
import { mountAppShell } from "../app-shell.js";
import * as api from "../api.js?v=64";
import { openConfirmModal } from "../components/confirm-modal.js?v=58";
import { downloadBlob } from "../export.js?v=4";

export async function renderCustomize() {
  const { auth } = getAuth();
  if (!auth) return;
  const shell = await mountAppShell();
  shell.setActiveConversation(null);
  shell.setIncognitoActive?.(false);
  const page = el("div", { class: "page-shell customize-page" });
  clear(shell.content);
  shell.content.append(page);
  let disposed = false;
  let closeEditor = null;
  const loading = label => el("div", { class: "customize-loading", "aria-label": label }, [
    el("div", { class: "blade-spinner center", "aria-hidden": "true" }, Array.from({ length: 12 }, () => el("div", { class: "spinner-blade" }))),
  ]);
  const isCurrent = () => !disposed && page.isConnected && getAuth().auth?.user?.id === auth.user?.id;
  page.append(el("header", { class: "page-head" }, [
    el("h1", { text: "Customize" }),
    el("p", { text: "Make Bmo work your way." }),
  ]));

  const panels = [el("section", { id: "customize-instructions", role: "tabpanel", "aria-labelledby": "tab-instructions" }),
    el("section", { id: "customize-skills", role: "tabpanel", "aria-labelledby": "tab-skills", hidden: true })];
  const tabs = ["Instructions", "Skills"].map((name, i) => el("button", {
    type: "button", id: `tab-${name.toLowerCase()}`, role: "tab", "aria-selected": String(i === 0),
    "aria-controls": panels[i].id, tabindex: i === 0 ? "0" : "-1", text: name,
    onclick: () => selectTab(i),
    onkeydown: event => {
      const next = event.key === "ArrowRight" || event.key === "ArrowLeft" ? 1 - i
        : event.key === "Home" ? 0 : event.key === "End" ? 1 : null;
      if (next !== null) { event.preventDefault(); selectTab(next); tabs[next].focus(); }
    },
  }));
  function selectTab(index) {
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
  }
  page.append(el("div", { class: "customize-tabs", role: "tablist", "aria-label": "Customize" }, tabs), ...panels);

  let saved = "";
  let saving = false;
  let instructionError = "";
  let instructionNotice = "";
  const counter = el("span", { class: "char-count", text: "0 / 4000" });
  const instructions = el("textarea", {
    class: "instructions-textarea customize-instructions", rows: 9, maxLength: 4000,
    id: "global-instructions", disabled: true, "aria-describedby": "global-instructions-hint",
    placeholder: "For example: Keep answers concise. Explain technical terms. Use British English.",
    oninput: () => { instructionError = ""; syncInstructions(); },
  });
  const status = el("span", { class: "customize-status", role: "status" });
  const save = el("button", { type: "button", class: "btn primary", text: "Save", disabled: true, onclick: async () => {
    const snapshot = instructions.value;
    saving = true;
    instructionError = "";
    status.textContent = "Saving…";
    syncInstructions();
    try {
      await api.saveInstructions(auth.token, snapshot);
      if (!isCurrent()) return;
      saved = snapshot;
      instructionNotice = "Saved";
    } catch (error) {
      if (isCurrent()) instructionError = error.message || "Could not save instructions.";
    } finally { saving = false; syncInstructions(); }
  } });
  function syncInstructions() {
    counter.textContent = `${instructions.value.length} / 4000`;
    save.disabled = instructions.disabled || saving || instructions.value === saved;
    status.classList.toggle("error", Boolean(instructionError));
    status.setAttribute("role", instructionError ? "alert" : "status");
    status.textContent = saving ? "Saving…" : instructionError || (instructions.value !== saved ? "Unsaved changes" : instructionNotice);
  }
  const instructionsLoading = loading("Loading instructions…");
  instructionsLoading.setAttribute("role", "status");
  const instructionsCard = el("div", { class: "workspace-card", hidden: true }, [
    el("label", { for: "global-instructions", class: "customize-label", text: "What would you like Bmo to know?" }),
    el("p", { id: "global-instructions-hint", class: "customize-hint", text: "Your preferences apply to every chat. Bmo’s safety rules still apply." }),
    instructions,
    el("div", { class: "customize-save-row" }, [counter, status, save]),
  ]);
  panels[0].append(instructionsLoading, instructionsCard);

  const grid = el("div", { class: "skills-grid" });
  const empty = el("div", { class: "customize-empty", hidden: true }, [
    el("h3", { text: "A little expertise, on demand" }),
    el("p", { text: "Save a reusable skill, then type / in a chat to use it. Choose up to three at a time." }),
  ]);
  const skillsStatus = el("div", { class: "skills-load-status", role: "status" });
  const feedback = el("div", { class: "skills-feedback", hidden: true, role: "status" });
  const uploadName = el("span", { class: "skill-upload-name" });
  const uploadStage = el("span", { class: "skill-upload-stage", role: "status" });
  const uploadFill = el("span", { class: "skill-upload-fill" });
  const uploadTrack = el("div", { class: "skill-upload-track", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, [uploadFill]);
  const progress = el("div", { class: "skill-upload-progress", hidden: true, "aria-busy": "true" }, [
    el("div", { class: "skill-upload-meta" }, [
      el("span", { class: "skills-menu-icon", html: icon("upload", { width: 18, height: 18 }) }), uploadName, uploadStage,
    ]), uploadTrack,
  ]);
  const skillChatUrl = skill => `#/app/chat?skill_id=${encodeURIComponent(skill.id)}`;
  function showFeedback(message, error = false, skill = null) {
    feedback.hidden = false;
    feedback.classList.toggle("error", error);
    feedback.setAttribute("role", error ? "alert" : "status");
    feedback.replaceChildren(el("span", { text: message }));
    if (skill) feedback.append(el("a", { class: "btn secondary", href: skillChatUrl(skill), text: "Use in chat" }));
  }
  const cards = new Map();
  function upsertCard(skill) {
    const card = skillCard(skill);
    const previous = cards.get(skill.id);
    if (previous) previous.replaceWith(card);
    else grid.append(card);
    cards.set(skill.id, card);
    empty.hidden = cards.size > 0;
  }
  function edit(skill) {
    closeEditor?.();
    closeEditor = openSkillEditor({ auth, skill, onSaved: updated => {
      if (isCurrent()) { upsertCard(updated); showFeedback(`“${updated.name}” saved.`, false, updated.enabled ? updated : null); }
    } });
  }
  const upload = el("input", { type: "file", accept: ".md", hidden: true, onchange: async () => {
    const file = upload.files?.[0];
    upload.value = "";
    if (!file || upload.disabled) return;
    feedback.hidden = true;
    if (!/\.md$/i.test(file.name)) {
      showFeedback("Choose a Markdown (.md) skill file.", true);
      return;
    }
    if (file.size > 128 * 1024) {
      showFeedback("This skill is too large. Choose a file smaller than 128 KB.", true);
      return;
    }
    uploadName.textContent = file.name;
    uploadName.title = file.name;
    progress.hidden = false;
    function updateProgress(fraction) {
      if (!isCurrent()) return;
      const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
      const checking = fraction >= 1;
      uploadStage.textContent = checking ? "Checking skill…" : `Uploading ${percent}%`;
      uploadTrack.classList.toggle("processing", checking);
      uploadTrack.setAttribute("aria-label", `${checking ? "Checking" : "Uploading"} ${file.name}`);
      if (checking) uploadTrack.removeAttribute("aria-valuenow");
      else uploadTrack.setAttribute("aria-valuenow", String(percent));
      uploadFill.style.width = checking ? "35%" : `${percent}%`;
    }
    updateProgress(0);
    upload.disabled = true;
    try {
      const skill = await api.uploadSkill(auth.token, file, updateProgress);
      if (!skill?.id || typeof skill.name !== "string" || typeof skill.description !== "string") throw Error("The skill could not be saved. Please try again.");
      if (isCurrent()) { upsertCard(skill); showFeedback(`“${skill.name}” added.`, false, skill); }
    } catch (error) { if (isCurrent()) showFeedback(error.message || "Upload failed. Please try again.", true); }
    finally { upload.disabled = false; progress.hidden = true; }
  } });
  const add = el("details", { class: "skills-add" });
  const menuIcon = name => el("span", { class: "skills-menu-icon", html: icon(name, { width: 18, height: 18 }) });
  add.append(el("summary", { class: "btn secondary" }, [menuIcon("plus"), el("span", { text: "Add skill" })]), el("div", { class: "skills-add-menu" }, [
    el("button", { type: "button", onclick: () => { add.open = false; edit(null); } }, [menuIcon("feather"), el("span", { text: "Write skill" })]),
    el("button", { type: "button", onclick: () => { add.open = false; upload.click(); } }, [menuIcon("upload"), el("span", { text: "Upload skill" })]),
  ]));
  const closeAdd = event => { if (!add.contains(event.target) || event.key === "Escape") add.open = false; };
  document.addEventListener("pointerdown", closeAdd);
  add.addEventListener("keydown", closeAdd);
  panels[1].append(el("div", { class: "skills-heading" }, [
    el("h2", { text: "Skills" }), add,
  ]), upload, progress, feedback, skillsStatus, grid, empty);

  function skillCard(skill) {
    const cardError = el("p", { class: "skill-card-error", role: "alert", hidden: true });
    const showCardError = error => {
      if (!isCurrent()) return;
      cardError.textContent = error.message || "Could not update this skill. Please try again.";
      cardError.hidden = false;
    };
    const toggle = el("button", {
      type: "button", class: "skill-toggle", role: "switch", "aria-checked": String(skill.enabled),
      "aria-label": `Enable ${skill.name}`, title: skill.enabled ? "Enabled" : "Disabled",
      onclick: async () => {
        toggle.disabled = true;
        cardError.hidden = true;
        try { const updated = await api.setSkillEnabled(auth.token, skill.id, !skill.enabled); if (isCurrent()) upsertCard(updated); }
        catch (error) { showCardError(error); toggle.disabled = false; }
      },
    }, [el("span", { "aria-hidden": "true" })]);
    return el("article", { class: "workspace-card skill-card" }, [
      el("div", { class: "skill-card-head" }, [el("h3", {}, [skill.enabled
        ? el("a", { class: "skill-use-link", href: skillChatUrl(skill), title: "Use in a new chat", text: skill.name })
        : el("span", { text: skill.name })]), toggle]),
      el("p", { class: "skill-description", text: skill.description, title: skill.description }),
      el("div", { class: "skill-card-actions" }, [
        el("button", { type: "button", class: "btn secondary workspace-action", onclick: async event => {
          const button = event.currentTarget;
          button.disabled = true;
          try { const full = await api.getSkill(auth.token, skill.id); if (isCurrent()) edit(full); }
          catch (error) { showCardError(error); }
          finally { button.disabled = false; }
        } }, [
          el("span", { class: "btn-ic", html: icon("pencil", { width: 16, height: 16 }) }),
          el("span", { text: "Edit" }),
        ]),
        el("button", { type: "button", class: "btn secondary workspace-action", onclick: async event => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const blob = await api.exportSkill(auth.token, skill.id);
            downloadBlob(blob, blob.type === "application/zip" ? `${skill.name}.zip` : "SKILL.md");
          }
          catch (error) { showCardError(error); }
          finally { button.disabled = false; }
        } }, [
          el("span", { class: "btn-ic", html: icon("download", { width: 16, height: 16 }) }),
          el("span", { text: "Export" }),
        ]),
        el("button", { type: "button", class: "btn secondary workspace-action", onclick: () => openConfirmModal({
          title: "Delete skill?", message: `Delete ${skill.name}? Previous messages will keep their skill labels.`, confirmText: "Delete",
          onConfirm: async () => {
            try {
              await api.deleteSkill(auth.token, skill.id);
              if (isCurrent()) { cards.get(skill.id)?.remove(); cards.delete(skill.id); empty.hidden = cards.size > 0; }
            } catch (error) { showCardError(error); }
          },
        }) }, [
          el("span", { class: "btn-ic", html: icon("trash", { width: 16, height: 16 }) }),
          el("span", { text: "Delete" }),
        ]),
      ]),
      cardError,
    ]);
  }

  // Load panels independently; a failed request stays retryable without rebuilding the page.
  async function loadInstructions() {
    instructionsLoading.hidden = false;
    instructionsCard.hidden = true;
    panels[0].setAttribute("aria-busy", "true");
    instructionError = "";
    status.textContent = "";
    try {
      const result = await api.getInstructions(auth.token);
      if (!isCurrent()) return;
      saved = result.instructions || "";
      instructions.value = saved;
      instructions.disabled = false;
      status.textContent = "";
      syncInstructions();
    } catch (error) {
      if (isCurrent()) {
        instructionError = error.message || "Could not load instructions.";
        syncInstructions();
        status.append(el("button", { type: "button", class: "btn secondary", text: "Retry", onclick: loadInstructions }));
      }
    }
    finally { instructionsLoading.hidden = true; instructionsCard.hidden = false; panels[0].setAttribute("aria-busy", "false"); }
  }
  async function loadSkills() {
    skillsStatus.classList.remove("error");
    skillsStatus.setAttribute("role", "status");
    panels[1].setAttribute("aria-busy", "true");
    skillsStatus.replaceChildren(loading("Loading skills…"));
    try {
      const skills = await api.listSkills(auth.token);
      if (!isCurrent()) return;
      skills.forEach(upsertCard);
      empty.hidden = cards.size > 0;
      skillsStatus.replaceChildren();
    } catch (error) {
      if (isCurrent()) {
        skillsStatus.classList.add("error");
        skillsStatus.setAttribute("role", "alert");
        skillsStatus.replaceChildren(el("span", { text: error.message || "Could not load skills." }), el("button", { type: "button", class: "btn secondary", text: "Retry", onclick: loadSkills }));
      }
    } finally { panels[1].setAttribute("aria-busy", "false"); }
  }
  loadInstructions();
  loadSkills();
  return () => { disposed = true; closeEditor?.(); document.removeEventListener("pointerdown", closeAdd); };
}

export function openSkillEditor({ auth, skill, onSaved }) {
  const previousFocus = document.activeElement;
  const dialog = el("dialog", { class: "skill-editor", "aria-labelledby": "skill-editor-title" });
  const error = el("p", { class: "skill-editor-error", role: "alert" });
  const name = el("input", { class: "confirm-modal-input", required: true, maxLength: 64,
    pattern: "[a-z0-9]+(-[a-z0-9]+)*", value: skill?.name || "", autocomplete: "off", autocapitalize: "none", spellcheck: false,
    title: "Lowercase letters, numbers, and single hyphens; no leading or trailing hyphen." });
  const description = el("textarea", { class: "instructions-textarea", required: true, maxLength: 1024, rows: 2 });
  const instructions = el("textarea", { class: "instructions-textarea skill-editor-body", maxLength: 20000, rows: 10 });
  description.value = skill?.description || "";
  instructions.value = skill?.instructions || "";
  const close = () => {
    dialog.close(); dialog.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
    else document.querySelector("#tab-skills")?.focus();
  };
  const save = el("button", { type: "submit", class: "btn primary", text: "Save skill" });
  function field(label, input, limit) {
    const count = el("span", { class: "char-count", text: `${input.value.length} / ${limit}` });
    input.addEventListener("input", () => { count.textContent = `${input.value.length} / ${limit}`; });
    return el("label", { class: "skill-editor-field" }, [el("span", { class: "customize-label", text: label }), input, count]);
  }
  const form = el("form", { onsubmit: async event => {
    event.preventDefault();
    save.disabled = true;
    error.textContent = "";
    const values = { name: name.value, description: description.value, instructions: instructions.value };
    try {
      const result = skill ? await api.updateSkill(auth.token, skill.id, values) : await api.createSkill(auth.token, values);
      onSaved(result);
      close();
    } catch (failure) { error.textContent = failure.message || "Could not save skill."; }
    finally { save.disabled = false; }
  } }, [
    el("h2", { id: "skill-editor-title", text: skill ? "Edit skill" : "Write a skill" }),
    field("Name", name, 64), field("Description", description, 1024), field("Instructions", instructions, 20000),
  ]);
  if (skill?.files?.length) form.append(el("p", { class: "customize-hint", text: `Text references: ${skill.files.map(file => file.filename).join(", ")}. These are preserved when editing.` }));
  form.append(error, el("div", { class: "skill-card-actions" }, [el("button", { type: "button", class: "btn secondary", text: "Cancel", onclick: close }), save]));
  dialog.append(form);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  document.body.append(dialog);
  dialog.showModal();
  name.focus();
  return close;
}
