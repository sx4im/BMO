import assert from "node:assert/strict";
import test from "node:test";
import { moduleLoader } from "./modules.mjs";

async function chatPage({ incognito = false, messages = [], id, skills = [], activeSkills = [], hash, scrapeUrl, conversationPrompt, streamChat, fetchMessages, listConversations, generateImage, shellGate, signal, timers } = {}) {
  let composer, feed, voice, lastRender;
  const renderStates = [];
  const payloads = [], branchCalls = [], notices = [], downloads = [], printed = [], converted = [];
  const shareStates = [], shareCallbacks = [], feedbackCalls = [];
  let app;
  class Feed {
    constructor(callbacks) {
      feed = this;
      this.callbacks = callbacks;
      this.element = app.dom.window.document.createElement("div");
      this.stream = this.element;
      this.follower = { attach() {} };
    }
    render(value) { lastRender = { ...value, messages: value.messages.map(m => ({ ...m })) }; renderStates.push(lastRender); }
    mountScrollFollower() {} unmountScrollFollower() {} scrollToBottom() {}
    updateStreamingBubble() {} finishStreamingBubble() {} setStatusText() {} setStreamingReasoningTimer() {}
  }
  const api = {
    listSkills: async () => skills,
    listModels: async () => ({
      models: [{ id: "thinking", label: "Stanza" }, { id: "deep", label: "Nexos 3.0" }],
      default: "thinking",
    }),
    listConversations: listConversations || (async () => []),
    getMessages: async (...args) => fetchMessages ? fetchMessages(...args) : ({ conversation: { id, model: "thinking", title: "Original chat", active_skills: activeSkills, system_prompt: conversationPrompt }, messages }),
    branchConversation: async (_token, parentId, messageId) => {
      branchCalls.push({ parentId, messageId });
      const prefix = messages.slice(0, messages.findIndex(m => m.id === messageId));
      return { conversation: { id: "branch", model: "thinking", title: "Branched chat" },
               messages: prefix.map(m => ({ ...m, id: `copy-${m.id}`, conversation_id: "branch" })) };
    },
    streamChat: async (_token, payload, callbacks) => {
      payloads.push(structuredClone(payload));
      const turn = payloads.length;
      if (streamChat) return streamChat(_token, payload, callbacks);
      callbacks.onConversation({ id: incognito ? "incognito_test" : payload.conversation_id || "saved", model: "thinking" });
      callbacks.onUserMessage({ id: `user-${turn}`, role: "user", content: payload.message, attachments: payload.attachments,
        skills: (payload.skill_ids || []).map(id => ({ id, name: skills.find(skill => skill.id === id)?.name || "Skill" })) });
      callbacks.onToken({ delta: `Answer ${turn}` });
      callbacks.onComplete();
      callbacks.onAssistantMessage({ id: `assistant-${turn}`, role: "assistant", content: `Answer ${turn}` });
    },
    submitFeedback: async (_token,payload)=>{feedbackCalls.push(payload);return payload;},
    updateConversation: async (_token, conversationId, patch) => ({ id: conversationId, ...patch }),
    cancelChat: async () => {},
    generateImage,
    scrapeUrl,
    exportDocument: async () => { throw Error("Export service unavailable"); },
  };
  const stubs = {
    "auth.js": { getAuth: () => ({ auth: { token: "test", user: { id: "owner", name: "Tester" } } }) },
    "router.js": { navigate() {} },
    "app-shell.js": { mountAppShell: async () => { await shellGate; return ({
      content: app.dom.window.document.querySelector("#app"),
      setActiveConversation() {}, setConversations() {}, setShareActive: (...args) => shareStates.push(args), setIncognitoActive() {},
    }); } },
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
    setTimeout: timers?.setTimeout || ((fn, milliseconds) => setTimeout(fn, milliseconds).unref()),
    clearTimeout: timers?.clearTimeout || clearTimeout,
    setInterval: timers?.setInterval || ((fn, milliseconds) => setInterval(fn, milliseconds).unref()),
    clearInterval: timers?.clearInterval || clearInterval,
  } });
  if (hash) app.dom.window.history.replaceState(null, "", hash);
  const actual = await app.load("js/chat/composer.js");
  stubs["composer.js"] = { ...actual, Composer: class extends actual.Composer {
    constructor(options) { super(options); composer = this; }
  } };
  const page = await app.load("js/pages/chat.js");
  const unmount = await page.renderChat({ id, incognito }, { signal });
  await new Promise(resolve => setImmediate(resolve));
  const turn = (text, extras = {}) => composer.onSubmit({ text, attachments: [], model: "thinking", autoSearch: false, ...extras });
  return { app, composer, feed, payloads, branchCalls, notices, downloads, printed, converted, shareStates, shareCallbacks, turn, unmount,
           voice: () => voice, rendered: () => lastRender, renderStates, feedbackCalls };
}

