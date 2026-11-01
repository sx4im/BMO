import { el } from "../utils.js?v=51";
import { icon } from "../icons.js?v=76";

let sequence = 0;

// This component updates only its popup and chips; the textarea/feed stay mounted.
export class SkillPicker {
  constructor(textarea, { onAddFiles, onSelectionChange } = {}) {
    this.textarea = textarea;
    this.onAddFiles = onAddFiles;
    this.onSelectionChange = onSelectionChange;
    this.skills = [];
    this.selectedIds = [];
    this.loaded = false;
    this.index = 0;
    this.matches = [];
    this.range = null;
    this.popup = el("div", { class: "skill-popup", id: `skill-options-${++sequence}`, role: "listbox", "aria-label": "Enabled skills", hidden: true });
    this.chips = el("div", { class: "composer-skill-chips", "aria-label": "Active skills", hidden: true });
    this.previewName = el("strong");
    this.previewDescription = el("p");
    this.preview = el("div", { class: "skill-description-preview", id: `skill-preview-${sequence}`, role: "tooltip", hidden: true,
      onpointerenter: () => clearTimeout(this.previewTimer), onpointerleave: () => this.schedulePreviewClose(),
    }, [this.previewName, this.previewDescription]);
    textarea.setAttribute("aria-controls", this.popup.id);
    textarea.setAttribute("aria-haspopup", "listbox");
    textarea.setAttribute("aria-expanded", "false");
    this.onInput = () => { this.hidePreview(); this.update(); };
    this.onClick = event => {
      if (!this.popup.contains(event.target) && event.target !== textarea) this.close();
      if (!this.chips.contains(event.target) && !this.preview.contains(event.target)) this.hidePreview();
    };
    this.onEscape = event => { if (event.key === "Escape" && !this.preview.hidden) { event.preventDefault(); this.hidePreview(); } };
    this.onBlur = () => { this.blurTimer = setTimeout(() => this.close(), 150); };
    textarea.addEventListener("input", this.onInput);
    textarea.addEventListener("click", this.onInput);
    textarea.addEventListener("blur", this.onBlur);
    document.addEventListener("pointerdown", this.onClick);
    document.addEventListener("keydown", this.onEscape);
  }

  setCatalog(skills) {
    this.skills = skills.filter(skill => skill.enabled);
    this.loaded = true;
    this.setSelected(this.selectedIds);
    this.update();
  }

  setLoadError() {
    this.loadError = true;
    this.update();
  }

  setSelected(ids) {
    this.selectedIds = [...new Set(ids || [])].slice(0, 3);
    if (this.loaded) this.selectedIds = this.selectedIds.filter(id => this.skills.some(skill => skill.id === id));
    this.renderChips();
  }

  get selected() {
    return this.selectedIds.map(id => this.skills.find(skill => skill.id === id) || { id, name: "Skill" });
  }

  renderChips() {
    this.hidePreview();
    this.chips.replaceChildren(...this.selected.map(skill => el("span", { class: "skill-chip" }, [
      el("button", { type: "button", class: "skill-name", text: `/${skill.name}`, "aria-describedby": this.preview.id,
        onpointerenter: event => { if (event.pointerType !== "touch") this.showPreview(skill, event.currentTarget); },
        onpointerleave: () => this.schedulePreviewClose(), onblur: () => this.schedulePreviewClose(),
        onfocus: event => this.showPreview(skill, event.currentTarget), onclick: event => this.showPreview(skill, event.currentTarget),
      }),
      el("button", { type: "button", class: "skill-remove", "aria-label": `Remove ${skill.name}`, onclick: () => {
        this.setSelected(this.selectedIds.filter(id => id !== skill.id));
        this.textarea.focus();
        this.update();
      } }, [el("span", { "aria-hidden": "true", html: icon("x", { width: 12, height: 12 }) })]),
    ])));
    this.chips.hidden = this.selectedIds.length === 0;
    this.onSelectionChange?.();
  }

  showPreview(skill, trigger) {
    clearTimeout(this.previewTimer);
    this.close();
    this.previewTrigger = trigger;
    this.previewName.textContent = skill.name;
    this.previewDescription.textContent = skill.description || "No description available.";
    this.preview.hidden = false;
  }

