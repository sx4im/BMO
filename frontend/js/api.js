// BMO API client — talks only to the Render Flask gateway.
//
// Authentication uses the Supabase access token (a JWT). The frontend never
// hits Supabase Postgres directly: all reads/writes go through the gateway,
// which validates the JWT and uses the service role on the server side.

import { config } from "./config.js?v=30";
import { getAuth, refreshSession } from "./auth.js?v=31";
import { supabaseClient, isSupabaseConfigured } from "./supabaseClient.js?v=30";

function authHeaders(token) {
  const t = getAuth().auth?.token || token;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function request(path, { method = "GET", body, token, signal } = {}) {
  const execute = async (t) => {
    console.debug(`[bimo-api] ${method} ${path} auth=${t ? "yes" : "none"}`);
    const response = await fetch(`${config.apiUrl}${path}`, {
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
    return response.json();
  };

  const initialToken = getAuth().auth?.token || token;
  try {
    return await execute(initialToken);
  } catch (error) {
    if (error.status === 401) {
      console.warn(`[bimo-api] 401 on ${path}, attempting silent session refresh...`);
      try {
        const newAuth = await refreshSession();
        if (newAuth?.token) {
          console.info(`[bimo-api] Session refreshed successfully, retrying ${method} ${path}...`);
          return await execute(newAuth.token);
        }
      } catch (refreshError) {
        console.error("[bimo-api] Silent session refresh failed:", refreshError);
      }
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

// Save the "What's new in BMO 5" survey (birthday/role) and mark it seen.
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

export async function updateConversation(token, conversationId, patch) {
  return request(`/conversations/${conversationId}`, {
    method: "PATCH",
    token,
    body: patch,
  });
}

export async function shareConversation(token, conversationId) {
  try {
    return await request(`/conversations/${conversationId}/share`, {
      method: "POST",
      token,
    });
  } catch (err) {
    if (isSupabaseConfigured()) {
      try {
        const client = supabaseClient();
        const { auth } = getAuth();
        const userId = auth?.user?.id;

        const { data: conv, error: convErr } = await client
          .from("conversations")
          .select("id, title, model")
          .eq("id", conversationId)
          .single();
        if (convErr || !conv) throw err;

        const { data: msgs, error: msgErr } = await client
          .from("messages")
          .select("id, role, content, reasoning, attachments, created_at")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: true });
        if (msgErr) throw err;

        const cleanMsgs = (msgs || []).map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          reasoning: m.reasoning,
          attachments: m.attachments,
          created_at: m.created_at,
        }));

        const now = new Date().toISOString();
        const { data: shared, error: shareErr } = await client
          .from("shared_conversations")
          .upsert(
            {
              conversation_id: conversationId,
              user_id: userId,
              title: conv.title || "Shared conversation",
              model: conv.model,
              snapshot: cleanMsgs,
              updated_at: now,
            },
            { onConflict: "conversation_id" }
          )
          .select("id, title, model, created_at, updated_at")
          .single();

        if (shareErr || !shared) throw err;
        return {
          success: true,
          share_id: shared.id,
          title: shared.title,
          model: shared.model,
          created_at: shared.created_at,
          updated_at: shared.updated_at,
        };
      } catch (fallbackErr) {
        console.warn("[bimo-api] Direct Supabase share fallback:", fallbackErr);
        throw err;
      }
    }
    throw err;
  }
}

export async function getConversationShare(token, conversationId) {
  try {
    return await request(`/conversations/${conversationId}/share`, { token });
  } catch (err) {
    if (isSupabaseConfigured()) {
      try {
        const client = supabaseClient();
        const { data, error } = await client
          .from("shared_conversations")
          .select("id, conversation_id, title, model, created_at, updated_at")
          .eq("conversation_id", conversationId)
          .maybeSingle();

        if (!error && data) {
          return {
            shared: true,
            share_id: data.id,
            title: data.title,
            model: data.model,
            created_at: data.created_at,
            updated_at: data.updated_at,
          };
        }
        return { shared: false };
      } catch {
        return { shared: false };
      }
    }
    return { shared: false };
  }
}

export async function deleteConversationShare(token, conversationId) {
  try {
    return await request(`/conversations/${conversationId}/share`, {
      method: "DELETE",
      token,
    });
  } catch (err) {
    if (isSupabaseConfigured()) {
      try {
        const client = supabaseClient();
        await client
          .from("shared_conversations")
          .delete()
          .eq("conversation_id", conversationId);
        return { success: true, deleted: true };
      } catch {
        throw err;
      }
    }
    throw err;
  }
}

export async function getPublicShare(shareId) {
  try {
    return await request(`/share/${shareId}`);
  } catch (err) {
    if (isSupabaseConfigured()) {
      try {
        const client = supabaseClient();
        const { data, error } = await client
          .from("shared_conversations")
          .select("id, title, model, snapshot, created_at, updated_at")
          .eq("id", shareId)
          .single();

        if (error || !data) {
          throw new Error("Shared conversation not found");
        }
        return {
          id: data.id,
          title: data.title,
          model: data.model,
          messages: data.snapshot || [],
          created_at: data.created_at,
          updated_at: data.updated_at,
        };
      } catch (fallbackErr) {
        throw fallbackErr;
      }
    }
    throw err;
  }
}

// ---------- chat (streaming) ----------

/**
 * Streams an assistant turn from `/chat`. The gateway emits server-sent
 * events with one of these `type`s:
 *   - "conversation"      conversation row (whether new or existing)
 *   - "user_message"      the persisted user message row
 *   - "searching"         { query } BMO chose to search; results are pending
 *   - "search_complete"   { count, elapsed_ms, results } search finished (count may be 0)
 *   - "token"             { delta, content } incremental text
 *   - "assistant_message" the persisted assistant message row (final)
 *   - "error"             { detail }
 */
export async function streamChat(token, payload, handlers = {}) {
  const { onConversation, onUserMessage, onToken, onReasoningToken, onAssistantMessage, onComplete, onError, onSearching, onSearchComplete, signal } = handlers;
  
  // Extract incognito flag if present so we don't send it to the normal payload
  const isIncognito = !!payload.incognito;
  const bodyPayload = { ...payload };
  delete bodyPayload.incognito;

  const execute = async (t) => {
    const endpoint = isIncognito ? `${config.apiUrl}/chat/incognito` : `${config.apiUrl}/chat`;
    const response = await fetch(endpoint, {
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

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

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
          // BMO decided this turn needs live results and is fetching them.
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
        case "reasoning_token":
          onReasoningToken?.(event.data);
          break;
        case "complete":
          // Model finished generating; the persisted assistant_message follows
          // after the server's DB writes. Lets the UI drop the caret instantly.
          onComplete?.();
          break;
        case "assistant_message":
          assistant = event.data;
          onAssistantMessage?.(event.data);
          break;
        case "error": {
          const err = new Error(event.detail || "Chat error");
          if (onError) onError(err);
          throw err;
        }
        default:
          break;
      }
    }
  }
  return assistant;
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

export async function uploadAttachment(token, file) {
  const execute = async (t) => {
    const fd = new FormData();
    fd.append("file", file);
    const response = await fetch(`${config.apiUrl}/attachments`, {
      method: "POST",
      headers: authHeaders(t),
      body: fd,
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

export async function transcribeAudio(token, audioBlob, { language } = {}) {
  const execute = async (t) => {
    const fd = new FormData();
    const isWav = (audioBlob.type || "").includes("wav");
    fd.append("audio", audioBlob, isWav ? "recording.wav" : "recording.webm");
    if (language) fd.append("language", language);
    const response = await fetch(`${config.apiUrl}/transcribe`, {
      method: "POST",
      headers: authHeaders(t),
      body: fd,
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
    const response = await fetch(`${config.apiUrl}/tts`, {
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

export function ttsStreamUrl(token, { model = "flux-sienna-en", sampleRate = 24000 } = {}) {
  const t = getAuth().auth?.token || token || "";
  let base = (config.apiUrl || "").replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
  if (!base.startsWith("ws://") && !base.startsWith("wss://")) {
    base = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`;
  }
  const params = new URLSearchParams();
  if (t) params.set("token", t);
  if (model) params.set("model", model);
  if (sampleRate) params.set("sample_rate", String(sampleRate));
  return `${base.replace(/\/+$/, "")}/tts/stream?${params.toString()}`;
}

// ---------- document export ----------

/**
 * Request binary document export (.md, .pdf, .docx) from /export endpoint.
 * Follows Supabase JWT authentication and silent session refresh on 401.
 */
export async function exportDocument(token, { title, markdown, format }, signal) {
  const execute = async (t) => {
    const response = await fetch(`${config.apiUrl}/export`, {
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

// ---------- health ----------

export async function health() {
  try {
    const response = await fetch(`${config.apiUrl}/health`);
    if (!response.ok) return { status: "down" };
    return response.json();
  } catch {
    return { status: "down" };
  }
}
