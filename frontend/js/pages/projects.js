/**
 * Projects view: Dashboard / Project List and Project Workspace.
 *
 * Modeled on Claude.ai Projects:
 * - Projects list: Overview cards with quick stats (files, chats, update time)
 * - Project workspace: Custom instructions editor, project knowledge files
 *   manager with live token meter, and project chats list with "New chat".
 */

import { el, clear, formatTitle } from "../utils.js?v=51";
import { icon, formatDocIcon } from "../icons.js?v=72";
import { toast } from "../components/toast.js?v=58";
import { openConfirmModal } from "../components/confirm-modal.js?v=58";
import * as api from "../api.js?v=30";
import { getAuth } from "../auth.js?v=31";
import { navigate } from "../router.js?v=31";
import { mountAppShell, loadConversations } from "../app-shell.js?v=30";

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

/**
 * Main route handler for #/app/projects and #/app/projects/:id
 */
export async function renderProjects({ id } = {}) {
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

  if (id) {
    await renderProjectWorkspace(host, auth, id);
  } else {
    await renderProjectsList(host, auth);
  }
}

/**
 * ---------------------------------------------------------------------------
 * Projects List View (#/app/projects)
 * ---------------------------------------------------------------------------
 */
async function renderProjectsList(host, auth) {
  clear(host);
  const page = el("div", { class: "page-shell projects-page" });
  host.append(page);

  const head = el("header", { class: "page-head projects-head" }, [
    el("div", { class: "projects-head-text" }, [
      el("h1", { text: "Projects" }),
      el("p", { text: "Curate instructions and reference documents to focus your chats." }),
    ]),
  ]);
  page.append(head);

  const fab = el(
    "button",
    {
      type: "button",
      class: "btn primary projects-fab",
      "aria-label": "New project",
      onclick: () => openProjectModal({ auth, onCreated: () => renderProjectsList(host, auth) }),
    },
    [
      el("span", { class: "btn-ic", html: icon("plus", { width: 22, height: 22 }) }),
      el("span", { text: "New project" }),
    ]
  );
  page.append(fab);

  const loadingSpinner = el("div", { class: "blade-spinner center" }, [
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
  ]);
  page.append(loadingSpinner);

  let projects = [];
  try {
    projects = await api.listProjects(auth.token);
  } catch (err) {
    loadingSpinner.remove();
    page.append(
      el("div", { class: "projects-error card" }, [
        el("p", { text: err.message || "Could not load projects." }),
        el(
          "button",
          {
            type: "button",
            class: "btn secondary",
            onclick: () => renderProjectsList(host, auth),
          },
          ["Retry"]
        ),
      ])
    );
    return;
  }
  loadingSpinner.remove();

  if (!projects.length) {
    const emptyState = el("div", { class: "projects-empty-state" }, [
      el("div", { class: "empty-icon-wrap", html: icon("galleryVerticalEnd", { width: 36, height: 36 }) }),
      el("h3", { text: "No projects yet" }),
      el("p", {
        text: "Create a project to bundle custom instructions, reference files, and chats together.",
      }),
      el(
        "button",
        {
          type: "button",
          class: "btn primary",
          onclick: () => openProjectModal({ auth, onCreated: () => renderProjectsList(host, auth) }),
        },
        [
          el("span", { class: "btn-ic", html: icon("plus", { width: 16, height: 16 }) }),
          el("span", { text: "Create your first project" }),
        ]
      ),
    ]);
    page.append(emptyState);
    return;
  }

  const searchWrap = el("div", { class: "projects-search-wrap" }, [
    el("span", { class: "projects-search-icon", html: icon("search", { width: 16, height: 16 }) }),
    el("input", {
      type: "search",
      class: "projects-search",
      placeholder: "Search projects",
      "aria-label": "Search projects",
      oninput: (e) => renderGrid(e.target.value.trim().toLowerCase()),
    }),
  ]);

  const grid = el("div", { class: "projects-grid" });
  const noResults = el("p", {
    class: "projects-no-results",
    text: "No projects match your search.",
    style: "display: none;",
  });

  function projectCard(proj) {
    const chatCount = proj.chat_count || 0;
    return el(
      "div",
      {
        class: "project-card",
        role: "button",
        tabindex: "0",
        onclick: () => navigate(`#/app/projects/${proj.id}`),
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            navigate(`#/app/projects/${proj.id}`);
          }
        },
      },
      [
        el("div", { class: "project-card-header" }, [
          el("div", { class: "project-card-icon", html: icon("galleryVerticalEnd", { width: 20, height: 20 }) }),
          el("h2", { class: "project-card-title", text: proj.name }),
        ]),
        el("p", {
          class: "project-card-desc",
          text: proj.description || "No description provided.",
        }),
        el("div", { class: "project-card-footer" }, [
          el("span", {
            class: "project-card-date",
            text: `Updated ${formatDate(proj.updated_at || proj.created_at)}`,
          }),
          chatCount
            ? el("span", {
                class: "project-card-chats",
                text: `${chatCount} chat${chatCount === 1 ? "" : "s"}`,
              })
            : null,
        ]),
      ]
    );
  }

  function renderGrid(query = "") {
    clear(grid);
    const list = query
      ? projects.filter((p) => `${p.name} ${p.description || ""}`.toLowerCase().includes(query))
      : projects;
    for (const proj of list) {
      grid.append(projectCard(proj));
    }
    noResults.style.display = list.length ? "none" : "block";
  }

  page.append(searchWrap);
  page.append(grid);
  page.append(noResults);
  renderGrid();
}