test("Nexos sends medium reasoning and its model menu only selects models", async t => {
  const page = await chatPage();
  t.after(page.unmount);
  page.composer.modelBadge.click();
  const nexos = Array.from(page.composer.modelDropdown.querySelectorAll('[role="option"]'))
    .find(option => option.textContent.includes("Nexos 3.0"));
  assert.ok(nexos);
  nexos.click();
  assert.equal(page.composer.modelBadgeLabel.textContent, "Nexos 3.0");
  assert.equal(page.composer.modelBadge.getAttribute("aria-expanded"), "false");

  page.composer.modelBadge.click();
  assert.equal(page.composer.modelDropdown.querySelectorAll("button").length, 2);
  assert.equal(page.app.dom.window.document.querySelector('[aria-label="Select reasoning effort"]'), null);

  await page.turn("Explain gravity", { model: page.composer.currentModel, reasoningEffort: "high" });
  assert.equal(page.payloads[0].model, "deep");
  assert.equal(page.payloads[0].reasoning_effort, "medium");
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

test("an offline chat stays visible and sends once on reconnection", async t => {
  let finish;
  const page = await chatPage({ streamChat: async (_token, payload, callbacks) => {
    await new Promise(resolve => { finish = resolve; });
    callbacks.onUserMessage({ id: "saved-user", role: "user", content: payload.message });
    callbacks.onAssistantMessage({ id: "answer", role: "assistant", content: "Ready." });
  } });
  t.after(page.unmount);
  const win = page.app.dom.window;
  let online = false;
  Object.defineProperty(win.navigator, "onLine", { get: () => online });
  await page.turn("Queued question");
  assert.equal(page.payloads.length, 0);
  assert.equal(page.rendered().messages[0].delivery_status, "queued");
  assert.equal(page.rendered().generating, false);

  online = true;
  win.dispatchEvent(new win.Event("online"));
  win.dispatchEvent(new win.Event("online"));
  assert.equal(page.payloads.length, 1);
  assert.equal(page.rendered().messages[0].delivery_status, "sending");
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(page.rendered().messages, m => m.id), ["saved-user", "answer"]);
  assert.equal(page.rendered().messages[0].delivery_status, undefined);
});

test("stopping a queued offline chat cancels delivery", async t => {
  const page = await chatPage();
  t.after(page.unmount);
  const win = page.app.dom.window;
  let online = false;
  Object.defineProperty(win.navigator, "onLine", { get: () => online });
  await page.turn("Cancel this");
  page.composer.onStop();
  online = true;
  win.dispatchEvent(new win.Event("online"));
  assert.equal(page.payloads.length, 0);
  assert.equal(page.rendered().messages.length, 0);
});

test("a failed reconnect keeps the draft and does not resend an unconfirmed request", async t => {
  const page = await chatPage({ streamChat: async () => { throw new TypeError("Failed to fetch"); } });
  t.after(page.unmount);
  const win = page.app.dom.window;
  let online = false;
  Object.defineProperty(win.navigator, "onLine", { get: () => online });
  await page.turn("Keep this draft");
  online = true;
  win.dispatchEvent(new win.Event("online"));
  await new Promise(resolve => setImmediate(resolve));
  win.dispatchEvent(new win.Event("online"));
  assert.equal(page.payloads.length, 1);
  const draft = page.rendered().messages[0];
  assert.equal(draft.delivery_status, "unconfirmed");
  await page.feed.callbacks.onEditMessage(draft);
  assert.equal(page.composer.textarea.value, "Keep this draft");
  assert.equal(page.branchCalls.length, 0);
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
  await page.voice().sendTurn("Hello again", { language: "en", languageName: "English", delivery: "gentle" });
  assert.match(page.payloads.at(-1).system_prompt, /Respond fluently and naturally in English/);
  assert.match(page.payloads.at(-1).system_prompt, /Microphone delivery cue: gentle/);
  assert.equal(page.payloads.at(-1).model, "aeon");
  assert.equal(page.payloads.at(-1).auto_search, true);
});

test("conversation instructions and per-turn instructions both reach the chat request", async t => {
  const page = await chatPage({id:'saved-chat', conversationPrompt:'Use concise explanations.'});
  t.after(page.unmount);
  await page.turn('Explain kinetic energy', {systemPrompt:'Use SI units.'});
  assert.equal(page.payloads[0].system_prompt, 'Use concise explanations.\n\nUse SI units.');
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


test("web search off does not fetch pasted URLs", async t => {
  let fetches = 0;
  const page = await chatPage({ scrapeUrl: async () => { fetches++; return { markdown: "A page" }; } });
  t.after(page.unmount);
  await page.turn("Explain https://example.com", { autoSearch: false });
  assert.equal(fetches, 0);
  assert.equal(page.payloads.length, 1);
  assert.equal(page.payloads[0].auto_search, false);
});

test("unified + button offers attachments, web search, and image creation with working mode transitions", async t => {
  const page = await chatPage();
  t.after(page.unmount);
  const { composer } = page;
  assert.equal(composer.element.querySelector('.composer-tools-btn'), null);
  assert.ok(composer.attachBtn.querySelector('.icon-plus'));
  composer.renderAttachMenu();
  assert.deepEqual(Array.from(composer.attachmentMenu.querySelectorAll('.menu-title'), node => node.textContent),
    ['Attach image', 'Upload file', 'Take a snap', 'Web search', 'Create image']);
  assert.equal(composer.attachmentMenu.querySelectorAll('.menu-sub').length, 0);
  composer.applyTool('generate');
  assert.equal(composer.isImageMode(), true);
  assert.match(composer.textarea.placeholder, /Describe an image/);
  if (composer.autoSearch) composer.applyTool('search');
  composer.applyTool('search');
  assert.equal(composer.isImageMode(), false);
  assert.equal(composer.autoSearch, true);
  composer.textarea.value = 'Explain conservation of momentum';
  composer.syncSendEnabled();
  composer.sendBtn.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.payloads.at(-1).auto_search, true);
  assert.equal(page.payloads.at(-1).message, 'Explain conservation of momentum');
});

test("stop during URL retrieval aborts the fetch and never sends the chat", async t => {
  let started, signal;
  const fetching = new Promise(resolve => { started = resolve; });
  const page = await chatPage({ scrapeUrl: async (_token, _url, requestSignal) => {
    signal = requestSignal;
    started();
    return new Promise(resolve => setTimeout(() => resolve({ markdown: "Late result" }), 10));
  } });
  t.after(page.unmount);
  const turn = page.turn("Explain https://example.com", { autoSearch: true });
  await fetching;
  page.composer.onStop();
  await turn;
  assert.equal(signal?.aborted, true);
  assert.equal(page.payloads.length, 0);
  assert.equal(page.composer.isGenerating, false);
});


test("early and repeated saved-user acknowledgments keep one message in chronological order", async t => {
  let page;
  page = await chatPage({streamChat: async (_token, payload, callbacks) => {
    const user = {id:"durable-user",role:"user",content:payload.message,attachments:[]};
    callbacks.onConversation({id:"durable-conversation",model:"thinking",title:"Saved early"});
    callbacks.onUserMessage(user);
    assert.equal(page.app.dom.window.location.hash,"#/app/chat/durable-conversation","Saved IDs should be usable before reply generation ends");
    callbacks.onToken({delta:"Working"});
    callbacks.onUserMessage({...user,attachments:[{filename:"notes.txt"}]});
    assert.equal(page.rendered().messages.filter(m=>m.role==="user").length,1);
    callbacks.onComplete();
    callbacks.onAssistantMessage({id:"durable-assistant",role:"assistant",content:"Finished"});
    callbacks.onUserMessage({...user,attachments:[{filename:"notes.txt"}]});
  }});
  t.after(page.unmount);
  await page.turn("Save this while replying");
  assert.equal(page.notices.length,0);
  assert.deepEqual(Array.from(page.rendered().messages,m=>m.id),["durable-user","durable-assistant"]);
  assert.equal(page.rendered().messages[0].attachments[0].filename,"notes.txt");
});

test("a failed final save keeps the streamed answer visible and reports the failure", async t => {
  const page = await chatPage({streamChat: async (_token, payload, callbacks) => {
    callbacks.onConversation({id:"saved-conversation",model:"thinking"});
    callbacks.onUserMessage({id:"saved-user",role:"user",content:payload.message});
    callbacks.onToken({delta:"Your answer should remain readable."});
    callbacks.onComplete();
    callbacks.onError(new Error("Your answer could not be saved. Please try again."));
  }});
  t.after(page.unmount);
  await page.turn("Give me an answer");
  assert.equal(page.rendered().messages.filter(m=>m.role==="assistant").length,1);
  const reply=page.rendered().messages.find(m=>m.role==="assistant");
  assert.equal(reply.content,"Your answer should remain readable.");
  assert.equal(reply.unsaved,true);
  assert.match(page.notices[0],/could not be saved/);
});

for (const failure of ["read rejection", "premature stream end"]) {
  test(`${failure} keeps the partial answer visible instead of silently clearing it`, async t => {
    const page=await chatPage({streamChat:async(_token,payload,callbacks)=>{
      callbacks.onUserMessage({id:"saved-user",role:"user",content:payload.message});
      callbacks.onReasoningToken({delta:"Some reasoning"});
      callbacks.onToken({delta:"An answer received before disconnect."});
      if(failure==="read rejection") throw new TypeError("Network connection lost");
    }});
    t.after(page.unmount);await page.turn("Explain this");
    const replies=page.rendered().messages.filter(m=>m.role==="assistant");
    assert.equal(replies.length,1);assert.equal(replies[0].content,"An answer received before disconnect.");
    assert.equal(replies[0].reasoning,"Some reasoning");assert.equal(replies[0].unsaved,true);
    assert.equal(page.notices.length,1);
  });
}

test("a saved streamed reply does not replay the message entrance", async t => {
  const page=await chatPage();t.after(page.unmount);
  await page.turn("Explain this briefly");
  const settled=page.renderStates.filter(s=>s.messages.some(m=>m.role==="assistant"));
  assert.ok(settled.length);
  assert.ok(settled.every(s=>s.enteringId==null),"Saved acknowledgments must not fade an already visible answer back in");
});


test("feedback on an unconfirmed reply recovers its saved ID before submitting",async t=>{
  const user={id:"saved-user",role:"user",content:"Explain"};
  const reply={id:"saved-assistant",role:"assistant",content:"A finished answer"};
  const page=await chatPage({fetchMessages:async()=>({messages:[user,reply]}),streamChat:async(_token,_payload,cb)=>{
    cb.onConversation({id:"saved-chat",model:"thinking"});cb.onUserMessage(user);
    cb.onToken({delta:reply.content});cb.onError(new Error("Save confirmation delayed"));
  }});t.after(page.unmount);await page.turn("Explain");
  const local=page.rendered().messages.find(m=>m.unsaved);
  await page.feed.callbacks.onFeedback(local,"up");
  assert.equal(page.feedbackCalls.length,1);assert.equal(page.feedbackCalls[0].message_id,"saved-assistant");
  assert.equal(page.rendered().messages.find(m=>m.role==="assistant").unsaved,false);
});

for (const completed of [false, true]) {
  test(`Stop preserves ${completed ? "a completed" : "a partial"} answer awaiting its saved acknowledgment`, async t => {
    const page = await chatPage({ streamChat: async (_token, _payload, cb) => {
      cb.onConversation({ id: "saved-chat", model: "thinking" });
      cb.onUserMessage({ id: "saved-user", role: "user", content: "Explain" });
      cb.onReasoningToken({ delta: "Reasoning received" });
      cb.onToken({ delta: "Keep this answer" });
      if (completed) cb.onComplete();
      await new Promise((resolve, reject) => cb.signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true }));
    } });
    t.after(page.unmount);
    const running = page.turn("Explain");
    await new Promise(setImmediate);
    page.composer.onStop();
    await running;
    const replies = page.rendered().messages.filter(m => m.role === "assistant");
    assert.equal(replies.length, 1);
    assert.equal(replies[0].content, "Keep this answer");
    assert.equal(replies[0].reasoning, "Reasoning received");
    assert.equal(replies[0].unsaved, true);
    assert.equal(page.notices.length, 0, "Stopping deliberately must not display a save failure");
    assert.equal(page.composer.isGenerating, false);
  });
}

