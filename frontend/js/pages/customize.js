import { el, clear } from "../utils.js?v=51";
import { icon } from "../icons.js?v=75";
import { getAuth } from "../auth.js";
import { mountAppShell } from "../app-shell.js";
import * as api from "../api.js?v=62";
import { toast } from "../components/toast.js?v=58";
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
  const isCurrent = () => !disposed && page.isConnected && getAuth().auth?.user?.id === auth.user?.id;
  page.append(el("header", { class: "page-head" }, [
    el("h1", { text: "Customize" }),
    el("p", { text: "Make BIMO work your way." }),
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
  const counter = el("span", { class: "char-count", text: "0 / 4000" });
  const instructions = el("textarea", {
    class: "instructions-textarea customize-instructions", rows: 9, maxLength: 4000,
    id: "global-instructions", disabled: true, "aria-describedby": "global-instructions-hint",
    placeholder: "For example: Keep answers concise. Explain technical terms. Use British English.",
    oninput: syncInstructions,
  });
  const status = el("span", { class: "customize-status", role: "status" });
  const save = el("button", { type: "button", class: "btn primary", text: "Save", disabled: true, onclick: async () => {
    const snapshot = instructions.value;
    saving = true;
    status.textContent = "Saving…";
    syncInstructions();
    try {
      await api.saveInstructions(auth.token, snapshot);
      if (!isCurrent()) return;
      saved = snapshot;
      status.textContent = "Saved";
    } catch (error) {
      if (isCurrent()) status.textContent = error.message || "Could not save instructions.";
    } finally { saving = false; syncInstructions(); }
  } });
  function syncInstructions() {
    counter.textContent = `${instructions.value.length} / 4000`;
    save.disabled = instructions.disabled || saving || instructions.value === saved;
    if (!saving && instructions.value !== saved) status.textContent = "Unsaved changes";
  }
  panels[0].append(el("div", { class: "workspace-card" }, [
    el("label", { for: "global-instructions", class: "customize-label", text: "What would you like BIMO to know?" }),
    el("p", { id: "global-instructions-hint", class: "customize-hint", text: "Your preferences apply to every chat. BIMO’s safety rules still apply." }),
    instructions,
    el("div", { class: "customize-save-row" }, [counter, status, save]),
  ]));

  const grid = el("div", { class: "skills-grid" });
  const empty = el("div", { class: "customize-empty" }, [
    el("span", { html: icon("blocks", { width: 28, height: 28 }) }),
    el("h3", { text: "A little expertise, on demand" }),
    el("p", { text: "Save a reusable skill, then type / in a chat to use it. Choose up to three at a time." }),
  ]);
  const skillsStatus = el("p", { class: "customize-hint", role: "status", text: "Loading skills…" });
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
    closeEditor = openSkillEditor({ auth, skill, onSaved: updated => { if (isCurrent()) upsertCard(updated); } });
  }
  const upload = el("input", { type: "file", accept: ".md", hidden: true, onchange: async () => {
    const file = upload.files?.[0];
    upload.value = "";
    if (!file) return;
    if (!/\.md$/i.test(file.name)) {
      skillsStatus.textContent = "Choose a .md skill file with name and description in YAML frontmatter.";
      return;
    }
    skillsStatus.textContent = `Uploading ${file.name}…`;
    upload.disabled = true;
    try {
      const skill = await api.uploadSkill(auth.token, file);
      if (isCurrent()) { upsertCard(skill); skillsStatus.textContent = "Skill uploaded"; }
    } catch (error) { if (isCurrent()) skillsStatus.textContent = error.message || "Upload failed."; }
    finally { upload.disabled = false; }
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
    el("div", {}, [el("h2", { text: "Skills" }), el("p", { class: "customize-hint", text: "Upload .md skills with name and description in YAML frontmatter." })]), add,
  ]), upload, skillsStatus, grid, empty);

  function skillCard(skill) {
    const toggle = el("button", {
      type: "button", class: "skill-toggle", role: "switch", "aria-checked": String(skill.enabled),
      "aria-label": `Enable ${skill.name}`, title: skill.enabled ? "Enabled" : "Disabled",
      onclick: async () => {
        toggle.disabled = true;
        try { const updated = await api.setSkillEnabled(auth.token, skill.id, !skill.enabled); if (isCurrent()) upsertCard(updated); }
        catch (error) { toast(error.message, { tone: "error" }); toggle.disabled = false; }
      },
    }, [el("span", { "aria-hidden": "true" })]);
    return el("article", { class: "workspace-card skill-card" }, [
      el("div", { class: "skill-card-head" }, [el("h3", { text: skill.name }), toggle]),
      el("p", { class: "skill-description", text: skill.description }),
      el("div", { class: "skill-card-actions" }, [
        el("button", { type: "button", class: "btn secondary", text: "Edit", onclick: async event => {
          const button = event.currentTarget;
          button.disabled = true;
          try { const full = await api.getSkill(auth.token, skill.id); if (isCurrent()) edit(full); }
          catch (error) { toast(error.message, { tone: "error" }); }
          finally { button.disabled = false; }
        } }),
        el("button", { type: "button", class: "btn secondary", text: "Export", onclick: async event => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            const blob = await api.exportSkill(auth.token, skill.id);
            downloadBlob(blob, blob.type === "application/zip" ? `${skill.name}.zip` : "SKILL.md");
          }
          catch (error) { toast(error.message, { tone: "error" }); }
          finally { button.disabled = false; }
        } }),
        el("button", { type: "button", class: "btn secondary", text: "Delete", onclick: () => openConfirmModal({
          title: "Delete skill?", message: `Delete ${skill.name}? Previous messages will keep their skill labels.`, confirmText: "Delete",
          onConfirm: async () => {
            try {
              await api.deleteSkill(auth.token, skill.id);
              if (isCurrent()) { cards.get(skill.id)?.remove(); cards.delete(skill.id); empty.hidden = cards.size > 0; }
            } catch (error) { toast(error.message, { tone: "error" }); }
          },
        }) }),
      ]),
    ]);
  }

  // Load panels independently; a failed request stays retryable without rebuilding the page.
  async function loadInstructions() {
    status.textContent = "Loading…";
    try {
      const result = await api.getInstructions(auth.token);
      if (!isCurrent()) return;
      saved = result.instructions || "";
      instructions.value = saved;
      instructions.disabled = false;
      status.textContent = "";
      syncInstructions();
    } catch (error) { if (isCurrent()) status.replaceChildren(el("button", { type: "button", class: "btn secondary", text: "Retry loading instructions", title: error.message, onclick: loadInstructions })); }
  }
  async function loadSkills() {
    try {
      const skills = await api.listSkills(auth.token);
      if (!isCurrent()) return;
      skills.forEach(upsertCard);
      empty.hidden = cards.size > 0;
      skillsStatus.textContent = "";
    } catch (error) { if (isCurrent()) skillsStatus.replaceChildren(el("button", { type: "button", class: "btn secondary", text: "Retry loading skills", title: error.message, onclick: loadSkills })); }
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