/**
 * ---------------------------------------------------------------------------
 * Project Workspace View (#/app/projects/:id)
 * ---------------------------------------------------------------------------
 */
async function renderProjectWorkspace(host, auth, projectId) {
  const page = el("div", { class: "page-shell project-workspace" });
  host.append(page);

  const loadingSpinner = el("div", { class: "blade-spinner center" }, [
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
    el("div", { class: "spinner-blade" }),
  ]);
  page.append(loadingSpinner);

  let project = null;
  try {
    project = await api.getProject(auth.token, projectId);
  } catch (err) {
    loadingSpinner.remove();
    page.append(
      el("div", { class: "projects-error card" }, [
        el("h3", { text: "Project not found" }),
        el("p", { text: err.message || "This project may have been deleted." }),
        el(
          "button",
          {
            type: "button",
            class: "btn secondary",
            onclick: () => navigate("#/app/projects"),
          },
          ["Back to Projects"]
        ),
      ])
    );
    return;
  }
  loadingSpinner.remove();

  // Top header: breadcrumbs, title + icon actions, description, primary CTA
  const breadcrumbs = el("div", { class: "workspace-breadcrumbs" }, [
    el("a", { href: "#/app/projects", class: "crumb-link", text: "Projects" }),
    el("span", { class: "crumb-sep", text: "/" }),
    el("span", { class: "crumb-current", text: project.name }),
  ]);

  const titleEl = el("h1", { class: "workspace-title", text: project.name });

  const editBtn = el(
    "button",
    {
      type: "button",
      class: "icon-btn",
      title: "Edit project name or description",
      "aria-label": "Edit project",
      onclick: () =>
        openProjectModal({
          auth,
          project,
          onUpdated: (up) => {
            project.name = up.name;
            project.description = up.description;
            titleEl.textContent = up.name;
            const cur = breadcrumbs.querySelector(".crumb-current");
            if (cur) cur.textContent = up.name;
            const descNode = page.querySelector(".workspace-summary-desc");
            if (descNode) descNode.textContent = up.description || "No description provided.";
          },
        }),
    },
    [el("span", { class: "btn-ic", html: icon("pencil", { width: 16, height: 16 }) })]
  );

  const deleteBtn = el(
    "button",
    {
      type: "button",
      class: "icon-btn danger",
      title: "Delete project",
      "aria-label": "Delete project",
      onclick: () => {
        openConfirmModal({
          title: "Delete project",
          message: `Permanently delete "${project.name}"? Knowledge files will be removed. Chats will be kept as regular chats.`,
          confirmText: "Delete project",
          cancelText: "Cancel",
          danger: true,
          onConfirm: async () => {
            try {
              await api.deleteProject(auth.token, project.id);
              toast("Project deleted", { tone: "warning" });
              navigate("#/app/projects");
            } catch (delErr) {
              toast(delErr.message || "Could not delete project", { tone: "error" });
            }
          },
        });
      },
    },
    [el("span", { class: "btn-ic", html: icon("trash", { width: 16, height: 16 }) })]
  );

  const workspaceHead = el("header", { class: "workspace-head" }, [
    breadcrumbs,
    el("div", { class: "workspace-title-row" }, [
      titleEl,
      el("div", { class: "workspace-icon-actions" }, [editBtn, deleteBtn]),
    ]),
    el("p", {
      class: "workspace-summary-desc",
      text: project.description || "No description provided.",
    }),
    el(
      "button",
      {
        type: "button",
        class: "btn primary workspace-cta",
        onclick: () => navigate(`#/app/chat?project_id=${project.id}`),
      },
      [
        el("span", { class: "btn-ic", html: icon("plus", { width: 16, height: 16 }) }),
        el("span", { text: "New chat in project" }),
      ]
    ),
  ]);
  page.append(workspaceHead);

  // Two-column layout
  const layout = el("div", { class: "workspace-layout" });
  page.append(layout);

  // Left column: Instructions + Chats
  const leftCol = el("div", { class: "workspace-col primary-col" });
  // Right column: Knowledge Files
  const rightCol = el("div", { class: "workspace-col secondary-col" });
  layout.append(leftCol, rightCol);

  // 1. Instructions Section
  const instructionsCard = renderInstructionsCard(project, auth);
  // 2. Chats Section
  const chatsCard = renderChatsCard(project);
  leftCol.append(instructionsCard, chatsCard);

  // 3. Knowledge Files Section
  const filesCard = renderFilesCard(project, auth);
  rightCol.append(filesCard);
}