for (const event of ["visibilitychange", "online"]) {
  test(`${event} reconciles an unconfirmed saved answer without duplicating it`, async t => {
    const user = { id: "saved-user", role: "user", content: "Explain" };
    const reply = { id: "saved-assistant", role: "assistant", content: "A saved answer" };
    const page = await chatPage({ fetchMessages: async () => ({ messages: [user, reply] }),
      streamChat: async (_token, _payload, cb) => {
        cb.onConversation({ id: "saved-chat", model: "thinking" }); cb.onUserMessage(user);
        cb.onToken({ delta: reply.content }); cb.onError(new Error("Saving delayed"));
      } });
    t.after(page.unmount); await page.turn("Explain");
    Object.defineProperty(page.app.dom.window.document, "hidden", { value: false, configurable: true });
    const target = event === "online" ? page.app.dom.window : page.app.dom.window.document;
    target.dispatchEvent(new page.app.dom.window.Event(event));
    await new Promise(setImmediate);
    target.dispatchEvent(new page.app.dom.window.Event(event));
    await new Promise(setImmediate);
    assert.deepEqual(Array.from(page.rendered().messages, m => m.id), ["saved-user", "saved-assistant"]);
    assert.equal(page.rendered().messages[1].unsaved, false);
    assert.equal(page.notices.length, 1, "Recovery must not add or hide the original genuine error");
  });
}

