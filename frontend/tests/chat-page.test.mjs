import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./modules.mjs";

async function chatPage({ incognito = false, messages = [], id, skills = [], activeSkills = [], hash, navigation, onShell } = {}) {
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
    scrapeUrl: async () => ({}),
    exportDocument: async () => { throw Error("Export service unavailable"); },
  };
  const stubs = {
    "auth.js": { getAuth: () => ({ auth: { token: "test", user: { id: "owner", name: "Tester" } } }) },
    "router.js": { navigate() {} },
    "app-shell.js": { mountAppShell: async () => { onShell?.(app); return ({
      content: app.dom.window.document.querySelector("#app"),
      setActiveConversation() {}, setConversations() {}, setShareActive: (...args) => shareStates.push(args), setIncognitoActive() {},
    }); } },
    "toast.js": { toast: notice => notices.push(notice) },
    "confirm-modal.js": { openConfirmModal() {}, openPromptModal() {} },
    "share-modal.js": { openShareModal: callbacks => shareCallbacks.push(callbacks) }, "projects.js": { openMoveChatModal() {} },
    "markdown.js": { whenMarkdownReady() {}, renderMarkdown: text => text },
    "voice-overlay.js": { openVoiceOverlay: options => { voice = options; return { close() {} }; } },
    "api.js": Object.fromEntries(Object.keys(api).map(name => [name, (...args) => api[name](...args)])),
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
  const unmount = await page.renderChat({ id, incognito }, navigation);
  await new Promise(resolve => setImmediate(resolve));
  const turn = (text, extras = {}) => composer.onSubmit({ text, attachments: [], model: "thinking", studyMode: false, autoSearch: false, ...extras });
  return { app, api, composer, feed, payloads, branchCalls, notices, downloads, printed, converted, shareStates, shareCallbacks, turn, unmount,
           voice: () => voice, rendered: () => lastRender };
}