/**
 * ---------------------------------------------------------------------------
 * Instructions Card Component
 * ---------------------------------------------------------------------------
 */
function renderInstructionsCard(project, auth) {
  let instructionsText = project.instructions || "";
  let saving = false;

  const charCounter = el("span", {
    class: "char-count",
    text: `${instructionsText.length} / 8000`,
  });

  const saveBtn = el(
    "button",
    {
      type: "button",
      class: "btn secondary sm save-instructions-btn",
      disabled: true,
      onclick: () => save(),
    },
    ["Save instructions"]
  );

  const textarea = el("textarea", {
    class: "instructions-textarea",
    placeholder:
      "What should BMO know when working in this project? (e.g. 'Use Python 3.12, keep answers concise, prefer functional patterns.')",
    maxlength: "8000",
    rows: 6,
    oninput: () => {
      charCounter.textContent = `${textarea.value.length} / 8000`;
      const changed = textarea.value.trim() !== (project.instructions || "").trim();
      saveBtn.disabled = !changed || saving;
    },
    onblur: () => {
      if (!saveBtn.disabled && !saving) save();
    },
  });
  textarea.value = instructionsText;

  async function save() {
    const nextVal = textarea.value.trim();
    if (nextVal === (project.instructions || "").trim()) return;
    saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      await api.updateProject(auth.token, project.id, { instructions: nextVal });
      project.instructions = nextVal;
      clear(saveBtn);
      saveBtn.append(
        el("span", { class: "btn-ic", html: icon("check", { width: 13, height: 13 }) }),
        el("span", { text: "Saved" })
      );
      toast("Instructions saved", { tone: "success" });
      setTimeout(() => {
        saveBtn.textContent = "Save instructions";
        saveBtn.disabled = true;
        saving = false;
      }, 1800);
    } catch (err) {
      saveBtn.textContent = "Save instructions";
      saveBtn.disabled = false;
      saving = false;
      toast(err.message || "Failed to save instructions", { tone: "error" });
    }
  }

  return el("div", { class: "workspace-card instructions-card" }, [
    el("div", { class: "card-head" }, [
      el("div", { class: "card-title-group" }, [
        el("h3", { text: "Project Instructions" }),
        el("p", {
          class: "card-hint",
          text: "Injected at the start of every chat prompt in this project.",
        }),
      ]),
      saveBtn,
    ]),
    textarea,
    el("div", { class: "card-footer" }, [charCounter]),
  ]);
}

