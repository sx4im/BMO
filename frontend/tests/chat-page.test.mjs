import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./modules.mjs";

async function chatPage({ incognito = false, messages = [], id, skills = [], activeSkills = [], hash } = {}) {
  let composer, feed, voice, lastRender;
  const payloads = [], branchCalls = [], notices = [], downloads = [], printed = [], converted = [];
  const shareStates = [], shareCallbacks = [];
  let app;
  class Feed {
    constructor(callbacks) {
      feed = this;
      this.callbacks = callbacks;
      this.element = app.dom.window.document.createElement("div");
      this.stream = this.element;
      this.follower = { attach() {} };
    }
    render(value) { lastRender = { ...value, messages: value.messages.map(m => ({ ...m })) }; }
    mountScrollFollower() {} unmountScrollFollower() {} scrollToBottom() {}
    updateStreamingBubble() {} finishStreamingBubble() {} setStatusText() {} setStreamingReasoningTimer() {}
  }
  const api = {
    listSkills: async () => skills,
    listModels: async () => ({ models: [{ id: "thinking", label: "Stanza" }], default: "thinking" }),
    listConversations: async () => [],
    getMessages: async () => ({ conversation: { id, model: "thinking", title: "Original chat", active_skills: activeSkills }, messages }),
    branchConversation: async (_token, parentId, messageId) => {
      branchCalls.push({ parentId, messageId });
      const prefix = messages.slice(0, messages.findIndex(m => m.id === messageId));
      return { conversation: { id: "branch", model: "thinking", title: "Branched chat" },
               messages: prefix.map(m => ({ ...m, id: `copy-${m.id}`, conversation_id: "branch" })) };
    },
    streamChat: async (_token, payload, callbacks) => {
      payloads.push(structuredClone(payload));
      const turn = payloads.length;
      callbacks.onConversation({ id: incognito ? "incognito_test" : payload.conversation_id || "saved", model: "thinking" });
      callbacks.onUserMessage({ id: `user-${turn}`, role: "user", content: payload.message, attachments: payload.attachments,
        skills: (payload.skill_ids || []).map(id => ({ id, name: skills.find(skill => skill.id === id)?.name || "Skill" })) });
      callbacks.onToken({ delta: `Answer ${turn}` });
      callbacks.onComplete();
      callbacks.onAssistantMessage({ id: `assistant-${turn}`, role: "assistant", content: `Answer ${turn}` });
    },
    cancelChat: async () => {},
    exportDocument: async () => { throw Error("Export service unavailable"); },
  };
  const stubs = {
    "auth.js": { getAuth: () => ({ auth: { token: "test", user: { id: "owner", name: "Tester" } } }) },
    "router.js": { navigate() {} },
    "app-shell.js": { mountAppShell: async () => ({
      content: app.dom.window.document.querySelector("#app"),
      setActiveConversation() {}, setConversations() {}, setShareActive: (...args) => shareStates.push(args), setIncognitoActive() {},
    }) },
    "toast.js": { toast: notice => notices.push(notice) },
    "confirm-modal.js": { openConfirmModal() {}, openPromptModal() {} },
    "share-modal.js": { openShareModal: callbacks => shareCallbacks.push(callbacks) }, "projects.js": { openMoveChatModal() {} },
    "markdown.js": { whenMarkdownReady() {}, renderMarkdown: text => text },
    "voice-overlay.js": { openVoiceOverlay: options => { voice = options; return { close() {} }; } },
    "api.js": api,
    "message-feed.js": { MessageFeed: Feed },
    "export.js": {
      detectExportIntent: () => ({ exportOnly: false }), buildCanonicalMarkdown: () => "",
      formatExportFilename: (title, format) => `${title}.${format}`,
      downloadBlob: (blob, filename) => downloads.push({ blob, filename }),
      buildClientDocxBlob: options => { converted.push(options); return "docx-blob"; },
      printDocumentToPdf: options => printed.push(options),
    },
    "image-modal.js": { openImageModal() {} },
  };
  app = moduleLoader(stubs, { globals: {
    setTimeout: (fn, milliseconds) => setTimeout(fn, milliseconds).unref(),
    setInterval: (fn, milliseconds) => setInterval(fn, milliseconds).unref(),
  } });
  if (hash) app.dom.window.history.replaceState(null, "", hash);
  const actual = await app.load("js/chat/composer.js");
  stubs["composer.js"] = { ...actual, Composer: class extends actual.Composer {
    constructor(options) { super(options); composer = this; }
  } };
  const page = await app.load("js/pages/chat.js");
  const unmount = await page.renderChat({ id, incognito });
  await new Promise(resolve => setImmediate(resolve));
  const turn = (text, extras = {}) => composer.onSubmit({ text, attachments: [], model: "thinking", studyMode: false, autoSearch: false, ...extras });
  return { app, composer, feed, payloads, branchCalls, notices, downloads, printed, converted, shareStates, shareCallbacks, turn, unmount,
           voice: () => voice, rendered: () => lastRender };
}