  schedulePreviewClose() {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      if (document.activeElement !== this.previewTrigger && !this.preview.matches(":hover")) this.hidePreview();
    }, 150);
  }

  hidePreview() {
    clearTimeout(this.previewTimer);
    this.preview.hidden = true;
    this.previewTrigger = null;
  }

  update() {
    const cursor = this.textarea.selectionStart;
    const prefix = this.textarea.value.slice(0, cursor);
    const match = prefix.match(/(?:^|\s)\/([a-z0-9-]*)$/i);
    if (!match || this.textarea.selectionEnd !== cursor || !/^(\s|$)/.test(this.textarea.value.slice(cursor))) {
      this.close(); return;
    }
    this.range = { start: cursor - match[1].length - 1, end: cursor };
    const query = match[1].toLowerCase();
    const matchingSkills = this.skills.filter(skill => !this.selectedIds.includes(skill.id) &&
      (skill.name.includes(query) || skill.description.toLowerCase().includes(query)));
    this.matches = this.selectedIds.length >= 3 ? [] : [...matchingSkills];
    if (!query && this.onAddFiles) this.matches.unshift({ name: "Add files", isAttachment: true });
    this.index = 0;
    this.popup.replaceChildren();
    this.matches.forEach((choice, i) => {
      this.popup.append(el("div", { id: `${this.popup.id}-${i}`, class: "skill-option", role: "option", "aria-selected": String(i === 0),
        title: choice.description || choice.name, "aria-description": choice.description,
        onpointerdown: event => event.preventDefault(), onclick: () => this.select(i),
      }, [
        el("span", { class: "skill-option-icon", "aria-hidden": "true", html: icon(choice.isAttachment ? "attachFile" : "filePenLine", { width: 16, height: 16 }) }),
        el("span", { class: "skill-option-name", text: choice.name }),
      ]));
    });
    if (this.selectedIds.length >= 3 || !matchingSkills.length) {
      const message = this.selectedIds.length >= 3 ? "Up to 3 skills per chat" : this.loaded ? (query ? "No matching skills" : "No enabled skills yet")
        : this.loadError ? "Could not load skills. Reopen this chat to retry." : "Loading skills…";
      this.popup.append(el("div", { class: "skill-popup-empty", role: "status", text: message }));
    }
    this.popup.hidden = false;
    this.textarea.setAttribute("aria-expanded", "true");
    this.syncActive();
  }

  syncActive() {
    const options = [...this.popup.querySelectorAll('[role="option"]')];
    options.forEach((option, i) => option.setAttribute("aria-selected", String(i === this.index)));
    const active = options[this.index];
    if (active) {
      this.textarea.setAttribute("aria-activedescendant", active.id);
      active.scrollIntoView?.({ block: "nearest" });
    } else this.textarea.removeAttribute("aria-activedescendant");
  }

  handleKey(event) {
    if (!event.isComposing && event.key === "Backspace" && this.textarea.selectionStart === 0 && this.textarea.selectionEnd === 0 && this.selectedIds.length) {
      event.preventDefault();
      this.setSelected(this.selectedIds.slice(0, -1));
      this.close();
      return true;
    }
    if (this.popup.hidden || event.isComposing) return false;
    if (event.key === "Escape") { event.preventDefault(); this.close(); return true; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.index = (this.index + (event.key === "ArrowDown" ? 1 : -1) + this.matches.length) % (this.matches.length || 1);
      this.syncActive(); return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && this.matches.length) {
      event.preventDefault(); this.select(this.index); return true;
    }
    return false;
  }

  select(index) {
    const choice = this.matches[index];
    if (!choice || !this.range || (!choice.isAttachment && this.selectedIds.length >= 3)) return;
    clearTimeout(this.blurTimer);
    const { start, end } = this.range;
    this.textarea.setRangeText("", start, end, "end");
    if (!choice.isAttachment) this.setSelected([...this.selectedIds, choice.id]);
    this.close();
    this.textarea.focus();
    this.textarea.dispatchEvent(new Event("input", { bubbles: true }));
    if (choice.isAttachment) this.onAddFiles();
  }

  close() {
    this.popup.hidden = true;
    this.range = null;
    this.textarea.setAttribute("aria-expanded", "false");
    this.textarea.removeAttribute("aria-activedescendant");
  }

  destroy() {
    clearTimeout(this.blurTimer);
    this.textarea.removeEventListener("input", this.onInput);
    this.textarea.removeEventListener("click", this.onInput);
    this.textarea.removeEventListener("blur", this.onBlur);
    document.removeEventListener("pointerdown", this.onClick);
    document.removeEventListener("keydown", this.onEscape);
    this.hidePreview();
    this.close();
  }
}