/**
 * ---------------------------------------------------------------------------
 * File Preview Modal — shows the extracted text BMO parsed from a file.
 * ---------------------------------------------------------------------------
 */
function openFilePreviewModal(project, auth, file) {
  const body = el("pre", { class: "file-preview-body", text: "Loading…" });
  const close = () => {
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const overlay = el(
    "div",
    { class: "confirm-modal-overlay open", role: "dialog", "aria-modal": "true" },
    [
      el(
        "div",
        { class: "confirm-modal-card file-preview-card", onclick: (e) => e.stopPropagation() },
        [
          el("h3", { class: "confirm-modal-title", text: file.filename }),
          el("p", {
            class: "file-preview-sub",
            text: `~${(file.token_estimate || 0).toLocaleString()} tokens`,
          }),
          body,
          el("div", { class: "confirm-modal-actions" }, [
            el("button", {
              type: "button",
              class: "confirm-modal-btn cancel",
              text: "Close",
              onclick: close,
            }),
          ]),
        ]
      ),
    ]
  );
  overlay.onclick = close;
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  api
    .getProjectFilePreview(auth.token, project.id, file.id)
    .then((res) => {
      body.textContent = res.preview || "(No extractable text)";
      if (res.truncated) body.textContent += "\n\n…preview truncated.";
    })
    .catch((err) => {
      body.textContent = err.message || "Could not load preview.";
    });
}

/**
 * ---------------------------------------------------------------------------
 * Knowledge Files Card Component (Token Usage Meter, Upload, File List)
 * ---------------------------------------------------------------------------
 */
function renderFilesCard(project, auth) {
  let files = project.files || [];
  let tokensUsed = project.tokens_used || 0;
  const tokenBudget = project.token_budget || 100000;

  const card = el("div", { class: "workspace-card files-card" });

  // Token meter
  const meterFill = el("div", { class: "token-meter-fill" });
  const meterText = el("span", { class: "token-meter-text" });

  const budgetHint = el("p", { class: "budget-hint", style: "display: none;" });

  function syncBudgetHint(pct) {
    if (pct <= 85 || !files.length) {
      budgetHint.style.display = "none";
      return;
    }
    clear(budgetHint);
    budgetHint.append(el("span", { text: "Near budget. Largest files: " }));
    const top = [...files]
      .sort((a, b) => (b.token_estimate || 0) - (a.token_estimate || 0))
      .slice(0, 3);
    top.forEach((f, i) => {
      if (i > 0) budgetHint.append(el("span", { text: ", " }));
      budgetHint.append(
        el("span", {
          class: "budget-hint-file",
          text: `${f.filename} (~${(f.token_estimate || 0).toLocaleString()})`,
        })
      );
    });
    budgetHint.style.display = "block";
  }

  function syncMeter() {
    const pct = Math.min(100, Math.round((tokensUsed / tokenBudget) * 100));
    meterFill.style.width = `${pct}%`;
    meterFill.classList.toggle("warning", pct > 85);
    meterFill.classList.toggle("critical", pct >= 98);
    meterText.textContent = `${tokensUsed.toLocaleString()} / ${tokenBudget.toLocaleString()} tokens (${pct}%)`;
    syncBudgetHint(pct);
  }
  syncMeter();

  const meterWrap = el("div", { class: "token-meter-container" }, [
    el("div", { class: "token-meter-header" }, [
      el("span", { class: "meter-label", text: "Knowledge token budget" }),
      meterText,
    ]),
    el("div", { class: "token-meter-track" }, [meterFill]),
  ]);

  // Upload Area
  const fileInput = el("input", {
    type: "file",
    multiple: true,
    style: "display: none;",
    accept: ".txt,.md,.pdf,.docx,.csv,.json,.py,.js,.ts,.html,.css,.sql,.yaml,.yml",
    onchange: () => {
      const selected = Array.from(fileInput.files || []);
      if (!selected.length) return;
      fileInput.value = "";
      Promise.all(selected.map((file) => handleUpload(file)));
    },
  });

  const uploadArea = el(
    "div",
    {
      class: "file-dropzone",
      onclick: () => fileInput.click(),
      ondragover: (e) => {
        e.preventDefault();
        uploadArea.classList.add("dragover");
      },
      ondragleave: () => uploadArea.classList.remove("dragover"),
      ondrop: async (e) => {
        e.preventDefault();
        uploadArea.classList.remove("dragover");
        const dropped = Array.from(e.dataTransfer.files || []);
        Promise.all(dropped.map((file) => handleUpload(file)));
      },
    },
    [
      fileInput,
      el("div", { class: "dropzone-icon", html: icon("attachFile", { width: 22, height: 22 }) }),
      el("div", { class: "dropzone-text" }, [
        el("strong", { text: "Add files to project knowledge" }),
        el("span", { text: "PDF, DOCX, TXT, MD, CSV, JSON, code files (up to 10MB)" }),
      ]),
    ]
  );

  const fileListEl = el("ul", { class: "project-file-list" });

  function renderFileList() {
    clear(fileListEl);
    if (!files.length) {
      return;
    }
    for (const file of files) {
      const ext = file.filename.split(".").pop() || "";
      const row = el(
        "li",
        {
          class: "project-file-item file-previewable",
          role: "button",
          tabindex: "0",
          title: `Preview ${file.filename}`,
          onclick: () => openFilePreviewModal(project, auth, file),
          onkeydown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openFilePreviewModal(project, auth, file);
            }
          },
        },
        [
        el("span", { class: "file-icon", html: formatDocIcon(ext, { width: 16, height: 18 }) }),
        el("div", { class: "file-meta" }, [
          el("span", { class: "file-name", text: file.filename, title: file.filename }),
          el("span", {
            class: "file-subtext",
            text: `${formatBytes(file.size_bytes)} · ~${(file.token_estimate || 0).toLocaleString()} tokens`,
          }),
        ]),
        el(
          "button",
          {
            type: "button",
            class: "file-delete-btn",
            title: `Remove ${file.filename}`,
            "aria-label": `Remove ${file.filename}`,
            onclick: (e) => {
              e.stopPropagation();
              openConfirmModal({
                title: "Remove file",
                message: `Are you sure you want to remove "${file.filename}" from project knowledge?`,
                confirmText: "Remove",
                danger: true,
                onConfirm: async () => {
                  try {
                    await api.deleteProjectFile(auth.token, project.id, file.id);
                    tokensUsed = Math.max(0, tokensUsed - (file.token_estimate || 0));
                    files = files.filter((f) => f.id !== file.id);
                    syncMeter();
                    renderFileList();
                    toast("File removed", { tone: "warning" });
                  } catch (err) {
                    toast(err.message || "Could not remove file", { tone: "error" });
                  }
                },
              });
            },
            html: icon("trash", { width: 14, height: 14 }),
          }
        ),
      ]);
      fileListEl.append(row);
    }
  }

  const uploadProgressEl = el("ul", { class: "upload-progress-list" });

  async function handleUpload(file) {
    if (file.size > 10 * 1024 * 1024) {
      toast(`"${file.name}" is over 10MB limit.`, { tone: "error" });
      return;
    }
    const barFill = el("div", { class: "upload-progress-fill" });
    const row = el("li", { class: "upload-progress-row" }, [
      el("span", { class: "upload-progress-name", text: file.name, title: file.name }),
      el("div", { class: "upload-progress-track" }, [barFill]),
    ]);
    uploadProgressEl.append(row);
    try {
      const result = await api.uploadProjectFileWithProgress(
        auth.token,
        project.id,
        file,
        (p) => {
          barFill.style.width = `${Math.round(p * 100)}%`;
        }
      );
      if (result?.file) {
        files.unshift(result.file);
        tokensUsed = result.tokens_used ?? tokensUsed + (result.file.token_estimate || 0);
        syncMeter();
        renderFileList();
        toast(`Added "${file.name}" (${(result.file.token_estimate || 0).toLocaleString()} tokens)`, {
          tone: "success",
        });
      }
    } catch (err) {
      toast(err.message || `Upload failed for ${file.name}`, { tone: "error" });
    } finally {
      row.remove();
    }
  }

  renderFileList();

  card.append(
    el("div", { class: "card-head" }, [
      el("div", { class: "card-title-group" }, [
        el("h3", { text: "Project Knowledge" }),
        el("p", {
          class: "card-hint",
          text: "Files are parsed and provided as untrusted reference context to the model.",
        }),
      ]),
    ]),
    meterWrap,
    budgetHint,
    uploadArea,
    uploadProgressEl,
    fileListEl
  );

  return card;
}