test("a late save reconciliation preserves newer local turns", async t => {
  let finishRead;
  const user = { id: "first-user", role: "user", content: "First question" };
  const reply = { id: "first-assistant", role: "assistant", content: "First answer" };
  const page = await chatPage({ fetchMessages: () => new Promise(resolve => { finishRead = resolve; }),
    streamChat: async (_token, payload, cb) => {
      cb.onConversation({ id: "saved-chat", model: "thinking" });
      if (payload.message === "First question") {
        cb.onUserMessage(user); cb.onToken({ delta: reply.content }); cb.onError(new Error("Saving delayed"));
      } else {
        cb.onUserMessage({ id: "new-user", role: "user", content: payload.message });
        cb.onToken({ delta: "New answer" });
        cb.onAssistantMessage({ id: "new-assistant", role: "assistant", content: "New answer" });
      }
    } });
  t.after(page.unmount); await page.turn("First question");
  page.app.dom.window.dispatchEvent(new page.app.dom.window.Event("online"));
  await new Promise(setImmediate);
  assert.equal(typeof finishRead, "function");
  await page.turn("New question");
  finishRead({ messages: [user, reply] });
  await new Promise(setImmediate);
  assert.deepEqual(Array.from(page.rendered().messages, m => m.id), ["first-user", "first-assistant", "new-user", "new-assistant"]);
});

test("save reconciliation leaves a different persisted answer unconfirmed", async t => {
  const user = { id: "saved-user", role: "user", content: "Explain" };
  const page = await chatPage({ fetchMessages: async () => ({ messages: [user, { id: "other", role: "assistant", content: "A different answer" }] }),
    streamChat: async (_token, _payload, cb) => {
      cb.onConversation({ id: "saved-chat", model: "thinking" }); cb.onUserMessage(user);
      cb.onToken({ delta: "Visible answer" }); cb.onError(new Error("Saving delayed"));
    } });
  t.after(page.unmount); await page.turn("Explain");
  page.app.dom.window.dispatchEvent(new page.app.dom.window.Event("online"));
  await new Promise(setImmediate);
  assert.equal(page.rendered().messages[1].content, "Visible answer");
  assert.equal(page.rendered().messages[1].unsaved, true);
});

test("a pending save reconciliation cannot overwrite a branched conversation", async t => {
  let finishRead, turn = 0;
  const user = { id: "saved-user", role: "user", content: "Explain" };
  const page = await chatPage({ fetchMessages: () => new Promise(resolve => { finishRead = resolve; }),
    streamChat: async (_token, payload, cb) => {
      cb.onConversation({ id: payload.conversation_id || "saved-chat", model: "thinking" });
      if (++turn === 1) {
        cb.onUserMessage(user); cb.onToken({ delta: "Original answer" }); cb.onError(new Error("Saving delayed"));
      } else {
        cb.onUserMessage({ id: "branch-user", role: "user", content: payload.message });
        cb.onToken({ delta: "Branched answer" });
        cb.onAssistantMessage({ id: "branch-assistant", role: "assistant", content: "Branched answer" });
      }
    } });
  t.after(page.unmount); await page.turn("Explain");
  page.app.dom.window.dispatchEvent(new page.app.dom.window.Event("online"));
  await new Promise(setImmediate);
  await page.feed.callbacks.onEditMessage(user);
  await page.turn("Edited question");
  await new Promise(setImmediate);
  finishRead({ messages: [user, { id: "old-assistant", role: "assistant", content: "Original answer" }] });
  await new Promise(setImmediate);
  assert.equal(page.app.dom.window.location.hash, "#/app/chat/branch");
  assert.deepEqual(Array.from(page.rendered().messages, m => m.id), ["branch-user", "branch-assistant"]);
});

test("save reconciliation ignores a read that finishes after closing the chat", async () => {
  let finishRead;
  const user = { id: "saved-user", role: "user", content: "Explain" };
  const page = await chatPage({ fetchMessages: () => new Promise(resolve => { finishRead = resolve; }),
    streamChat: async (_token, _payload, cb) => {
      cb.onConversation({ id: "saved-chat", model: "thinking" }); cb.onUserMessage(user);
      cb.onToken({ delta: "Visible answer" }); cb.onError(new Error("Saving delayed"));
    } });
  await page.turn("Explain");
  page.app.dom.window.dispatchEvent(new page.app.dom.window.Event("online"));
  await new Promise(setImmediate);
  page.unmount();
  const renderCount = page.renderStates.length;
  finishRead({ messages: [user, { id: "saved-assistant", role: "assistant", content: "Visible answer" }] });
  await new Promise(setImmediate);
  assert.equal(page.renderStates.length, renderCount);
});

test("feedback never sends an unconfirmed local ID when saving is still pending",async t=>{
  const page=await chatPage({fetchMessages:async()=>({messages:[]}),streamChat:async(_token,_payload,cb)=>{
    cb.onConversation({id:"saved-chat",model:"thinking"});cb.onUserMessage({id:"user",role:"user",content:"Explain"});
    cb.onToken({delta:"Visible answer"});cb.onError(new Error("Saving delayed"));
  }});t.after(page.unmount);await page.turn("Explain");
  await page.feed.callbacks.onFeedback(page.rendered().messages.find(m=>m.unsaved),"down");
  assert.equal(page.feedbackCalls.length,0);assert.match(page.notices.at(-1),/saving/i);
});

