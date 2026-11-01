import { el } from "../utils.js?v=51";
import { icon } from "../icons.js?v=74";

let sequence = 0;

// This component updates only its popup and chips; the textarea/feed stay mounted.
export class SkillPicker {
  constructor(textarea) {
    this.textarea = textarea;
    this.skills = [];
    this.selectedIds = [];
    this.loaded = false;
    this.index = 0;
    this.matches = [];
    this.range = null;
    this.popup = el("div", { class: "skill-popup", id: `skill-options-${++sequence}`, role: "listbox", "aria-label": "Enabled skills", hidden: true });
    this.chips = el("div", { class: "composer-skill-chips", "aria-label": "Active skills", hidden: true });
    textarea.setAttribute("aria-controls", this.popup.id);
    textarea.setAttribute("aria-haspopup", "listbox");
    textarea.setAttribute("aria-expanded", "false");
    this.onInput = () => this.update();
    this.onClick = event => { if (!this.popup.contains(event.target) && event.target !== textarea) this.close(); };
    this.onBlur = () => { this.blurTimer = setTimeout(() => this.close(), 150); };
    textarea.addEventListener("input", this.onInput);
    textarea.addEventListener("click", this.onInput);
    textarea.addEventListener("blur", this.onBlur);
    document.addEventListener("pointerdown", this.onClick);
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
    this.chips.replaceChildren(...this.selected.map(skill => el("span", { class: "skill-chip" }, [
      el("span", { text: skill.name }),
      el("button", { type: "button", "aria-label": `Remove ${skill.name}`, onclick: () => {
        this.setSelected(this.selectedIds.filter(id => id !== skill.id));
        this.textarea.focus();
        this.update();
      } }, [el("span", { "aria-hidden": "true", html: icon("x", { width: 12, height: 12 }) })]),
    ])));
    this.chips.hidden = this.selectedIds.length === 0;
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
    this.matches = this.skills.filter(skill => !this.selectedIds.includes(skill.id) &&
      (skill.name.includes(query) || skill.description.toLowerCase().includes(query)));
    this.index = 0;
    this.popup.replaceChildren();
    if (this.selectedIds.length >= 3 || !this.matches.length) {
      const message = this.selectedIds.length >= 3 ? "Up to 3 skills per chat" : this.loaded ? "No matching enabled skills"
        : this.loadError ? "Could not load skills. Reopen this chat to retry." : "Loading skills…";
      this.popup.append(el("div", { class: "skill-popup-empty", role: "status", text: message }));
    } else {
      this.matches.forEach((skill, i) => {
        this.popup.append(el("div", { id: `${this.popup.id}-${i}`, class: "skill-option", role: "option", "aria-selected": String(i === 0),
          onpointerdown: event => event.preventDefault(),
          onclick: () => this.select(i),
        }, [el("strong", { text: skill.name }), el("span", { text: skill.description })]));
      });
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
    if (this.popup.hidden || event.isComposing) return false;
    if (event.key === "Escape") { event.preventDefault(); this.close(); return true; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      this.index = (this.index + (event.key === "ArrowDown" ? 1 : -1) + this.matches.length) % (this.matches.length || 1);
      this.syncActive(); return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && this.matches.length && this.selectedIds.length < 3) {
      event.preventDefault(); this.select(this.index); return true;
    }
    return false;
  }

  select(index) {
    const skill = this.matches[index];
    if (!skill || !this.range || this.selectedIds.length >= 3) return;
    clearTimeout(this.blurTimer);
    const { start, end } = this.range;
    this.textarea.setRangeText("", start, end, "end");
    this.setSelected([...this.selectedIds, skill.id]);
    this.close();
    this.textarea.focus();
    this.textarea.dispatchEvent(new Event("input", { bubbles: true }));
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
    this.close();
  }
}