/**
 * ---------------------------------------------------------------------------
 * Project Chats Card Component
 * ---------------------------------------------------------------------------
 */
function renderChatsCard(project) {
  const conversations = project.conversations || [];

  const chatList = el("ul", { class: "project-chats-list" });
  if (!conversations.length) {
    chatList.append(
      el("li", {
        class: "chat-list-empty",
        text: "No conversations in this project yet. Start a new chat to begin collaborating with project context.",
      })
    );
  } else {
    for (const c of conversations) {
      const item = el(
        "li",
        {
          class: "project-chat-item",
          onclick: () => navigate(`#/app/chat/${c.id}`),
        },
        [
          el("span", { class: "chat-item-icon", html: icon("messageText", { width: 16, height: 16 }) }),
          el("span", { class: "chat-item-title", text: formatTitle(c.title || "Untitled chat") }),
          el("span", { class: "chat-item-date", text: formatDate(c.updated_at || c.created_at) }),
        ]
      );
      chatList.append(item);
    }
  }

  return el("div", { class: "workspace-card chats-card" }, [
    el("div", { class: "card-head" }, [
      el("div", { class: "card-title-group" }, [
        el("h3", { text: "Project Chats" }),
        el("p", { class: "card-hint", text: "Chats that inherit this project's instructions and knowledge." }),
      ]),
      el(
        "button",
        {
          type: "button",
          class: "btn secondary sm",
          onclick: () => navigate(`#/app/chat?project_id=${project.id}`),
        },
        [
          el("span", { class: "btn-ic", html: icon("plus", { width: 13, height: 13 }) }),
          el("span", { text: "New chat" }),
        ]
      ),
    ]),
    chatList,
  ]);
}

