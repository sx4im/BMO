// Full-screen voice assistant (BMO Voice).
//
// Flow: open -> listen (live transcription) -> on silence, send the turn ->
// voice-themed wait text while the reply streams -> read the reply aloud
// (magpie-tts-multilingual) -> listen again. The X closes it. A glowing globe
// reflects the state and pulses with the spoken audio.
//
// Speech-to-text always uses the MediaRecorder + /transcribe backend path.
// The browser's Web Speech API is NOT used. Recording auto-stops via an
// ADAPTIVE Web Audio VAD (see the tuning block below): it learns the room's
// noise floor and only counts input a multiple louder than that as speech,
// so background noise neither holds the mic open nor triggers a turn.
//
// Text-to-speech audio is decoded and played through the Web Audio API rather
// than an <audio> element: that keeps it inside the site CSP (the fetch is a
// normal API call) and lets an AnalyserNode drive the globe animation.

import { el } from "../utils.js?v=30";
import { icon } from "../icons.js?v=58";
import { toast } from "./toast.js?v=58";
import * as api from "../api.js?v=30";
import { blobToWav16kMono } from "../audio-wav.js?v=30";

const VOICE_WAIT_PHRASES = [
  "Listening…",
  "Transcribing…",
  "Understanding…",
  "Thinking…",
  "Processing…",
  "Responding…",
];

let _lastVoiceWaitIndex = -1;
function voiceWaitPhrase() {
  let i;
  do {
    i = Math.floor(Math.random() * VOICE_WAIT_PHRASES.length);
  } while (i === _lastVoiceWaitIndex && VOICE_WAIT_PHRASES.length > 1);
  _lastVoiceWaitIndex = i;
  return VOICE_WAIT_PHRASES[i];
}

// ---------- voice-activity detection (VAD) tuning ----------
// The mic may be at arm's length (laptop) OR close to the mouth (phone), so the
// signal level varies a lot. The detector continuously tracks the noise floor
// (dropping fast in quiet gaps, rising only slowly so the user's own voice
// can't drag it up) and treats the input as speech only when the voice-band
// level climbs a multiple above that floor. Steady background noise — fan,
// traffic, café chatter — therefore never holds the mic open, and the turn
// auto-ends after VAD_SILENCE_MS of quiet once the user HAS actually spoken.
//
// IMPORTANT: capture runs with autoGainControl OFF (see startRecorder). AGC
// inflates the silent-gap noise floor toward the speech level, which shrinks
// the speech-to-noise ratio this RELATIVE gate depends on — that's why a far
// laptop mic kept reading as "no speech" while a close phone mic worked. The
// VAD is also no longer a hard gate: a take that has audio is transcribed even
// if the VAD missed it (see onRecorderStop), so these thresholds only affect
// HOW PROMPTLY a turn auto-ends, never whether speech is heard at all.
// ponytail: these six constants ARE the calibration knob — if a noisy room
// false-triggers, raise VAD_MIN_LEVEL/VAD_ENTER_FACTOR; if a soft talker still
// isn't heard, lower them. No code change needed.
const VAD_CALIBRATE_MS = 200;    // settle on the room level before judging speech
const VAD_ENTER_FACTOR = 2.0;    // speech: level > floor * 2.0 (and > MIN)
const VAD_EXIT_FACTOR  = 1.4;    // silence again below floor * 1.4 (hysteresis)
const VAD_MIN_LEVEL    = 0.005;  // absolute gate so dead-quiet rooms don't fire on hiss
const VAD_ENTER_FRAMES = 2;      // ~2 consecutive loud frames (~35 ms) to confirm speech
const VAD_SILENCE_MS   = 2000;   // wait 2.0s of silence so user can pause and think naturally
const VAD_NO_SPEECH_MS = 8000;   // never spoke -> release the mic, don't transcribe noise
const VAD_MAX_TURN_MS  = 60000;  // hard safety cap per turn

// Expand 4-digit years (e.g. 1986 -> nineteen eighty-six) if present
function expandYearsForSpeech(text) {
  const ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

  function twoDigits(n) {
    if (n < 20) return ONES[n];
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return ones ? `${TENS[tens]}-${ONES[ones]}` : TENS[tens];
  }

  return String(text).replace(/\b(19|20)(\d{2})\b/g, (_, century, year) => {
    const cVal = parseInt(century, 10);
    const yVal = parseInt(year, 10);
    const cWords = cVal === 19 ? "nineteen" : "twenty";
    if (yVal === 0) return cVal === 20 ? "two thousand" : "nineteen hundred";
    if (yVal < 10 && cVal === 20) return `two thousand ${ONES[yVal]}`;
    if (yVal < 10) return `${cWords} oh ${ONES[yVal]}`;
    return `${cWords} ${twoDigits(yVal)}`;
  });
}

