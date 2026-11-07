// Bmo API client — talks only to the Render Flask gateway.
//
// Authentication uses the Supabase access token (a JWT). The frontend never
// hits Supabase Postgres directly: all reads/writes go through the gateway,
// which validates the JWT and uses the service role on the server side.

import { config } from "./config.js?v=30";
import { getAuth, refreshSession } from "./auth.js";
import { getClearance, hasTurnstile } from "./turnstile.js";

function authHeaders(token) {
  const t = getAuth().auth?.token || token;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

const clearancePaths = new Set(["/chat", "/images/generate", "/tts", "/tts/ticket", "/transcribe", "/search", "/scrape", "/attachments", "/export"]);

async function fetchWithClearance(url, options = {}) {
  const protectedRequest = options.method === "POST" && clearancePaths.has(new URL(url, location.href).pathname);
  if (!protectedRequest) return fetch(url, options);
  const token = (options.headers?.Authorization || "").replace(/^Bearer /i, "");
  let headers = { ...options.headers };
  if (hasTurnstile()) headers["X-Bimo-Clearance"] = await getClearance(token, {signal:options.signal});
  let response = await fetch(url, {...options,headers});
  if (response.status === 403) {
    let detail;
    try { detail = await response.clone().json(); } catch {}
    if (detail?.code === "verification_required") {
      headers = {...headers,"X-Bimo-Clearance":await getClearance(token,{signal:options.signal,force:true})};
      response = await fetch(url,{...options,headers});
    }
  }
  return response;
}

async function request(path, { method = "GET", body, blob = false, token, signal } = {}) {
  const execute = async (t) => {
    console.debug(`[bimo-api] ${method} ${path} auth=${t ? "yes" : "none"}`);
    const response = await fetchWithClearance(`${config.apiUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(t),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    console.debug(`[bimo-api] ${method} ${path} -> ${response.status}`);
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const error = new Error(detail.detail || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    if (blob) return response.blob();
    return response.json();
  };

  const initialToken = getAuth().auth?.token || token;
  try {
    return await execute(initialToken);
  } catch (error) {
    if (error.status === 401) {
      console.warn(`[bimo-api] 401 on ${path}, attempting silent session refresh...`);
      let newAuth;
      try {
        newAuth = await refreshSession();
      } catch (refreshError) {
        console.error("[bimo-api] Silent session refresh failed:", refreshError);
      }
      if (newAuth?.token) return execute(newAuth.token);
    }
    throw error;
  }
}

// ---------- session ----------

export async function me(token) {
  return request("/me", { token });
}

export async function deleteAccount(token) {
  return request("/me", { method: "DELETE", token });
}

// Save the "What's new in Bmo 5" survey (birthday/role) and mark it seen.
// "Not now" sends an empty body — the backend still flips onboarding_seen.
export async function saveOnboarding(token, payload) {
  return request("/onboarding", { method: "POST", token, body: payload });
}

// ---------- conversations ----------

export async function listConversations(token) {
  return request("/conversations", { token });
}

export async function getMessages(token, conversationId) {
  return request(`/conversations/${conversationId}/messages`, { token });
}

export async function deleteConversation(token, conversationId) {
  return request(`/conversations/${conversationId}`, { method: "DELETE", token });
}

export async function branchConversation(token, conversationId, beforeMessageId) {
  return request(`/conversations/${conversationId}/branch`, {
    method: "POST", token, body: { before_message_id: beforeMessageId },
  });
}

export async function updateConversation(token, conversationId, patch) {
  return request(`/conversations/${conversationId}`, {
    method: "PATCH",
    token,
    body: patch,
  });
}

export async function shareConversation(token, conversationId) {
  return request(`/conversations/${encodeURIComponent(conversationId)}/share`, { method: "POST", token });
}

export async function getConversationShare(token, conversationId) {
  return request(`/conversations/${encodeURIComponent(conversationId)}/share`, { token });
}

export async function deleteConversationShare(token, conversationId) {
  return request(`/conversations/${encodeURIComponent(conversationId)}/share`, { method: "DELETE", token });
}

export async function getPublicShare(shareId, signal) {
  return request(`/share/${encodeURIComponent(shareId)}`, { signal });
}

// ---------- chat (streaming) ----------

/**
 * Streams an assistant turn from `/chat`. The gateway emits server-sent
 * events with one of these `type`s:
 *   - "conversation"      conversation row (whether new or existing)
 *   - "user_message"      the persisted user message row
 *   - "searching"         { query } Bmo chose to search; results are pending
 *   - "search_complete"   { count, elapsed_ms, results } search finished (count may be 0)
 *   - "token"             { delta, content } incremental text
 *   - "assistant_message" the persisted assistant message row (final)
 *   - "error"             { detail }
 */
export async function streamChat(token, payload, handlers = {}) {
  const { onConversation, onUserMessage, onToken, onReasoningToken, onAssistantMessage, onComplete, onError, onSearching, onSearchComplete, onVoiceStyle, signal } = handlers;
  const checkAborted = () => { if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError"); };
  checkAborted();
  
  // Extract incognito flag if present so we don't send it to the normal payload
  const isIncognito = !!payload.incognito;
  const bodyPayload = { ...payload };
  delete bodyPayload.incognito;

  const execute = async (t) => {
    const endpoint = isIncognito ? `${config.apiUrl}/chat/incognito` : `${config.apiUrl}/chat`;
    const response = await fetchWithClearance(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...authHeaders(t),
      },
      body: JSON.stringify(bodyPayload),
      signal,
    });

    if (!response.ok || !response.body) {
      const detail = await response.json().catch(() => ({}));
      const error = new Error(detail.detail || `Chat failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response;
  };

  let response;
  const initialToken = getAuth().auth?.token || token;
  try {
    response = await execute(initialToken);
  } catch (error) {
    if (error.status === 401) {
      console.warn("[bimo-api] streamChat received 401, attempting silent session refresh...");
      try {
        const newAuth = await refreshSession();
        if (newAuth?.token) {
          console.info("[bimo-api] Session refreshed successfully, retrying streamChat...");
          response = await execute(newAuth.token);
        } else {
          if (onError) onError(error);
          throw error;
        }
      } catch (refreshError) {
        console.error("[bimo-api] Silent session refresh failed during streamChat:", refreshError);
        if (onError) onError(error);
        throw error;
      }
    } else {
      if (onError) onError(error);
      throw error;
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistant = null;
  let completed = false;
  try {
  while (true) {
    checkAborted();
    const { value, done } = await reader.read();
    checkAborted();
    if (done) break;
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");

    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const raw = dataLine.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        continue;
      }
      switch (event.type) {
        case "conversation":
          onConversation?.(event.data);
          break;
        case "user_message":
          onUserMessage?.(event.data);
          break;
        case "searching":
          // Bmo decided this turn needs live results and is fetching them.
          onSearching?.({ query: event.query || "" });
          break;
        case "search_complete":
          onSearchComplete?.({
            count: event.count || 0,
            elapsedMs: event.elapsed_ms ?? null,
            results: event.results || [],
          });
          break;
        case "token":
          onToken?.(event.data);
          break;
        case "voice_style":
          onVoiceStyle?.(event.data);
          break;
        case "reasoning_token":
          onReasoningToken?.(event.data);
          break;
        case "complete":
          // Model finished generating; the persisted assistant_message follows
          // after the server's DB writes. Lets the UI drop the caret instantly.
          completed = true;
          onComplete?.();
          break;
        case "assistant_message":
          assistant = event.data;
          onAssistantMessage?.(event.data);
          break;
        case "error": {
          const err = new Error(event.detail || "Chat error");
          if ([409, 429, 503].includes(event.status)) err.status = event.status;
          throw err;
        }
        default:
          break;
      }
    }
  }
  if (!assistant && !(isIncognito && completed)) {
    const error = new Error("Response interrupted. Check the conversation before retrying.");
    error.interrupted = true;
    throw error;
  }
  return assistant;
  } catch (error) {
    await reader.cancel?.().catch(() => {});
    if (error.name !== "AbortError") onError?.(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

// Explicit Stop: tell the gateway to halt server-side generation for this
// turn. Leaving the page does NOT call this (generation continues in the
// background); only the Stop button does. Best-effort — ignore failures.
export async function cancelChat(token, streamId) {
  if (!streamId) return;
  try {
    await request(`/chat/${encodeURIComponent(streamId)}/cancel`, { method: "POST", token });
  } catch {
    /* best-effort */
  }
}

// ---------- image generation (Iris) ----------

// Generate an image. `payload` = { prompt, conversation_id?, attachments? }.
// Returns { conversation, user_message, assistant_message, blocked? } — the
// assistant_message carries the generated image as an attachment (or a refusal
// string when `blocked` is true).
export async function generateImage(token, payload, signal) {
  return request("/images/generate", { method: "POST", token, body: payload, signal });
}

// ---------- web search ----------

// Returns { answer, results } from TinyFish Search — `results` is up to 8
// { title, content, url, published_date }. The gateway holds the TinyFish
// key server-side; the browser only sees the query.
export async function searchWeb(token, query, signal) {
  return request("/search", { method: "POST", token, body: { query }, signal });
}

// ---------- web scraping (TinyFish Fetch) ----------

// Scrapes a webpage with TinyFish and returns { markdown, title, description, url }.
export async function scrapeUrl(token, url, signal) {
  return request("/scrape", { method: "POST", token, body: { url }, signal });
}

// ---------- feedback (per-message thumbs up/down) ----------

export async function submitFeedback(token, payload) {
  return request("/feedback", { method: "POST", token, body: payload });
}

// ---------- attachments ----------

export async function uploadAttachment(token, file, signal) {
  const execute = async (t) => {
    const fd = new FormData();
    fd.append("file", file);
    const response = await fetchWithClearance(`${config.apiUrl}/attachments`, {
      method: "POST",
      headers: authHeaders(t),
      body: fd,
      signal,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const error = new Error(detail.detail || `Upload failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };

  const initialToken = getAuth().auth?.token || token;
  try {
    return await execute(initialToken);
  } catch (error) {
    if (error.status === 401) {
      console.warn("[bimo-api] uploadAttachment received 401, attempting silent session refresh...");
      try {
        const newAuth = await refreshSession();
        if (newAuth?.token) {
          console.info("[bimo-api] Session refreshed successfully, retrying uploadAttachment...");
          return await execute(newAuth.token);
        }
      } catch (refreshError) {
        console.error("[bimo-api] Silent session refresh failed:", refreshError);
      }
    }
    throw error;
  }
}

// ---------- models ----------

export async function listModels(token) {
  return request("/models", { token });
}

// ---------- voice transcription ----------

export async function transcribeAudio(token, audioBlob, { language, signal } = {}) {
  const execute = async (t) => {
    const fd = new FormData();
    const isWav = (audioBlob.type || "").includes("wav");
    fd.append("audio", audioBlob, isWav ? "recording.wav" : "recording.webm");
    if (language) fd.append("language", language);
    const response = await fetchWithClearance(`${config.apiUrl}/transcribe`, {
      method: "POST",
      headers: authHeaders(t),
      body: fd,
      signal,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const error = new Error(detail.detail || `Transcription failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };

  const initialToken = getAuth().auth?.token || token;
  try {
    return await execute(initialToken);
  } catch (error) {
    if (error.status === 401) {
      console.warn("[bimo-api] transcribeAudio received 401, attempting silent session refresh...");
      try {
        const newAuth = await refreshSession();
        if (newAuth?.token) {
          console.info("[bimo-api] Session refreshed successfully, retrying transcribeAudio...");
          return await execute(newAuth.token);
        }
      } catch (refreshError) {
        console.error("[bimo-api] Silent session refresh failed:", refreshError);
      }
    }
    throw error;
  }
}

// ---------- voice synthesis (text-to-speech) ----------

// Returns the assistant reply spoken by magpie-tts-multilingual as a WAV
// ArrayBuffer. We hand back the raw bytes so the caller can decode them with
// the Web Audio API (no <audio> element, so it stays within the CSP and lets
// us drive the globe from the audio amplitude).
export async function synthesizeSpeech(token, text, { voice, language } = {}) {
  const execute = async (t) => {
    const response = await fetchWithClearance(`${config.apiUrl}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(t) },
      body: JSON.stringify({ text, voice, language }),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const error = new Error(detail.detail || `Speech synthesis failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response.arrayBuffer();
  };

  const initialToken = getAuth().auth?.token || token;
  try {
    return await execute(initialToken);
  } catch (error) {
    if (error.status === 401) {
      console.warn("[bimo-api] synthesizeSpeech received 401, attempting silent session refresh...");
      try {
        const newAuth = await refreshSession();
        if (newAuth?.token) {
          console.info("[bimo-api] Session refreshed successfully, retrying synthesizeSpeech...");
          return await execute(newAuth.token);
        }
      } catch (refreshError) {
        console.error("[bimo-api] Silent session refresh failed:", refreshError);
      }
    }
    throw error;
  }
}

export async function createTtsTicket(token, { model = "flux-sienna-en", sampleRate = 24000, speed, expressivity, signal } = {}) {
  return request("/tts/ticket", { method: "POST", token, signal,
    body: { model, sample_rate: sampleRate, speed, expressivity } });
}

export function ttsStreamUrl(ticket) {
  if (typeof ticket !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
    throw new Error("A fresh voice ticket is required.");
  }
  let base = (config.apiUrl || "").replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  if (!base.startsWith("ws://") && !base.startsWith("wss://")) {
    base = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  }
  const params = new URLSearchParams();
  params.set("ticket", ticket);
  return `${base.replace(/\/+$/, "")}/tts/stream?${params.toString()}`;
}

// ---------- document export ----------

/**
 * Request binary document export (.md, .pdf, .docx) from /export endpoint.
 * Follows Supabase JWT authentication and silent session refresh on 401.
 */
export async function exportDocument(token, { title, markdown, format }, signal) {
  const execute = async (t) => {
    const response = await fetchWithClearance(`${config.apiUrl}/export`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(t),
      },
      body: JSON.stringify({ title, markdown, format }),
      signal,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const error = new Error(detail.detail || `Export failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response.blob();
  };

  const initialToken = getAuth().auth?.token || token;
  try {
    return await execute(initialToken);
  } catch (error) {
    if (error.status === 401) {
      console.warn("[bimo-api] exportDocument received 401, attempting silent session refresh...");
      try {
        const newAuth = await refreshSession();
        if (newAuth?.token) {
          console.info("[bimo-api] Session refreshed successfully, retrying exportDocument...");
          return await execute(newAuth.token);
        }
      } catch (refreshError) {
        console.error("[bimo-api] Silent session refresh failed during exportDocument:", refreshError);
      }
    }
    throw error;
  }
}

// ---------- usage ----------


export async function getUsage(token) {
  return request("/usage", { token });
}

// ---------- projects ----------

export async function listProjects(token, { includeArchived = false } = {}) {
  const query = includeArchived ? "?archived=true" : "";
  return request(`/projects${query}`, { token });
}

export async function getProject(token, projectId) {
  return request(`/projects/${projectId}`, { token });
}

export async function createProject(token, { name, description = "", instructions = "" }) {
  return request("/projects", {
    method: "POST",
    token,
    body: { name, description, instructions },
  });
}

export async function updateProject(token, projectId, patch) {
  return request(`/projects/${projectId}`, {
    method: "PATCH",
    token,
    body: patch,
  });
}

export async function deleteProject(token, projectId) {
  return request(`/projects/${projectId}`, { method: "DELETE", token });
}

export function uploadProjectFileWithProgress(token, projectId, file, onProgress) {
  return uploadFileWithProgress(token, `/projects/${projectId}/files`, file, onProgress);
}

function uploadFileWithProgress(token, path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const attempt = (t, retried = false) => {
      const xhr = new XMLHttpRequest();
      const fd = new FormData();
      fd.append("file", file);
      xhr.open("POST", `${config.apiUrl}${path}`);
      xhr.timeout = 120000;
      const headers = authHeaders(t);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0 && onProgress) onProgress(Math.min(1, e.loaded / e.total));
      };
      xhr.upload.onload = () => onProgress?.(1);
      xhr.onload = async () => {
        if (xhr.status === 401 && !retried) {
          try {
            const newAuth = await refreshSession();
            if (newAuth?.token) return attempt(newAuth.token, true);
          } catch (_) { /* fall through */ }
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (_) {
            reject(new Error("Upload failed: bad response"));
          }
        } else {
          let detail = {};
          try { detail = JSON.parse(xhr.responseText); } catch (_) {}
          const error = new Error(detail.detail || `Upload failed (${xhr.status})`);
          error.status = xhr.status;
          reject(error);
        }
      };
      xhr.onerror = () => reject(new Error("Upload failed: network error"));
      xhr.ontimeout = () => reject(new Error("Upload timed out. Please try again."));
      xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
      onProgress?.(0);
      xhr.send(fd);
    };
    attempt(getAuth().auth?.token || token);
  });
}

export async function getProjectFilePreview(token, projectId, fileId) {
  return request(`/projects/${projectId}/files/${fileId}`, { token });
}

export async function deleteProjectFile(token, projectId, fileId) {
  return request(`/projects/${projectId}/files/${fileId}`, {
    method: "DELETE",
    token,
  });
}

// ---------- health ----------

export async function health() {
  try {
    const response = await fetchWithClearance(`${config.apiUrl}/health`);
    if (!response.ok) return { status: "down" };
    return response.json();
  } catch {
    return { status: "down" };
  }
}

// ---------- Customize ----------
export const getInstructions = token => request("/preferences", { token });
export const saveInstructions = (token, instructions) => request("/preferences", {
  method: "PUT", token, body: { instructions },
});
export const listSkills = token => request("/skills", { token });
export const getSkill = (token, id) => request(`/skills/${encodeURIComponent(id)}`, { token });
export const createSkill = (token, body) => request("/skills", { method: "POST", token, body });
export const updateSkill = (token, id, body) => request(`/skills/${encodeURIComponent(id)}`, { method: "PUT", token, body });
export const deleteSkill = (token, id) => request(`/skills/${encodeURIComponent(id)}`, { method: "DELETE", token });
export const setSkillEnabled = (token, id, enabled) => request(`/skills/${encodeURIComponent(id)}/enabled`, {
  method: "PUT", token, body: { enabled },
});
export function uploadSkill(token, file, onProgress) {
  return uploadFileWithProgress(token, "/skills/upload", file, onProgress);
}
export const exportSkill = (token, id) => request(`/skills/${encodeURIComponent(id)}/export`, { token, blob: true });