test("retrying an unconfirmed reply reuses its saved question, never its local ID",async t=>{
  const page=await chatPage({streamChat:async(_token,_payload,cb)=>{
    cb.onConversation({id:"saved-chat",model:"thinking"});cb.onUserMessage({id:"saved-user",role:"user",content:"Explain"});
    cb.onToken({delta:"Visible answer"});cb.onError(new Error("Saving delayed"));
  }});t.after(page.unmount);await page.turn("Explain");
  await page.feed.callbacks.onRetryAssistantMessage(page.rendered().messages.find(m=>m.unsaved));
  await new Promise(setImmediate);
  assert.equal(page.branchCalls.length,0);assert.equal(page.payloads.length,2);
  assert.equal(page.payloads[1].retry_message_id,"saved-user");
  assert.equal(page.payloads[1].conversation_id,"saved-chat");
});


test("a title generated after the old refresh window reaches the header and cancels remaining refreshes", async t => {
  const pending=new Map();let next=0,title="Explain sorting";
  const timers={setTimeout(fn,ms){pending.set(++next,{fn,ms});return next;},clearTimeout(id){pending.delete(id);}};
  const page=await chatPage({timers,listConversations:async()=>[{id:"saved",title,model:"thinking"}],
    streamChat:async(_token,_payload,callbacks)=>{
      callbacks.onConversation({id:"saved",title:"Explain sorting",model:"thinking"});
      callbacks.onUserMessage({id:"user",role:"user",content:"Explain sorting"});
      callbacks.onToken({delta:"An explanation"});callbacks.onComplete();
      callbacks.onAssistantMessage({id:"assistant",role:"assistant",content:"An explanation"});
    }});
  t.after(page.unmount);
  await page.turn("Explain sorting");
  title="Sorting Algorithms";
  const late=[...pending].find(([,timer])=>timer.ms>4500);
  assert.ok(late,"Title refresh must continue after4.5 seconds");
  pending.delete(late[0]);await late[1].fn();
  assert.equal(page.app.dom.window.document.querySelector('.chat-topbar-title-text').textContent,"Sorting Algorithms");
  assert.ok(![...pending.values()].some(timer=>timer.ms>=1200));
});

test("closing the chat cancels title refreshes and ignores pending sidebar results", async () => {
  const pending=new Map();let next=0;
  const timers={setTimeout(fn,ms){pending.set(++next,{fn,ms});return next;},clearTimeout(id){pending.delete(id);}};
  const page=await chatPage({timers});
  await page.turn("A question");
  assert.ok([...pending.values()].some(timer=>timer.ms>=1200));
  page.unmount();
  assert.ok(![...pending.values()].some(timer=>timer.ms>=1200));
});


test("an older sidebar response cannot replace the newly generated title", async t => {
  const requests=[];
  const page=await chatPage({listConversations:()=>new Promise(resolve=>requests.push(resolve))});
  t.after(page.unmount);
  await page.turn("A question");
  assert.ok(requests.length>=2);
  requests.at(-1)([{id:"saved",title:"A Helpful Answer",model:"thinking"}]);
  await new Promise(setImmediate);
  for(const resolve of requests.slice(0,-1))resolve([{id:"saved",title:"A question",model:"thinking"}]);
  await new Promise(setImmediate);
  assert.equal(page.app.dom.window.document.querySelector('.chat-topbar-title-text').textContent,"A Helpful Answer");
});

test('old Stop finalizer preserves the next composer run', async t => {
  const runs = [];
  const page = await chatPage({ streamChat: async (_t, _p, cb) => {
    await new Promise(resolve => runs.push({ cb, resolve }));
  } }); t.after(page.unmount);
  const old = page.turn('Old'); await new Promise(setImmediate);
  page.composer.onStop();
  const next = page.turn('New'); await new Promise(setImmediate);
  runs[0].resolve(); await old;
  assert.equal(page.composer.isGenerating, true);
  runs[1].cb.onAssistantMessage({ id: 'new', role: 'assistant', content: 'Answer' });
  runs[1].resolve(); await next;
});

for (const busy of ['draft', 'voice', 'upload', 'attachment', 'dictation', 'image']) {
  test(`reload defers during ${busy}`, async t => {
    const page = await chatPage(); t.after(page.unmount);
    const uploadController = new AbortController();
    if (busy === 'draft') page.composer.textarea.value = 'Unsent';
    if (busy === 'voice') page.composer.onOpenVoiceAssistant();
    if (busy === 'upload') page.composer.uploadingFiles.push({ controller: uploadController });
    if (busy === 'attachment') page.composer.pendingAttachments.push({});
    if (busy === 'dictation') page.composer.dictation = {};
    if (busy === 'image') page.composer.isImageGenerating = true;
    const event = new page.app.dom.window.Event('bmo:before-reload', { cancelable: true });
    assert.equal(page.app.dom.window.dispatchEvent(event), false);
    if (busy === 'dictation') page.composer.dictation = null;
    page.unmount();
    if (busy === 'upload') assert.equal(uploadController.signal.aborted, true);
    assert.equal(page.app.dom.window.dispatchEvent(new page.app.dom.window.Event('bmo:before-reload', { cancelable: true })), true);
  });
}


for (const unmountDuringAnimation of [false, true]) {
  test(`a fast image ${unmountDuringAnimation ? 'stays hidden after unmount' : 'appears after ten seconds'}`, async t => {
    let revealImage;
    const page = await chatPage({
      timers: {
        setTimeout(fn, ms) {
          if (ms === 10000) {
            revealImage = fn;
            return setTimeout(fn, 60000).unref();
          }
          return setTimeout(fn, ms).unref();
        },
      },
      generateImage: async () => ({
        assistant_message: { id: 'image', role: 'assistant', attachments: [{ content_type: 'image/png' }] },
      }),
    });
    if (!unmountDuringAnimation) t.after(page.unmount);
    const sending = page.turn('Draw', { model: 'image' });
    await new Promise(setImmediate);
    assert.equal(page.rendered().imageGenerating, true);
    assert.equal(page.rendered().messages.some(message => message.id === 'image'), false);
    assert.equal(typeof revealImage, 'function');

    if (unmountDuringAnimation) page.unmount();
    else revealImage();
    await sending;
    assert.equal(page.rendered().messages.some(message => message.id === 'image'), !unmountDuringAnimation);
    if (!unmountDuringAnimation) assert.equal(page.rendered().imageGenerating, false);
  });
}