/**
 * ---------------------------------------------------------------------------
 * Create / Edit Project Modal
 * ---------------------------------------------------------------------------
 */
export function openProjectModal({ auth, project = null, onCreated, onUpdated }) {
  const isEdit = Boolean(project);

  const titleText = isEdit ? "Edit project" : "New project";
  const nameInput = el("input", {
    type: "text",
    class: "confirm-modal-input",
    placeholder: "Project name (e.g. BMO 2.0 Redesign)",
    maxlength: "100",
    value: project ? project.name : "",
    required: true,
  });

  const descInput = el("textarea", {
    class: "confirm-modal-input project-modal-desc",
    placeholder: "Short description (optional)",
    maxlength: "500",
    rows: 2,
  });
  if (project?.description) descInput.value = project.description;

  const cancelBtn = el("button", { type: "button", class: "confirm-modal-btn cancel" }, ["Cancel"]);
  const submitBtn = el("button", { type: "button", class: "confirm-modal-btn primary" }, [
    isEdit ? "Save changes" : "Create project",
  ]);

  const overlay = el(
    "div",
    { class: "confirm-modal-overlay open", role: "dialog", "aria-modal": "true" },
    [
      el(
        "div",
        { class: "confirm-modal-card project-modal-card", onclick: (e) => e.stopPropagation() },
        [
          el("h3", { class: "confirm-modal-title", text: titleText }),
          el("div", { class: "project-modal-fields" }, [
            el("label", { class: "confirm-modal-field" }, [
              el("span", { class: "confirm-modal-field-label", text: "Name" }),
              nameInput,
            ]),
            el("label", { class: "confirm-modal-field" }, [
              el("span", { class: "confirm-modal-field-label", text: "Description" }),
              descInput,
            ]),
          ]),
          el("div", { class: "confirm-modal-actions" }, [cancelBtn, submitBtn]),
        ]
      ),
    ]
  );

  function closeModal() {
    overlay.classList.remove("open");
    setTimeout(() => overlay.remove(), 160);
  }

  cancelBtn.onclick = closeModal;
  overlay.onclick = closeModal;

  submitBtn.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    const description = descInput.value.trim();
    submitBtn.disabled = true;
    submitBtn.textContent = isEdit ? "Saving…" : "Creating…";

    try {
      if (isEdit) {
        const updated = await api.updateProject(auth.token, project.id, { name, description });
        closeModal();
        toast("Project updated", { tone: "success" });
        onUpdated && onUpdated(updated);
      } else {
        const created = await api.createProject(auth.token, { name, description });
        closeModal();
        toast("Project created", { tone: "success" });
        onCreated && onCreated(created);
        navigate(`#/app/projects/${created.id}`);
      }
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit ? "Save changes" : "Create project";
      toast(err.message || "Failed to save project", { tone: "error" });
    }
  };

  document.body.append(overlay);
  setTimeout(() => nameInput.focus(), 50);
}