test("failed submission restores the draft, attachments and selected skills", async t => {
  const page = await chatPage({ skills: [{ id: "skill", name: "review", enabled: true }] });
  t.after(() => { page.unmount(); page.app.dom.window.close(); });
  page.api.streamChat = async () => { throw Error("Offline"); };
  page.composer.setText("Keep my draft");
  page.composer.pendingAttachments = [{ name: "notes.txt", path: "fixture" }];
  page.composer.skillPicker.setSelected(["skill"]);
  page.composer.composer.dispatchEvent(new page.app.dom.window.Event("submit", { cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.composer.textarea.value, "Keep my draft");
  assert.equal(page.composer.pendingAttachments[0]?.path, "fixture");
  assert.equal(page.composer.skillPicker.selected[0]?.id, "skill");
});

test("failed sends preserve a newer draft and offer recovery of the older one", async t => {
  const page = await chatPage();
  t.after(() => { page.unmount(); page.app.dom.window.close(); });
  let fail;
  page.api.streamChat = () => new Promise((_, reject) => { fail = reject; });
  page.composer.setText("Older draft");
  page.composer.composer.dispatchEvent(new page.app.dom.window.Event("submit", { cancelable: true }));
  page.composer.setText("Newer draft");
  fail(Error("Offline"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.composer.textarea.value, "Newer draft");
  const recover = page.app.dom.window.document.querySelector(".composer-recovery button");
  assert.ok(recover);
  page.composer.setText(""); recover.click();
  assert.equal(page.composer.textarea.value, "Older draft");
});

for (const action of ["stop", "unmount"]) {
  test(`${action} during link reading cannot start generation later`, async t => {
    const page = await chatPage();
    t.after(() => { page.unmount(); page.app.dom.window.close(); });
    let finish, scrapeSignal;
    page.api.scrapeUrl = (_token, _url, signal) => { scrapeSignal = signal; return new Promise(resolve => { finish = resolve; }); };
    const pending = page.turn("Read https://example.invalid/page");
    if (action === "stop") page.composer.onStop(); else page.unmount();
    assert.equal(scrapeSignal?.aborted, true);
    finish({ markdown: "Late content" }); await pending;
    assert.equal(page.payloads.length, 0);
  });
}

test("interrupted incognito output stays visible and accepted turns are not restored as unsent", async t => {
  const page = await chatPage({ incognito: true });
  t.after(() => { page.unmount(); page.app.dom.window.close(); });
  page.api.streamChat = async (_token, _payload, callbacks) => {
    callbacks.onUserMessage({ id: "accepted", role: "user", content: "Question" });
    callbacks.onToken({ delta: "Partial answer" });
    throw Error("Connection lost");
  };
  await page.turn("Question");
  assert.ok(page.rendered().messages.some(message => message.role === "assistant" && message.content === "Partial answer"));
  assert.equal(page.rendered().messages.filter(message => message.role === "user").length, 1);
  assert.ok(page.notices.some(notice => /interrupt|lost/i.test(notice)));
});

test("normal incognito completion without database acknowledgement retains the answer", async t => {
  const page = await chatPage({ incognito: true });
  t.after(() => { page.unmount(); page.app.dom.window.close(); });
  page.api.streamChat = async (_token, _payload, callbacks) => {
    callbacks.onToken({ delta: "Private answer" }); callbacks.onComplete();
  };
  await page.turn("Question");
  assert.ok(page.rendered().messages.some(message => message.role === "assistant" && message.content === "Private answer"));
});

test("reconciliation keeps a partial saved answer until the server has the completed reply", async t => {
  const page = await chatPage({ id: "saved-chat" });
  t.after(() => { page.unmount(); page.app.dom.window.close(); });
  const accepted = { id: "accepted", role: "user", content: "Question" };
  page.api.getMessages = async () => ({ messages: [accepted] });
  page.api.streamChat = async (_token, _payload, callbacks) => {
    callbacks.onUserMessage(accepted); callbacks.onToken({ delta: "Partial saved answer" }); throw Error("Connection lost");
  };
  await page.turn("Question");
  assert.ok(page.rendered().messages.some(message => message.content === "Partial saved answer" && message.interrupted));
});

test("loading an empty chat does not steal focus from a chosen control", async t => {
  const page = await chatPage();
  t.after(() => { page.unmount(); page.app.dom.window.close(); });
  const button = page.app.dom.window.document.querySelector("button");
  button.focus();
  page.app.dom.window.dispatchEvent(new page.app.dom.window.Event("focus"));
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(page.app.dom.window.document.activeElement, button);
});

test("an obsolete chat mount leaves the newer route's DOM intact", async t => {
  const controller = new AbortController();
  const page = await chatPage({
    navigation: { signal: controller.signal, isCurrent: () => !controller.signal.aborted },
    onShell: app => { app.dom.window.document.querySelector("#app").textContent = "Latest route"; controller.abort(); },
  });
  t.after(() => { page.unmount?.(); page.app.dom.window.close(); });
  assert.equal(page.app.dom.window.document.querySelector("#app").textContent, "Latest route");
});

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

test("skills apply once and saved conversations do not restore them", async t => {
  const skills = [{ id: "skill", name: "code-review", description: "Review code", enabled: true }];
  const page = await chatPage({ id: "chat", skills, activeSkills: ["skill"] });
  t.after(page.unmount);
  assert.equal(page.composer.skillPicker.chips.hidden, true);
  page.composer.skillPicker.setSelected(["skill"]);
  await page.turn("Review this");
  assert.deepEqual(page.payloads[0].skill_ids, ["skill"]);
  assert.equal(page.rendered().messages.find(message => message.role === "user").skills[0].name, "code-review");
  assert.equal(page.composer.skillPicker.chips.hidden, true);
  await page.turn("Continue");
  assert.deepEqual(page.payloads[1].skill_ids, []);
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