test('image generation aborts on unmount and ignores a late successful response', async () => {
  let finish, signal;
  const page = await chatPage({ generateImage: async (_t, _p, supplied) => {
    signal = supplied; return new Promise(resolve => { finish = resolve; });
  } });
  const pending = page.turn('Draw', { model: 'image' });
  await new Promise(setImmediate); page.unmount();
  assert.equal(signal.aborted, true);
  const count = page.renderStates.length;
  finish({ conversation: { id: 'late-image' }, assistant_message: { id: 'image', role: 'assistant', content: 'Late image' } });
  await pending;
  assert.equal(page.renderStates.length, count);
  assert.equal(page.app.dom.window.location.hash, '');
});

for (const close of [false, true]) {
  test(`image poll never overlaps and ignores a late result after ${close ? 'unmount' : 'conversation reset'}`, async () => {
    let next = 0, reads = 0, finish, pollSignal;
    const tasks = new Map();
    const timers = { setTimeout(fn, ms) { tasks.set(++next, { fn, ms }); return next; }, clearTimeout(id) { tasks.delete(id); },
      setInterval(fn, ms) { tasks.set(++next, { fn, ms, recurring: true }); return next; }, clearInterval(id) { tasks.delete(id); } };
    const page = await chatPage({ id: 'image-chat', timers, fetchMessages: async (_token, _id, signal) => {
      if (++reads === 1) return { conversation: { id: 'image-chat', model: 'image' }, messages: [{ id: 'prompt', role: 'user', content: 'Draw', created_at: new Date().toISOString() }] };
      pollSignal = signal;
      return new Promise(resolve => { finish = resolve; });
    } });
    const runPoll = () => {
      const entry = [...tasks].find(([, value]) => value.ms === 3000);
      if (entry) { if (!entry[1].recurring) tasks.delete(entry[0]); entry[1].fn(); }
    };
    runPoll(); await new Promise(setImmediate);
    assert.equal(reads, 2);
    runPoll(); await new Promise(setImmediate);
    assert.equal(reads, 2);
    if (close) page.unmount(); else page.composer.onOpenVoiceAssistant();
    assert.equal(pollSignal.aborted, true);
    assert.equal([...tasks.values()].some(task => task.ms === 120000), false);
    const count = page.renderStates.length;
    finish({ messages: [{ id: 'late', role: 'assistant', content: 'Old image' }] });
    await new Promise(setImmediate);
    assert.equal(page.renderStates.length, count);
    assert.equal(page.rendered().messages.some(m => m.id === 'late'), false);
    if (!close) page.unmount();
  });
}


test('an obsolete chat cannot mount after a delayed shell resolves', async () => {
  const controller = new AbortController(); let release;
  const pending = chatPage({ signal: controller.signal, shellGate: new Promise(resolve => { release = resolve; }) });
  await new Promise(setImmediate);
  controller.abort(); release();
  const page = await pending;
  assert.equal(page.composer, undefined);
  assert.equal(page.renderStates.length, 0);
});

test('a closed chat ignores a late conversation-not-found response', async () => {
  let reject;
  const page = await chatPage({ id: 'gone', fetchMessages: () => new Promise((_resolve, fail) => { reject = fail; }) });
  page.unmount();
  reject(Object.assign(new Error('Not found'), { status: 404 }));
  await new Promise(setImmediate);
  assert.deepEqual(page.notices, []);
});

for (const outcome of ['timeout', 'success']) {
  test(`image polling clears its wall-clock deadline on ${outcome}`, async t => {
    let next = 0, reads = 0, resolveRead, pollSignal;
    const tasks = new Map();
    const timers = { setTimeout(fn, ms) { tasks.set(++next, { fn, ms }); return next; }, clearTimeout(id) { tasks.delete(id); } };
    const page = await chatPage({ id: 'image-chat', timers, fetchMessages: async (_token, _id, signal) => {
      if (++reads === 1) return { conversation: { id: 'image-chat', model: 'image' }, messages: [{ id: 'prompt', role: 'user', content: 'Draw', created_at: new Date().toISOString() }] };
      pollSignal = signal;
      return new Promise(resolve => { resolveRead = resolve; });
    } }); t.after(page.unmount);
    const deadline = [...tasks].find(([, task]) => task.ms === 120000);
    assert.ok(deadline, 'A deadline must exist independently of the pending network response');
    const tick = [...tasks].find(([, task]) => task.ms === 3000);
    tasks.delete(tick[0]); tick[1].fn(); await new Promise(setImmediate);
    assert.equal(page.composer.isImageGenerating, true);
    if (outcome === 'timeout') {
      tasks.delete(deadline[0]); deadline[1].fn();
      assert.equal(pollSignal.aborted, true);
      assert.equal(page.composer.isImageGenerating, false);
      const renders = page.renderStates.length;
      resolveRead({ messages: [{ id: 'late-image', role: 'assistant', content: 'Late' }] });
      await new Promise(setImmediate);
      assert.equal(page.renderStates.length, renders);
      assert.equal(page.rendered().messages.some(m => m.id === 'late-image'), false);
    } else {
      resolveRead({ messages: [{ id: 'image', role: 'assistant', content: 'Image ready' }] });
      await new Promise(setImmediate);
      assert.equal(page.composer.isImageGenerating, false);
      assert.equal(page.rendered().messages.at(-1).id, 'image');
    }
    assert.equal([...tasks.values()].some(task => task.ms === 120000 || task.ms === 3000), false);
  });
}