// Turn assistant markdown into something worth speaking: drop code, math,
// images, and markdown punctuation so the model doesn't read backticks/pipes.
// Ellipses ('...') are only allowed at the very start of a turn (e.g. 'Hmm...', 'Ahh...').
// In the middle or end of speech, ellipses are converted to natural comma pauses so TTS doesn't delay.
function stripForSpeech(md = "", isStartOfTurn = false) {
  const cleaned = String(md)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$\n]*\$/g, " ")
    .replace(/[#*_>~|`]/g, " ")
    .replace(/(\.{2,}|…)/g, (match, _, offset) => {
      return (isStartOfTurn && offset <= 8) ? match : ", ";
    })
    .replace(/[ \t\r\n]+/g, " ");
  return expandYearsForSpeech(cleaned);
}

export const VOICE_LANGUAGES = [
  { id: "en", code: "EN", label: "English", voiceName: "Sienna", model: "flux-sienna-en", recLang: "en-US" },
  { id: "nl", code: "NL", label: "Dutch", voiceName: "Rhea", model: "aura-2-rhea-nl", recLang: "nl-NL" },
  { id: "fr", code: "FR", label: "French", voiceName: "Agathe", model: "aura-2-agathe-fr", recLang: "fr-FR" },
  { id: "de", code: "DE", label: "German", voiceName: "Aurelia", model: "aura-2-aurelia-de", recLang: "de-DE" },
  { id: "it", code: "IT", label: "Italian", voiceName: "Livia", model: "aura-2-livia-it", recLang: "it-IT" },
  { id: "es", code: "ES", label: "Spanish", voiceName: "Celeste", model: "aura-2-celeste-es", recLang: "es-ES" },
  { id: "ja", code: "JA", label: "Japanese", voiceName: "Izanami", model: "aura-2-izanami-ja", recLang: "ja-JP" },
];

/**
 * @param {object} ctx
 * @param {string} ctx.token - Supabase access token for API calls.
 * @param {(text:string)=>Promise<string>} ctx.sendTurn - sends a user turn and
 *        resolves with the assistant's reply text.
 * @param {()=>void} [ctx.onClose] - called when the overlay closes.
 * @returns {{ close: ()=>void }}
 */
export function openVoiceOverlay({ token, sendTurn, onClose } = {}) {
  let active = true;
  let state = "idle";
  let turnInFlight = false;

  let mediaRecorder = null;
  let mediaStream = null;
  let audioChunks = [];

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let speechRecSupported = !!SpeechRec;

  // Brave disables Google's Web Speech backend by default for privacy.
  // Proactively detect Brave and route straight to MediaRecorder + Whisper/Riva.
  let isBraveBrowser = false;
  if (typeof navigator !== "undefined" && navigator.brave && typeof navigator.brave.isBrave === "function") {
    navigator.brave.isBrave().then((val) => {
      if (val) {
        console.info("[bimo-voice] Brave detected; routing speech input to MediaRecorder");
        isBraveBrowser = true;
        speechRecSupported = false;
        if (state === "listening" && recognition) {
          stopRecognition();
          startRecorder();
        }
      }
    }).catch(() => {});
  }

  let audioCtx = null;
  let ttsSource = null;
  let meterRaf = null;
  let activeSpeech = null;   // current speech playback handle

  // Language selection (7 supported languages)
  let currentLangId = "en";
  try {
    const saved = localStorage.getItem("bimo-voice-lang");
    if (saved && VOICE_LANGUAGES.some((l) => l.id === saved)) currentLangId = saved;
  } catch {}

  function getLangConfig() {
    return VOICE_LANGUAGES.find((l) => l.id === currentLangId) || VOICE_LANGUAGES[0];
  }

  // Persistent Deepgram TTS WebSocket across turns
  let ttsWS = null;

  function ensureTTSWS() {
    if (!active) return null;
    if (ttsWS && (ttsWS.readyState === WebSocket.OPEN || ttsWS.readyState === WebSocket.CONNECTING)) {
      return ttsWS;
    }
    try {
      const activeLang = getLangConfig();
      const streamUrl = api.ttsStreamUrl(token, { model: activeLang.model, sampleRate: 24000 });
      const ws = new WebSocket(streamUrl);
      ws.binaryType = "arraybuffer";
      ttsWS = ws;
      ws.onclose = () => {
        if (ttsWS === ws) ttsWS = null;
      };
      return ws;
    } catch (e) {
      console.warn("[bimo-voice] Pre-warm WebSocket failed:", e);
      return null;
    }
  }

  // Pre-warm the WebSocket immediately so first turn has 0ms connection latency
  ensureTTSWS();

  // Voice-activity detection state (tuning constants at the top of the file).
  let vadAnalyser = null;
  let vadSource = null;
  let vadRaf = null;
  let vadHadSpeech = false;   // did this take ever contain confirmed speech?
  let discardTake = false;    // drop the in-flight recording on stop (typed turn)
  let recordStartedAt = 0;    // performance.now() when the current take began

  const TTS_COOLDOWN_MS = 500; // pause after BMO speaks before listening again

  // ---------- DOM ----------
  // The orb is a muted, looping video of the iridescent bubble. CSS blends its
  // near-white background into the cream canvas (mix-blend-mode: multiply) so
  // only the bubble shows. State classes on the wrapper drive the float/pulse
  // and the amplitude-reactive scale while speaking.
  const globeVideo = el("video", {
    class: "voice-globe-video",
    src: "/assets/voice-orb.mp4",
    autoplay: true,
    loop: true,
    muted: true,
    playsInline: true,
    preload: "auto",
    "aria-hidden": "true",
  });
  globeVideo.muted = true; // required for muted autoplay in some browsers
  // Overlay layers on top of the untouched bubble video: a soft ambient glow
  // behind it, a specular glint that orbits the bubble, and a mouth that smiles
  // at rest and "talks" (opens with the spoken-audio amplitude). The video
  // already carries the iridescence + blinking eyes; these add the rest of the
  const globe = el("div", { class: "voice-globe", "aria-hidden": "true" }, [
    globeVideo,
  ]);
  const statusText = el("div", { class: "voice-status", "aria-live": "polite", text: "Start talking" });
  const transcriptText = el("div", { class: "voice-transcript" });

  const typeInput = el("input", {
    class: "voice-type",
    type: "text",
    placeholder: "Type",
    "aria-label": "Type a message",
    onkeydown: (e) => { if (e.key === "Enter") submitTyped(); },
  });

  // Language selector button along the text bar (cycles sequentially on click)
  const langLabelEl = el("span", { class: "voice-lang-code", text: getLangConfig().label });

  function cycleLanguage() {
    const idx = VOICE_LANGUAGES.findIndex((l) => l.id === currentLangId);
    const next = VOICE_LANGUAGES[(idx + 1) % VOICE_LANGUAGES.length];
    selectLanguage(next.id);
  }

  function selectLanguage(id) {
    if (currentLangId === id) return;
    currentLangId = id;
    try { localStorage.setItem("bimo-voice-lang", id); } catch {}
    const conf = getLangConfig();
    langLabelEl.textContent = conf.label;
    langBtn.setAttribute("aria-label", `Language: ${conf.label} (click to change)`);

    // Reconnect TTS WebSocket for new language model
    if (ttsWS) {
      try { ttsWS.close(); } catch {}
      ttsWS = null;
    }
    ensureTTSWS();

    // Update speech recognition language if Web Speech is active
    if (recognition) {
      try {
        recognition.lang = conf.recLang;
        if (speechRecSupported && !isBraveBrowser && state === "listening") {
          stopRecognition();
          startSpeechRecognition();
        }
      } catch (err) {
        console.warn("[bimo-voice] recognition lang update error:", err);
      }
    }
  }

  const langBtn = el("button", {
    class: "voice-lang-btn",
    type: "button",
    "aria-label": `Language: ${getLangConfig().label} (click to change)`,
    title: "Click to change language",
    onmousedown: (e) => {
      e.preventDefault();
      e.stopPropagation();
      cycleLanguage();
    },
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
    },
  }, [langLabelEl]);

  const langWrap = el("div", { class: "voice-lang-wrap" }, [langBtn]);

  const micBtn = el("button", {
    class: "voice-mic", type: "button", "aria-label": "Microphone", title: "Talk",
    onclick: onMicTap, html: icon("mic", { width: 22, height: 22 }),
  });
  const closeBtn = el("button", {
    class: "voice-close", type: "button", "aria-label": "Close voice", title: "Close",
    onclick: () => close(), html: icon("x", { width: 22, height: 22 }),
  });

  const overlay = el("div", {
    class: "voice-overlay", role: "dialog", "aria-modal": "true", "aria-label": "Bmo Voice",
  }, [
    el("header", { class: "voice-header" }, [
      el("span", { class: "voice-title" }, [el("strong", { text: "Bmo" }), el("span", { text: " Voice" })]),
    ]),
    el("div", { class: "voice-stage" }, [globe, statusText, transcriptText]),
    el("div", { class: "voice-bar" }, [
      el("div", { class: "voice-input-wrap" }, [typeInput]),
      langWrap,
      micBtn,
      closeBtn,
    ]),
  ]);

  document.body.append(overlay);
  document.body.classList.add("voice-open");
  requestAnimationFrame(() => overlay.classList.add("open"));
  // Autoplay is muted; nudge play() inside the opening gesture for browsers
  // that need it. Honor reduced-motion by holding a single still frame.
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    globeVideo.autoplay = false;
    globeVideo.removeAttribute("autoplay");
    const hold = () => { try { globeVideo.pause(); globeVideo.currentTime = 0.5; } catch { /* ignore */ } };
    if (globeVideo.readyState >= 2) hold();
    else globeVideo.addEventListener("loadeddata", hold, { once: true });
  } else {
    globeVideo.play?.().catch(() => {});
  }

  // Create + unlock the AudioContext now, while we're still inside the click
  // gesture that opened the overlay, so later TTS playback isn't blocked by
  // the browser autoplay policy.
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      audioCtx = new Ctx();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    }
  } catch { /* no audio context — TTS will be skipped */ }

  // Warn once if the server has no TTS configured so silence isn't mysterious.
  api.health().then((h) => {
    if (!active || h?.tts !== "unconfigured") return;
    toast("Speech not configured", { tone: "warning" });
  }).catch(() => {});

  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  // ---------- state ----------
  function setState(next, label) {
    state = next;
    overlay.dataset.state = next;
    globe.className = `voice-globe ${next}`;
    if (label != null) statusText.textContent = label;
  }
  function setTranscript(t) {
    transcriptText.textContent = t || "";
    transcriptText.scrollTop = transcriptText.scrollHeight;
  }

  // ---------- listening ----------
  function startListening() {
    if (!active || turnInFlight || state === "speaking" || activeSpeech || ttsSource) return;
    setTranscript("");
    setState("listening", "Listening…");
    micBtn.classList.add("active");
    if (speechRecSupported && !isBraveBrowser) {
      startSpeechRecognition();
    } else {
      startRecorder();
    }
  }

  let speechSilenceTimer = null;

  function dedupeWordsAndPhrases(str) {
    if (!str) return "";
    // 1. Split into words and eliminate immediate single-word stutter ("I I" -> "I")
    const words = str.trim().split(/\s+/);
    const uniqueWords = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const cleanW = w.toLowerCase().replace(/[^a-z0-9]/gi, "");
      const prevClean = uniqueWords.length ? uniqueWords[uniqueWords.length - 1].toLowerCase().replace(/[^a-z0-9]/gi, "") : "";
      if (cleanW && cleanW === prevClean) continue;
      uniqueWords.push(w);
    }

    let cleaned = uniqueWords.join(" ");

    // 2. Eliminate immediate multi-word phrase stutter ("I said tomorrow I said tomorrow" -> "I said tomorrow")
    for (let n = 6; n >= 2; n--) {
      const wList = cleaned.split(/\s+/);
      if (wList.length < n * 2) continue;
      for (let i = 0; i <= wList.length - n * 2; i++) {
        const p1 = wList.slice(i, i + n).join(" ").toLowerCase().replace(/[^a-z0-9 ]/gi, "");
        const p2 = wList.slice(i + n, i + n * 2).join(" ").toLowerCase().replace(/[^a-z0-9 ]/gi, "");
        if (p1 && p1 === p2) {
          wList.splice(i + n, n);
          cleaned = wList.join(" ");
          i--;
        }
      }
    }
    return cleaned.replace(/\s+/g, " ").trim();
  }

  function extractCleanTranscript(results) {
    if (!results || !results.length) return "";
    
    // On Android Chrome, the last item in results frequently contains the full progressive sentence.
    const lastItem = results[results.length - 1];
    const lastText = (lastItem && lastItem[0] && lastItem[0].transcript || "").trim();

    // Check if results are progressive snapshots of the same sentence
    let isProgressive = false;
    if (results.length > 1 && lastText) {
      const firstText = (results[0] && results[0][0] && results[0][0].transcript || "").trim();
      if (firstText && lastText.toLowerCase().startsWith(firstText.toLowerCase().slice(0, Math.min(10, firstText.length)))) {
        isProgressive = true;
      }
    }

    if (isProgressive && lastText) {
      return dedupeWordsAndPhrases(lastText);
    }

    // Standard / Desktop Chrome: distinct chunk assembly
    const parts = [];
    for (let i = 0; i < results.length; i++) {
      const item = results[i];
      if (!item || !item[0]) continue;
      const text = (item[0].transcript || "").trim();
      if (!text) continue;

      const lowerText = text.toLowerCase().replace(/[^a-z0-9 ]/gi, "");
      const prevText = parts.length ? parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9 ]/gi, "") : "";

      if (parts.length && lowerText.startsWith(prevText)) {
        parts[parts.length - 1] = text;
      } else if (parts.length && prevText.startsWith(lowerText)) {
        // keep existing
      } else {
        parts.push(text);
      }
    }
    return dedupeWordsAndPhrases(parts.join(" "));
  }

  function startSpeechRecognition() {
    stopRecognition();
    try {
      recognition = new SpeechRec();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.lang = getLangConfig().recLang;

      let lastRecognizedText = "";

      recognition.onstart = () => {
        if (!active) { try { recognition.stop(); } catch {} return; }
        setState("listening", "Listening… speak now");
      };

      recognition.onresult = (event) => {
        if (!active || turnInFlight) return;
        const currentText = extractCleanTranscript(event.results);
        if (currentText) {
          lastRecognizedText = currentText;
          setTranscript(currentText);
          if (speechSilenceTimer) clearTimeout(speechSilenceTimer);
          speechSilenceTimer = setTimeout(() => {
            if (active && !turnInFlight && lastRecognizedText) {
              const textToSend = lastRecognizedText;
              lastRecognizedText = "";
              stopRecognition();
              endTurn(textToSend);
            }
          }, 2000); // exactly 2.0s of silence gives user natural time to pause and think
        }
      };

      recognition.onerror = (event) => {
        console.warn("[bimo-voice] Web Speech error:", event?.error);
        if (event?.error !== "no-speech") {
          speechRecSupported = false;
          stopRecognition();
          startRecorder();
        }
      };

      let emptyEndCount = 0;
      recognition.onend = () => {
        if (active && state === "listening" && !turnInFlight) {
          // If the 2-second silence timer is running, the user just paused to think — do NOT cut them off
          if (speechSilenceTimer) {
            try {
              recognition.start();
            } catch {}
            return;
          }

          const text = lastRecognizedText.trim();
          if (text) {
            lastRecognizedText = "";
            emptyEndCount = 0;
            stopRecognition();
            endTurn(text);
          } else {
            emptyEndCount++;
            if (emptyEndCount >= 3) {
              console.warn("[bimo-voice] Web Speech ended repeatedly without results, falling back to MediaRecorder");
              speechRecSupported = false;
              stopRecognition();
              startRecorder();
              return;
            }
            try {
              recognition.start();
            } catch {
              speechRecSupported = false;
              startRecorder();
            }
          }
        }
      };

      recognition.start();
    } catch (err) {
      console.warn("[bimo-voice] Web Speech init failed, using MediaRecorder fallback:", err);
      speechRecSupported = false;
      startRecorder();
    }
  }

  function stopRecognition() {
    if (speechSilenceTimer) {
      clearTimeout(speechSilenceTimer);
      speechSilenceTimer = null;
    }
    if (recognition) {
      try {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition.stop();
      } catch {}
      recognition = null;
    }
    stopVAD();
  }

  // ---------- listening fallback (record -> /transcribe, auto-stop on silence) ----------
  async function startRecorder() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setState("idle", "Voice input isn't supported here — type instead");
      micBtn.classList.remove("active");
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
    } catch {
      toast("Mic denied", { tone: "error" });
      micBtn.classList.remove("active");
      setState("idle", "Tap the mic to talk");
      return;
    }
    audioChunks = [];
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    mediaRecorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
    mediaRecorder.addEventListener("dataavailable", (e) => { if (e.data.size) audioChunks.push(e.data); });
    mediaRecorder.addEventListener("stop", onRecorderStop);
    mediaRecorder.start();
    recordStartedAt = performance.now();
    setState("listening", "Listening… speak, then pause to send");

    // Adaptive VAD: auto-stop when the user stops speaking (tuning at top).
    vadHadSpeech = false;
    discardTake = false;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const vadCtx = audioCtx || new Ctx();
      vadSource = vadCtx.createMediaStreamSource(mediaStream);
      vadAnalyser = vadCtx.createAnalyser();
      vadAnalyser.fftSize = 512;
      vadAnalyser.smoothingTimeConstant = 0.2;
      vadSource.connect(vadAnalyser);
      const bins = new Uint8Array(vadAnalyser.frequencyBinCount);
      // Voice band ≈ 200–3500 Hz: ignores low rumble (handling, wind, mains
      // hum) and high hiss, so the level tracks the voice, not the room.
      const hzPerBin = vadCtx.sampleRate / vadAnalyser.fftSize;
      const loBin = Math.max(1, Math.round(200 / hzPerBin));
      const hiBin = Math.min(bins.length - 1, Math.round(3500 / hzPerBin));

      const startedAt = performance.now();
      let noiseFloor = 0;
      let loudFrames = 0;
      let speaking = false;
      let silenceStart = 0;
      let lastLogAt = 0;

      const tickVAD = () => {
        if (!active || state !== "listening" || !mediaRecorder || mediaRecorder.state === "inactive") {
          stopVAD();
          return;
        }
        vadAnalyser.getByteFrequencyData(bins);
        let sum = 0;
        for (let i = loBin; i <= hiBin; i++) sum += bins[i];
        const level = sum / (hiBin - loBin + 1) / 255;
        const now = performance.now();
        const elapsed = now - startedAt;

        // Asymmetric noise-floor tracker: drops quickly when the input gets
        // quieter (gaps between words pull it to the true room level) and
        // rises only slowly, so sustained speech can't drag the floor up and
        // mask itself.
        if (!noiseFloor) noiseFloor = level;
        else if (level < noiseFloor) noiseFloor = noiseFloor * 0.7 + level * 0.3;
        else noiseFloor = noiseFloor * 0.995 + level * 0.005;

        // Let the tracker settle on the room before judging anything (also
        // swallows the mic-activation pop).
        if (elapsed <= VAD_CALIBRATE_MS) {
          vadRaf = requestAnimationFrame(tickVAD);
          return;
        }

        const enterAt = Math.max(noiseFloor * VAD_ENTER_FACTOR, VAD_MIN_LEVEL);
        const exitAt = Math.max(noiseFloor * VAD_EXIT_FACTOR, VAD_MIN_LEVEL * 0.7);

        // Throttled diagnostics
        if (now - lastLogAt > 500) {
          lastLogAt = now;
          console.log(
            `[bimo-voice] VAD level=${level.toFixed(3)} floor=${noiseFloor.toFixed(3)} ` +
            `enter=${enterAt.toFixed(3)} speak=${speaking}`
          );
        }

        if (!speaking) {
          if (level >= enterAt) {
            loudFrames += 1;
            if (loudFrames >= VAD_ENTER_FRAMES) {
              speaking = true;
              vadHadSpeech = true;
              loudFrames = 0;
              silenceStart = 0;
            }
          } else {
            loudFrames = 0;
            if (elapsed >= VAD_NO_SPEECH_MS) {
              stopRecorder();
              return;
            }
          }
        } else if (level <= exitAt) {
          if (!silenceStart) silenceStart = now;
          else if (now - silenceStart >= VAD_SILENCE_MS) {
            stopRecorder();
            return;
          }
        } else {
          silenceStart = 0;
        }

        if (elapsed >= VAD_MAX_TURN_MS) {
          stopRecorder();
          return;
        }
        vadRaf = requestAnimationFrame(tickVAD);
      };
      vadRaf = requestAnimationFrame(tickVAD);
    } catch (err) {
      console.warn("[bimo-voice] VAD init failed:", err);
      // No detector → the user stops manually with a mic tap; that take must
      // still be transcribed, so don't let the no-speech skip kick in.
      vadHadSpeech = true;
    }
  }

  function stopVAD() {
    if (vadRaf) { cancelAnimationFrame(vadRaf); vadRaf = null; }
    if (vadSource) { try { vadSource.disconnect(); } catch { /* ignore */ } vadSource = null; }
    vadAnalyser = null;
  }

  function stopRecorder() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try { mediaRecorder.stop(); } catch { /* ignore */ }
    }
  }

  async function onRecorderStop() {
    if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
    const recorder = mediaRecorder;
    mediaRecorder = null;
    if (!active) return;
    micBtn.classList.remove("active");
    // A typed turn superseded this take — drop the audio without touching the
    // UI state (endTurn owns it now).
    if (discardTake) {
      discardTake = false;
      audioChunks = [];
      return;
    }
    // The local VAD is ADVISORY, not a hard gate. Transcribe whenever the take
    // has real audio (>= MIN_TRANSCRIBE_MS), even if the VAD never confirmed
    // speech — a far laptop mic the VAD under-read still gets heard, and Riva
    // returns "" for genuine silence (a friendly "Didn't catch that", not a
    // dropped turn). Only a truly empty or sub-0.6s misfire (mic-open pop,
    // instant stop) is discarded.
    const MIN_TRANSCRIBE_MS = 600;
    const took = recordStartedAt ? performance.now() - recordStartedAt : 0;
    recordStartedAt = 0;
    if (!audioChunks.length || took < MIN_TRANSCRIBE_MS) {
      audioChunks = [];
      setState("idle", vadHadSpeech ? "Tap the mic to talk" : "Didn't hear anything — tap the mic to talk");
      return;
    }
    setState("thinking", "Transcribing…");
    try {
      const blob = new Blob(audioChunks, { type: recorder?.mimeType || "audio/webm" });
      let wav;
      try { wav = await blobToWav16kMono(blob); } catch { wav = blob; }
      const res = await api.transcribeAudio(token, wav, { language: currentLangId });
      const t = (res?.text || "").trim();
      if (t) endTurn(t);
      else setState("idle", "Didn't catch that — tap the mic");
    } catch (err) {
      toast(err.message || "Transcription failed", { tone: "error" });
      setState("idle", "Tap the mic to talk");
    }
  }

  // ---------- turn ----------
  async function endTurn(text) {
    if (turnInFlight || !active) return;
    console.log("[bimo-voice] endTurn:", text.slice(0, 60));
    turnInFlight = true;
    micBtn.classList.remove("active");
    stopRecognition();
    stopRecorder();
    setTranscript(text);
    setState("thinking", voiceWaitPhrase());

    const speech = audioCtx ? createDeepgramTTSStream() : null;
    activeSpeech = speech;

    let reply = "";
    try {
      const activeLang = getLangConfig();
      reply = (await sendTurn(text, {
        language: activeLang.id,
        languageName: activeLang.label,
        onDelta: speech ? (soFar) => speech.pushText(soFar) : undefined,
      })) || "";

      if (!active) { speech?.cancel(); return; }
      setTranscript("");

      if (!reply || !audioCtx) {
        speech?.cancel();
        if (activeSpeech === speech) activeSpeech = null;
        afterSpeaking();
        return;
      }

      if (speech) {
        speech.finish(reply);
        // Generous safety cap so speech is never prematurely cut off mid-sentence
        await Promise.race([
          speech.done(),
          new Promise((resolve) => setTimeout(resolve, 45000)),
        ]);
        if (activeSpeech === speech) activeSpeech = null;
        if (!active || speech.cancelled) return;
        afterSpeaking();
        return;
      }

      if (!active) return;
      afterSpeaking();
    } catch (err) {
      console.warn("[bimo-voice] sendTurn failed:", err?.message);
      toast(err?.message || "Couldn't connect", { tone: "error" });
      speech?.cancel();
      if (activeSpeech === speech) activeSpeech = null;
      afterSpeaking();
    } finally {
      turnInFlight = false;
    }
  }

  function afterSpeaking() {
    stopBargeInDetector();
    if (!active) return;
    turnInFlight = false;
    activeSpeech = null;
    ttsSource = null;
    setState("idle", "");
    setTimeout(() => {
      if (active && !turnInFlight && !activeSpeech && state !== "speaking") {
        startListening();
      }
    }, TTS_COOLDOWN_MS);
  }

  // ---------- speaking (streaming Deepgram Flux via Web Audio) ----------
  function createDeepgramTTSStream() {
    let cancelled = false;
    let offset = 0;
    let finished = false;
    let flushSent = false;
    let flushReceived = false;
    let hasReceivedAudio = false;
    let wsClosed = false;
    let nextPlayTime = 0;
    let finishTimer = null;
    let hasSentFirstChunk = false;
    const queuedSources = [];
    const pendingTextQueue = [];
    let resolveDone;
    const donePromise = new Promise((r) => { resolveDone = r; });

    const ws = ensureTTSWS();

    function checkDone() {
      if (cancelled) return;
      const audioStillPlaying = queuedSources.length > 0 || (audioCtx && nextPlayTime > 0 && audioCtx.currentTime < nextPlayTime);

      if (finished) {
        if (!audioStillPlaying) {
          // If all audio playback has finished through the speakers:
          if (flushReceived || wsClosed) {
            if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
            stopMeter();
            ttsSource = null;
            resolveDone();
            return;
          }

          if (!finishTimer) {
            finishTimer = setTimeout(() => {
              if (!cancelled) {
                stopMeter();
                ttsSource = null;
                resolveDone();
              }
            }, 1200);
          }
        } else if (queuedSources.length === 0 && audioCtx && nextPlayTime > 0 && audioCtx.currentTime < nextPlayTime) {
          const waitMs = Math.max(20, Math.ceil((nextPlayTime - audioCtx.currentTime) * 1000) + 30);
          setTimeout(() => { if (!cancelled) checkDone(); }, waitMs);
        }
      }
    }

    if (ws) {
      ws.onopen = () => {
        if (cancelled) return;
        while (pendingTextQueue.length) {
          const chunk = pendingTextQueue.shift();
          try { ws.send(JSON.stringify({ type: "Speak", text: chunk })); } catch {}
        }
        if (finished && !flushSent) {
          flushSent = true;
          try { ws.send(JSON.stringify({ type: "Flush" })); } catch {}
        }
      };

      ws.onmessage = (event) => {
        if (cancelled || !active) return;
        if (typeof event.data === "string") {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "Flushed" || data.type === "SpeechMetadata") {
              flushReceived = true;
              checkDone();
            } else if (data.type === "Warning" && (data.code === "NO_ACTIVE_SPEECH" || data.code === "NO_SYNTHESIZABLE_TEXT")) {
              flushReceived = true;
              checkDone();
            } else if (data.type === "Error") {
              console.warn("[bimo-voice] Deepgram streaming status:", data.message);
              if (!hasReceivedAudio) {
                wsClosed = true;
                checkDone();
              }
            }
          } catch {}
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          const raw = event.data;
          if (!raw.byteLength) return;
          const int16 = new Int16Array(raw);
          const sampleRate = 24000;
          const audioBuffer = audioCtx.createBuffer(1, int16.length, sampleRate);
          const channel = audioBuffer.getChannelData(0);
          for (let i = 0; i < int16.length; i++) {
            channel[i] = int16[i] / 32768.0;
          }
          queueAudioBuffer(audioBuffer);
        }
      };

      ws.onerror = (err) => {
        console.warn("[bimo-voice] Deepgram WS error:", err);
      };

      ws.onclose = () => {
        if (ttsWS === ws) ttsWS = null;
        wsClosed = true;
        checkDone();
      };
    }

    function queueAudioBuffer(audioBuffer) {
      if (cancelled || !active || !audioCtx) return;
      if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      if (state !== "speaking") {
        stopRecognition();
        stopRecorder();
        micBtn.classList.remove("active");
        setState("speaking", "Speaking…");
        startBargeInDetector();
      }

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      ttsSource = source;
      driveGlobe(analyser);

      const now = audioCtx.currentTime;
      // Start immediately with minimum jitter buffer (10ms)
      const startTime = Math.max(now + 0.010, nextPlayTime);
      source.start(startTime);
      nextPlayTime = startTime + audioBuffer.duration;

      hasReceivedAudio = true;
      queuedSources.push(source);
      source.onended = () => {
        const idx = queuedSources.indexOf(source);
        if (idx !== -1) queuedSources.splice(idx, 1);
        if (queuedSources.length === 0) {
          stopMeter();
          ttsSource = null;
        }
        checkDone();
      };
    }

    function sendChunk(rawText) {
      const isStart = !hasSentFirstChunk;
      const clean = stripForSpeech(rawText, isStart);
      // Skip chunks with no actual spoken words (prevents sending orphan dots or bare punctuation)
      if (!clean || !clean.replace(/[\s.,;:!?…-]/g, "")) return;
      hasSentFirstChunk = true;
      // Ensure words do not get glued together across WebSocket Speak chunks
      const textToSend = clean.endsWith(" ") ? clean : `${clean} `;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "Speak", text: textToSend }));
        } catch (err) {
          console.warn("[bimo-voice] Deepgram send failed:", err);
        }
      } else if (ws && ws.readyState === WebSocket.CONNECTING) {
        pendingTextQueue.push(textToSend);
      }
    }

    function pushText(soFar) {
      if (cancelled || typeof soFar !== "string") return;
      const pending = soFar.slice(offset);
      if (!pending) return;

      // Stream full clauses when punctuation appears for natural spoken prosody and cadence.
      // Match punctuation without splitting in the middle of consecutive dots (e.g. ..., ..)
      const match = pending.match(/([,;:!?\n]|\.+)/);
      if (match && match.index != null) {
        const endIdx = match.index + match[0].length;
        const toSend = pending.slice(0, endIdx);
        offset += endIdx;
        sendChunk(toSend);
        return;
      }

      // If no punctuation yet, stream at the last word boundary once we have a comfortable phrase (>= 24 chars)
      if (pending.length >= 24) {
        const lastSpace = pending.lastIndexOf(" ");
        if (lastSpace > 0) {
          const toSend = pending.slice(0, lastSpace + 1);
          offset += lastSpace + 1;
          sendChunk(toSend);
        }
      }
    }

    function finish(finalText) {
      if (cancelled) { resolveDone(); return; }
      if (typeof finalText === "string" && finalText.length > offset) {
        const remaining = finalText.slice(offset);
        offset = finalText.length;
        sendChunk(remaining);
      }
      finished = true;

      if (ws && ws.readyState === WebSocket.OPEN) {
        flushSent = true;
        try { ws.send(JSON.stringify({ type: "Flush" })); } catch {}
      }
      checkDone();
    }

    function cancel() {
      if (cancelled) return;
      cancelled = true;
      if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
      pendingTextQueue.length = 0;
      for (const s of queuedSources) {
        try { s.onended = null; s.stop(); } catch {}
      }
      queuedSources.length = 0;
      nextPlayTime = 0;
      stopMeter();
      ttsSource = null;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "Interrupt" }));
        } catch {}
      }
      resolveDone();
    }

    return {
      pushText,
      finish,
      cancel,
      done: () => donePromise,
      hasAudio: () => hasReceivedAudio,
      get cancelled() { return cancelled; },
    };
  }

  // ---------- speaking (TTS via Web Audio) ----------
  // Synthesize and play the full generated reply as a single seamless audio clip,
  // preventing any pauses or delays mid-speech.
  function speakFullText(textToSpeak) {
    let cancelled = false;
    let resolveDone;
    const donePromise = new Promise((r) => { resolveDone = r; });

    const handle = {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        resolveDone();
      },
      done: () => donePromise,
      get cancelled() { return cancelled; },
    };

    activeSpeech = handle;

    (async () => {
      try {
        const activeLang = getLangConfig();
        const bytes = await api.synthesizeSpeech(token, textToSpeak, { voice: activeLang.model, language: activeLang.id });
        if (cancelled || !active) { resolveDone(); return; }

        if (audioCtx.state === "suspended") {
          await audioCtx.resume().catch(() => {});
        }
        if (cancelled || !active) { resolveDone(); return; }

        const decoded = await audioCtx.decodeAudioData(bytes);
        if (cancelled || !active) { resolveDone(); return; }

        setState("speaking", "Speaking…");
        startBargeInDetector();
        const source = audioCtx.createBufferSource();
        source.buffer = decoded;
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyser.connect(audioCtx.destination);
        ttsSource = source;
        driveGlobe(analyser);

        source.onended = () => {
          stopMeter();
          ttsSource = null;
          resolveDone();
        };
        source.start();
      } catch (err) {
        if (!cancelled && active) {
          console.warn("[bimo-voice] TTS failed:", err?.message);
          toast(err?.message || "Speech failed", { tone: "error" });
        }
        resolveDone();
      } finally {
        if (activeSpeech === handle) activeSpeech = null;
      }
    })();

    return handle.done();
  }

  function driveGlobe(analyser) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length / 255; // 0..1
      globe.style.setProperty("--amp", String(1 + Math.min(0.24, avg * 0.45)));
      meterRaf = requestAnimationFrame(tick);
    };
    meterRaf = requestAnimationFrame(tick);
  }

  function stopMeter() {
    if (meterRaf) { cancelAnimationFrame(meterRaf); meterRaf = null; }
    globe.style.removeProperty("--amp");
  }

  // ---------- barge-in interruption listener (full-duplex voice) ----------
  let bargeInStream = null;
  let bargeInSource = null;
  let bargeInAnalyser = null;
  let bargeInRaf = null;
  let bargeInRecognition = null;

  function stopBargeInDetector() {
    if (bargeInRaf) {
      cancelAnimationFrame(bargeInRaf);
      bargeInRaf = null;
    }
    if (bargeInSource) {
      try { bargeInSource.disconnect(); } catch {}
      bargeInSource = null;
    }
    bargeInAnalyser = null;
    if (bargeInStream) {
      try { bargeInStream.getTracks().forEach((t) => t.stop()); } catch {}
      bargeInStream = null;
    }
    if (bargeInRecognition) {
      try {
        bargeInRecognition.onresult = null;
        bargeInRecognition.onspeechstart = null;
        bargeInRecognition.onerror = null;
        bargeInRecognition.stop();
      } catch {}
      bargeInRecognition = null;
    }
  }

  function bargeIn(initialTranscript = "") {
    if (!active || (state !== "speaking" && !activeSpeech && !turnInFlight)) return;
    console.info("[bimo-voice] Barge-in triggered: interrupting speech to listen to user");
    stopBargeInDetector();
    stopSpeaking();
    if (initialTranscript) {
      setTranscript(initialTranscript);
    }
    startListening();
  }

  async function startBargeInDetector() {
    if (!active || state !== "speaking") return;
    stopBargeInDetector();

    // Mode 1: Web Speech Recognition barge-in
    if (speechRecSupported && !isBraveBrowser) {
      try {
        bargeInRecognition = new SpeechRec();
        bargeInRecognition.continuous = true;
        bargeInRecognition.interimResults = true;
        bargeInRecognition.maxAlternatives = 1;
        bargeInRecognition.lang = getLangConfig().recLang;

        bargeInRecognition.onresult = (event) => {
          if (!active || state !== "speaking") return;
          const text = extractCleanTranscript(event.results);
          if (text && text.trim().length > 1) {
            bargeIn(text);
          }
        };

        bargeInRecognition.onspeechstart = () => {
          if (!active || state !== "speaking") return;
          setTimeout(() => {
            if (active && state === "speaking") bargeIn();
          }, 180);
        };

        bargeInRecognition.onerror = () => {
          startVADBargeIn();
        };

        bargeInRecognition.start();
        return;
      } catch {
        // Fallback to VAD below
      }
    }

    startVADBargeIn();
  }

  async function startVADBargeIn() {
    if (!active || state !== "speaking") return;
    if (!navigator.mediaDevices?.getUserMedia) return;

    try {
      bargeInStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
    } catch {
      return;
    }

    if (!active || state !== "speaking") {
      stopBargeInDetector();
      return;
    }

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const vadCtx = audioCtx || new Ctx();
      bargeInSource = vadCtx.createMediaStreamSource(bargeInStream);
      bargeInAnalyser = vadCtx.createAnalyser();
      bargeInAnalyser.fftSize = 512;
      bargeInAnalyser.smoothingTimeConstant = 0.2;
      bargeInSource.connect(bargeInAnalyser);
      const bins = new Uint8Array(bargeInAnalyser.frequencyBinCount);
      const hzPerBin = vadCtx.sampleRate / bargeInAnalyser.fftSize;
      const loBin = Math.max(1, Math.round(200 / hzPerBin));
      const hiBin = Math.min(bins.length - 1, Math.round(3500 / hzPerBin));

      let loudTicks = 0;
      let noiseFloor = 0;
      const startedAt = performance.now();

      const tick = () => {
        if (!active || state !== "speaking") {
          stopBargeInDetector();
          return;
        }
        bargeInAnalyser.getByteFrequencyData(bins);
        let sum = 0;
        for (let i = loBin; i <= hiBin; i++) sum += bins[i];
        const level = sum / (hiBin - loBin + 1) / 255;
        const now = performance.now();

        if (!noiseFloor) noiseFloor = level;
        else if (level < noiseFloor) noiseFloor = noiseFloor * 0.7 + level * 0.3;
        else noiseFloor = noiseFloor * 0.995 + level * 0.005;

        // Give 350ms grace to ignore initial speaker activation pop
        if (now - startedAt > 350) {
          const threshold = Math.max(noiseFloor * 2.2, 0.015);
          if (level >= threshold) {
            loudTicks++;
            if (loudTicks >= 3) {
              bargeIn();
              return;
            }
          } else {
            loudTicks = 0;
          }
        }
        bargeInRaf = requestAnimationFrame(tick);
      };
      bargeInRaf = requestAnimationFrame(tick);
    } catch {
      stopBargeInDetector();
    }
  }

  function stopSpeaking() {
    stopBargeInDetector();
    if (activeSpeech) {
      try { activeSpeech.cancel(); } catch {}
      activeSpeech = null;
    }
    stopMeter();
    if (ttsSource) {
      try { ttsSource.onended = null; ttsSource.stop(); } catch { /* ignore */ }
      ttsSource = null;
    }
    turnInFlight = false;
    setState("idle", "");
  }

  // ---------- controls ----------
  function onMicTap() {
    if (!active) return;
    if (state === "speaking" || activeSpeech || turnInFlight) {
      stopSpeaking();
      startListening();
      return;
    }
    if (state === "listening") {
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        // Manual tap = "send what I said now". Force the transcription even
        // if the detector hadn't confirmed speech yet (very soft talkers),
        // so a deliberate send is never discarded as "no speech".
        vadHadSpeech = true;
        stopRecorder();
      } else {
        micBtn.classList.remove("active");
        setState("idle", "Tap the mic to talk");
      }
      return;
    }
    startListening();
  }

  async function submitTyped() {
    const t = typeInput.value.trim();
    if (!t || turnInFlight) return;
    typeInput.value = "";
    stopRecognition();
    stopSpeaking();
    // If the mic was live, release it and discard that take — otherwise the
    // recorder keeps the mic hot through the whole typed turn and its stale
    // audio collides with the next listening round.
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      discardTake = true;
      stopRecorder();
    }
    await endTurn(t);
  }

  function close() {
    if (!active) return;
    active = false;
    document.removeEventListener("keydown", onKey);
    stopBargeInDetector();
    stopRecognition();
    stopRecorder();
    stopSpeaking();
    stopVAD();
    if (ttsWS) {
      try { ttsWS.send(JSON.stringify({ type: "Close" })); } catch {}
      try { ttsWS.close(); } catch {}
      ttsWS = null;
    }
    if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch { /* ignore */ } audioCtx = null; }
    document.body.classList.remove("voice-open");
    overlay.classList.remove("open");
    setTimeout(() => overlay.remove(), 220);
    if (typeof onClose === "function") onClose();
  }

  // Begin listening once the open animation has settled.
  setTimeout(() => { if (active) startListening(); }, 350);

  return { close };
}