test("a closed chat's Share modal cannot reactivate the mobile Share button", async () => {
  const page = await chatPage({ id: "saved-chat", messages: [{ id: "one", role: "user", content: "Hello" }] });
  page.app.dom.window.document.querySelector('.chat-topbar-share-btn').click();
  assert.equal(page.shareCallbacks.length, 1);
  page.unmount();
  const count = page.shareStates.length;
  page.shareCallbacks[0].onShared();
  page.shareCallbacks[0].onUnshared();
  assert.equal(page.shareStates.length, count);
});

test("document export falls back to client rendering when the gateway is unavailable", async t => {
  const page = await chatPage();
  t.after(page.unmount);
  page.feed.callbacks.onExport({ title: "Report", content: "A completed answer", format: "docx" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.converted[0].htmlContent, "A completed answer");
  assert.equal(page.downloads[0].filename, "Report.docx");
  page.feed.callbacks.onExport({ title: "Report", content: "Another completed answer", format: "pdf" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.printed[0].htmlContent, "Another completed answer");
});

test("incognito follow-ups send the visible conversation and cap history at 24 messages", async t => {
  const page = await chatPage({ incognito: true });
  t.after(page.unmount);
  await page.turn("Remember my number 731");
  await page.turn("What number did I give you?");
  assert.equal(page.payloads[1].history.length, 2);
  assert.match(page.payloads[1].history[0].content, /731/);
  assert.equal(page.payloads[1].conversation_id, undefined);
  for (let i = 0; i < 12; i++) await page.turn(`Next turn ${i}`);
  assert.equal(page.payloads.at(-1).history.length, 24);
  assert.equal(page.notices.length, 0);
});

test("selected voice language reaches the actual outgoing chat request", async t => {
  const page = await chatPage();
  t.after(page.unmount);
  page.composer.onOpenVoiceAssistant();
  await page.voice().sendTurn("Bonjour", { language: "fr", languageName: "French" });
  assert.match(page.payloads.at(-1).system_prompt, /Respond fluently and naturally in French/);
  assert.equal(page.payloads.at(-1).model, "aeon");
  assert.equal(page.payloads.at(-1).auto_search, true);
});

for (const action of ["edit", "retry-user", "retry-assistant"]) {
  test(`${action} sends the replacement to a persisted branch`, async t => {
    const messages = Array.from({ length: 6 }, (_, i) => ({ id: `original-${i}`, role: i % 2 ? "assistant" : "user", content: `Original turn ${i}` }));
    const page = await chatPage({ messages, id: "original" });
    t.after(page.unmount);
    if (action === "edit") {
      await page.feed.callbacks.onEditMessage(messages[2]);
      assert.equal(page.composer.textarea.value, messages[2].content);
      await page.turn("Replacement text");
    } else if (action === "retry-user") {
      await page.feed.callbacks.onRetryMessage(messages[2]);
    } else {
      await page.feed.callbacks.onRetryAssistantMessage(messages[3]);
    }
    assert.deepEqual(page.branchCalls, [{ parentId: "original", messageId: "original-2" }]);
    assert.equal(page.payloads.at(-1).conversation_id, "branch");
    assert.equal(page.app.dom.window.location.hash, "#/app/chat/branch");
    assert.equal(page.rendered().messages.some(message => message.content === "Original turn 4"), false);
    assert.equal(messages.length, 6);
    assert.equal(page.notices.length, 0);
  });
}

test("saved skills load as chips, follow-ups send them, and removal clears the next request", async t => {
  const skills = [{ id: "skill", name: "code-review", description: "Review code", enabled: true }];
  const page = await chatPage({ id: "chat", skills, activeSkills: ["skill"] });
  t.after(page.unmount);
  assert.equal(page.composer.skillPicker.chips.textContent, "/code-review");
  await page.turn("Review this");
  assert.deepEqual(page.payloads[0].skill_ids, ["skill"]);
  assert.equal(page.rendered().messages.find(message => message.role === "user").skills[0].name, "code-review");
  await page.turn("Continue");
  assert.deepEqual(page.payloads[1].skill_ids, ["skill"]);
  page.composer.textarea.setSelectionRange(0, 0);
  page.composer.textarea.dispatchEvent(new page.app.dom.window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
  await page.turn("Without skills");
  assert.deepEqual(page.payloads[2].skill_ids, []);
});

test("Use in chat preselects the imported skill and sends its ID", async t => {
  const page = await chatPage({ hash: "#/app/chat?skill_id=new-skill", skills: [
    { id: "new-skill", name: "writing-style", description: "Improve writing", enabled: true },
  ] });
  t.after(page.unmount);
  assert.equal(page.composer.skillPicker.chips.textContent, "/writing-style");
  await page.turn("Improve this paragraph");
  assert.deepEqual(page.payloads[0].skill_ids, ["new-skill"]);
});

test("returning to a chat refreshes skills added in another tab", async t => {
  const skills = [];
  const page = await chatPage({ skills });
  t.after(page.unmount);
  skills.push({ id: "new", name: "new-skill", description: "Newly uploaded", enabled: true });
  page.app.dom.window.dispatchEvent(new page.app.dom.window.Event("focus"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.composer.skillPicker.skills[0].name, "new-skill");
});