test("mouse selection in replies survives composer focus handlers", async t => {
  const pending = [];
  const page = await chatPage({ timers: {
    setTimeout: (fn, delay) => { const timer = setTimeout(fn, delay).unref(); pending.push({fn, delay}); return timer; },
  } });
  t.after(page.unmount);
  const { window } = page.app.dom;
  const paragraph = window.document.createElement("p");
  paragraph.textContent = "Select just this part of the assistant reply.";
  page.feed.element.append(paragraph);
  page.composer.textarea.blur();
  const pointer = new window.Event("pointerdown", { bubbles: true });
  Object.defineProperty(pointer, "pointerType", { value: "mouse" });
  paragraph.dispatchEvent(pointer);
  assert.notEqual(window.document.activeElement, page.composer.textarea, "drag start must not focus the composer");
  const selection = window.getSelection();
  const range = window.document.createRange();
  range.setStart(paragraph.firstChild, 7);
  range.setEnd(paragraph.firstChild, 21);
  selection.removeAllRanges();
  selection.addRange(range);
  paragraph.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  window.dispatchEvent(new window.Event("focus"));
  for (const timer of pending.filter(timer => [50, 150, 300, 600, 1000].includes(timer.delay))) timer.fn();
  assert.notEqual(window.document.activeElement, page.composer.textarea, "selection must survive click, tab focus and delayed autofocus");
  assert.equal(selection.toString(), "just this part");
});

test("clicking empty chat chrome still focuses the composer", async t => {
  const page = await chatPage();
  t.after(page.unmount);
  page.composer.textarea.blur();
  page.app.dom.window.document.querySelector(".chat-page").click();
  assert.equal(page.app.dom.window.document.activeElement, page.composer.textarea);
});

test("active composer stays compact on focus and expands for multiline drafts or attachments", async t => {
  const page = await chatPage();
  t.after(page.unmount);
  const { window } = page.app.dom;
  const { composer } = page;
  const form = composer.composer;

  // New chats start expanded with a greeting.
  assert.equal(form.classList.contains("is-compact"), false);
  assert.notEqual(composer.textarea.placeholder, "Write a message...");
  assert.ok(composer.textarea.placeholder.length > 0);

  // The first message switches to the active-chat placeholder.
  composer.textarea.value = "First message";
  composer.textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise(setImmediate);
  assert.equal(composer.textarea.value, "");
  assert.equal(form.classList.contains("is-compact"), true);
  assert.equal(composer.textarea.placeholder, "Write a message...");

  // Focus and short drafts keep the composer compact.
  composer.composerBox.click();
  assert.equal(window.document.activeElement, composer.textarea);
  assert.equal(form.classList.contains("is-compact"), true);
  composer.textarea.value = "N";
  composer.textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(form.classList.contains("is-compact"), true);
  assert.equal(composer.textarea.placeholder, "Write a message...");

  // Content wider than the compact input expands even if it fits the expanded row.
  let textWidth = 401;
  Object.defineProperties(composer.lineProbe, {
    clientWidth: { value: 400 },
    scrollWidth: { get: () => textWidth },
  });
  composer.setText("A long line");
  assert.equal(form.classList.contains("is-compact"), false);
  textWidth = 400;
  composer.setText("Short again");
  assert.equal(window.document.activeElement, composer.textarea);
  assert.equal(form.classList.contains("is-compact"), true);

  // Uploads and ready attachments expand the composer, then removing them compacts it.
  composer.uploadingFiles.push({ name: "photo.png", file: new window.File(["image"], "photo.png", { type: "image/png" }) });
  composer.renderAttachmentsBar();
  assert.equal(form.classList.contains("is-compact"), false);
  composer.uploadingFiles = [];
  composer.pendingAttachments.push({ filename: "photo.png", content_type: "image/png" });
  composer.renderAttachmentsBar();
  assert.equal(form.classList.contains("is-compact"), false);
  composer.attachmentsBar.querySelector('[aria-label="Remove attachment"]').click();
  assert.equal(form.classList.contains("is-compact"), true);

  // Mode toggle back from image mode restores "Write a message..." in active chat
  composer.applyTool("generate");
  assert.match(composer.textarea.placeholder, /Describe an image/);
  composer.selectModelFromDropdown("thinking");
  assert.equal(composer.isImageMode(), false);
  assert.equal(composer.textarea.placeholder, "Write a message...");

  // A manually inserted line survives blur without collapsing.
  composer.textarea.value = "Line 1\nLine 2";
  composer.textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  composer.textarea.blur();
  await new Promise(setImmediate);
  assert.equal(form.classList.contains("is-compact"), false);
  assert.equal(composer.textarea.value, "Line 1\nLine 2");

  // Sending multiline message returns to compact
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise(setImmediate);
  assert.equal(composer.textarea.value, "");
  assert.equal(form.classList.contains("is-compact"), true);
  assert.equal(composer.textarea.placeholder, "Write a message...");

  // Clicking without entering an image prompt still leaves the row compact.
  composer.composerBox.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  composer.currentModel = "image";
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  assert.equal(form.classList.contains("is-compact"), true);
});

test("opening an existing conversation starts composer compact without autofocus and uses standard placeholder", async t => {
  const page = await chatPage({
    id: "saved-chat",
    messages: [{ id: "m1", role: "user", content: "Hi" }, { id: "m2", role: "assistant", content: "Hello!" }],
  });
  t.after(page.unmount);
  assert.equal(page.composer.composer.classList.contains("is-compact"), true);
  assert.equal(page.composer.textarea.placeholder, "Write a message...");
  assert.notEqual(page.app.dom.window.document.activeElement, page.composer.textarea);
});

test("syncSkillLayout does not abort an active expand transition unless textarea height actually grows", async t => {
  const page = await chatPage({
    id: "saved-chat",
    messages: [{ id: "m1", role: "user", content: "Hi" }, { id: "m2", role: "assistant", content: "Hello!" }],
  });
  t.after(page.unmount);
  const { composer } = page;
  let scrollHeight = 38;
  Object.defineProperty(composer.textarea, "scrollHeight", { get: () => scrollHeight });
  composer.composerBox.getBoundingClientRect = () => ({
    height: composer.composer.classList.contains("is-compact") ? 50 : 102,
  });

  composer.setText("Line 1\nLine 2");
  assert.equal(composer.composerBox.classList.contains("is-resizing"), true);
  assert.equal(composer.composerBox.style.blockSize, "102px");

  // ResizeObserver firing syncSkillLayout with unchanged height must preserve transition
  composer.syncSkillLayout();
  assert.equal(composer.composerBox.classList.contains("is-resizing"), true);
  assert.equal(composer.composerBox.style.blockSize, "102px");

  // Growing the textarea mid-transition releases the pinned fallback blockSize
  scrollHeight = 76;
  composer.textarea.value = "Line 1\nLine 2\nLine 3";
  composer.textarea.dispatchEvent(new page.app.dom.window.Event("input", { bubbles: true }));
  assert.equal(composer.composerBox.classList.contains("is-resizing"), false);
  assert.equal(composer.composerBox.style.blockSize, "");
});