/**
 * ---------------------------------------------------------------------------
 * Move Chat to Project Picker Modal
 * ---------------------------------------------------------------------------
 */
export async function openMoveChatModal({ auth, conversation, onMoved }) {
  let projects = [];
  try {
    projects = await api.listProjects(auth.token);
  } catch (err) {
    toast(err.message || "Could not load projects", { tone: "error" });
    return;
  }

  const currentProjectId = conversation.project_id || null;

  const cancelBtn = el("button", { type: "button", class: "confirm-modal-btn cancel" }, ["Cancel"]);

  const listEl = el("div", { class: "project-picker-list" });

  const noneSelected = currentProjectId === null;
  const noneOption = el(
    "button",
    {
      type: "button",
      class: `project-picker-option${noneSelected ? " selected" : ""}`,
      onclick: () => select(null),
    },
    [
      el("span", { class: "picker-icon", html: icon("messageSquare", { width: 16, height: 16 }) }),
      el("span", { class: "picker-title", text: "No project (Standalone chat)" }),
      noneSelected ? el("span", { class: "picker-check", html: icon("check", { width: 14, height: 14 }) }) : null,
    ]
  );
  listEl.append(noneOption);

  for (const p of projects) {
    const isSelected = p.id === currentProjectId;
    const opt = el(
      "button",
      {
        type: "button",
        class: `project-picker-option${isSelected ? " selected" : ""}`,
        onclick: () => select(p.id),
      },
      [
        el("span", { class: "picker-icon", html: icon("galleryVerticalEnd", { width: 16, height: 16 }) }),
        el("span", { class: "picker-title", text: p.name }),
        isSelected ? el("span", { class: "picker-check", html: icon("check", { width: 14, height: 14 }) }) : null,
      ]
    );
    listEl.append(opt);
  }

  const overlay = el(
    "div",
    { class: "confirm-modal-overlay open", role: "dialog", "aria-modal": "true" },
    [
      el(
        "div",
        { class: "confirm-modal-card project-picker-card", onclick: (e) => e.stopPropagation() },
        [
          el("h3", { class: "confirm-modal-title", text: "Move chat to project" }),
          el("p", {
            class: "confirm-modal-message",
            text: `Select where "${formatTitle(conversation.title)}" should live:`,
          }),
          listEl,
          el("div", { class: "confirm-modal-actions" }, [cancelBtn]),
        ]
      ),
    ]
  );

  function closeModal() {
    overlay.classList.remove("open");
    setTimeout(() => overlay.remove(), 160);
  }

  cancelBtn.onclick = closeModal;
  overlay.onclick = closeModal;

  async function select(targetProjectId) {
    if (targetProjectId === currentProjectId) {
      closeModal();
      return;
    }
    closeModal();
    try {
      await api.updateConversation(auth.token, conversation.id, { project_id: targetProjectId });
      conversation.project_id = targetProjectId;
      toast(targetProjectId ? "Chat moved to project" : "Chat removed from project", { tone: "success" });
      onMoved && onMoved(targetProjectId);
      loadConversations();
    } catch (err) {
      toast(err.message || "Failed to move chat", { tone: "error" });
    }
  }

  document.body.append(overlay);
}
