// Lazy Supabase client. Imports the official SDK from an ESM CDN so the
// frontend stays build-step-free. The client is initialised on first access
// using whatever URL + anon key are configured at runtime (config.js).

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm";
import { config } from "./config.js?v=30";

let _client = null;
let _signature = null;

function currentSignature() {
  return `${config.supabaseUrl}::${config.supabaseAnonKey}`;
}

export function isSupabaseConfigured() {
  return config.isSupabaseConfigured();
}

export function supabaseClient() {
  if (!isSupabaseConfigured()) {
    const error = new Error(
      "Supabase is not configured yet. Open Settings → Environment and paste your Supabase URL and anon key."
    );
    error.code = "supabase_not_configured";
    throw error;
  }
  const sig = currentSignature();
  if (!_client || sig !== _signature) {
    _client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: "bimo-auth",
        flowType: "pkce",
      },
    });
    _signature = sig;
  }
  return _client;
}

export function resetSupabaseClient() {
  _client = null;
  _signature = null;
}