test("compact composer is desktop-only, aligns edge icons, animates intrinsic size, and keeps plus/mic static in CSS", async () => {
  const { readFile } = await import("node:fs/promises");
  const styles = await readFile(new URL("../css/styles.css", import.meta.url), "utf8");
  assert.match(styles, /:root\s*\{[^}]*interpolate-size:\s*allow-keywords;/);
  assert.match(styles, /@media\s*\(min-width:\s*769px\)\s*\{\s*\.composer\.has-messages\s+\.composer-box/);
  assert.match(styles, /\.composer\.is-compact\s+\.composer-box\s*\{[^}]*block-size:\s*50px;[^}]*padding:\s*6px 6px;/);
  assert.match(styles, /\.composer\.has-messages\s+\.composer-toolbar-actions\s*\{[^}]*gap:\s*2px;/);
  assert.match(styles, /\.composer\.has-messages\s+\.composer-attach,\s*\.composer\.has-messages\s+\.composer-voice,\s*\.composer\.has-messages\s+\.voice-assistant-btn\s*\{[^}]*width:\s*36px;\s*height:\s*36px;\s*border-radius:\s*10px;/);
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{\s*\.composer-box\s*\{[^}]*block-size\s+280ms/);
  assert.equal(styles.includes("micCapsuleBob"), false);
  assert.equal(/\.voice-mic:active\s*\{[^}]*transform/.test(styles), false);
  assert.match(styles, /\.composer-attach:hover\s+\.icon-plus[^{]*\{[^}]*transform:\s*none;/);
});

test("user message attachments render above the text bubble while assistant attachments stay below", async () => {
  const { moduleLoader } = await import("./modules.mjs");
  const app = moduleLoader({
    "markdown.js": { renderMarkdown: text => text },
    "image-modal.js": { openImageModal() {} },
  }, { globals: { HTMLElement: class {} } });
  const { messageBubble } = await app.load("js/components/message.js");
  const userEl = messageBubble({
    message: {
      id: "u1",
      role: "user",
      content: "whats that",
      delivery_status: "queued",
      attachments: [{ filename: "notes.pdf", content_type: "application/pdf", path: "p/notes.pdf" }],
    },
  });
  const userKids = Array.from(userEl.querySelector(".body").children);
  assert.ok(userKids.findIndex(n => n.classList.contains("message-attachments")) < userKids.findIndex(n => n.classList.contains("bubble")));
  const status = userEl.querySelector('[role="status"]');
  assert.equal(status.textContent, "Offline · Will send when connected");
  assert.equal(status.previousElementSibling.className, "bubble");

  const assistantEl = messageBubble({
    message: {
      id: "a1",
      role: "assistant",
      content: "Here is the image",
      attachments: [{ filename: "out.png", content_type: "image/png", url: "https://example.invalid/out.png" }],
    },
  });
  const assistantKids = Array.from(assistantEl.querySelector(".body").children);
  assert.ok(assistantKids.findIndex(n => n.classList.contains("bubble")) < assistantKids.findIndex(n => n.classList.contains("message-attachments")));
});

test("project icon animation is scoped to sidebar nav links and static in chat menu buttons", async () => {
  const { readFile } = await import("node:fs/promises");
  const styles = await readFile(new URL("../css/styles.css", import.meta.url), "utf8");
  assert.equal(styles.includes("button:hover .icon-galleryVerticalEnd"), false);
  assert.equal(styles.includes("button:hover .icon-projects"), false);
  assert.equal(styles.includes(".icon-galleryVerticalEnd:hover"), false);
  assert.equal(styles.includes(".icon-projects:hover"), false);
  assert.match(styles, /\.sidebar-nav a:hover \.icon-projects \.gallery-line-1/);
});

test("a second image with a closed stream can be retried in the same chat", async t => {
  const first = { filename: "derivative.png", path: "owner/derivative.png" };
  const second = { filename: "integral.png", path: "owner/integral.png" };
  let attempts = 0;
  const page = await chatPage({
    id: "original", hash: "#/app/chat/original",
    messages: [
      { id: "first", role: "user", content: "solve a", attachments: [first] },
      { id: "first-reply", role: "assistant", content: "Derivative" },
    ],
    streamChat: async (_token, payload, cb) => {
      cb.onUserMessage({ id: "second", role: "user", content: payload.message, attachments: payload.attachments });
      if (++attempts === 1) return;
      cb.onAssistantMessage({ id: "second-reply", role: "assistant", content: attempts === 2 ? "Integral" : "Regenerated integral" });
    },
  });
  t.after(page.unmount);
  await page.turn("solve g", { attachments: [second] });
  assert.match(page.notices.at(-1) || "", /closed before Bmo replied/i);
  await page.feed.callbacks.onRetryMessage(page.rendered().messages.at(-1));
  assert.equal(page.branchCalls.length, 0);
  assert.equal(page.app.dom.window.location.hash, "#/app/chat/original");
  assert.equal(page.payloads.at(-1).conversation_id, "original");
  assert.equal(page.payloads.at(-1).retry_message_id, "second");
  assert.deepEqual(page.payloads.at(-1).attachments, [second]);
  assert.deepEqual(Array.from(page.rendered().messages, m => m.id), ["first", "first-reply", "second", "second-reply"]);
  await page.feed.callbacks.onRetryAssistantMessage(page.rendered().messages.at(-1));
  assert.equal(page.branchCalls.length, 0);
  assert.deepEqual(Array.from(page.rendered().messages, m => m.id), ["first", "first-reply", "second", "second-reply"]);
  assert.equal(page.rendered().messages.at(-1).content, "Regenerated integral");
});
