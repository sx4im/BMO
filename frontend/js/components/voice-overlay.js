// Full-screen Bmo voice call.
//
// Flow: open -> listen (live transcription) -> completed thought -> send ->
// voice-themed wait text while the reply streams -> read the reply aloud
// (Deepgram Flux/Aura streaming) -> listen again. The X closes it. A procedural
// fog sphere follows the voice state and the microphone/playback audio envelopes.
//
// Speech input uses Deepgram Nova-3 streaming and recorded-audio recovery. Semantic
// checks can finish a turn early. Adaptive Web Audio VAD also sends after a
// quiet pause, even when a completion verdict is missing or incorrect.
//
// Text-to-speech audio is decoded and played through the Web Audio API rather
// than an <audio> element: that keeps it inside the site CSP (the fetch is a
// normal API call) and lets an AnalyserNode drive the globe animation.

import { el } from "../utils.js?v=52";
import { icon } from "../icons.js?v=77";
import { toast } from "./toast.js?v=59";
import * as api from "../api.js?v=75";
import { LiveTranscriber } from "../chat/live-transcriber.js?v=8";
import { getRandomPhrase } from "../chat/waiting-phrases.js?v=2";
import { SemanticTurnDetector } from "../chat/turn-detector.js?v=2";
import { VOICE_LANGUAGES, normalizeVoiceLanguage } from "./voice-languages.js?v=3";
import { getVoiceAcknowledgment } from "./voice-acknowledgments.js?v=2";
export { VOICE_LANGUAGES };
import { createVoiceOrb } from "./voice-orb.js?v=5";
import { createAudioMeter } from "./voice-audio-meter.js?v=4";
import { blobToWav16kMono } from "../audio-wav.js?v=31";

// ---------- voice-activity detection (VAD) tuning ----------
// The mic may be at arm's length (laptop) OR close to the mouth (phone), so the
// signal level varies a lot. The detector tracks waveform RMS relative to the
// room's noise floor, dropping fast in quiet gaps and learning upward only
// before speech starts. This accounts for steady background noise — fan,
// traffic, café chatter — without using an absolute silence gate. The turn
// auto-ends after a quiet pause once the user has spoken.
//
// IMPORTANT: capture runs with autoGainControl OFF (see startRecorder). AGC
// inflates the silent-gap noise floor toward the speech level, which shrinks
// the speech-to-noise ratio this RELATIVE gate depends on — that's why a far
// laptop mic kept reading as "no speech" while a close phone mic worked. The
// VAD is also no longer a hard gate: a take that has audio is transcribed even
// if the VAD missed it (see onRecorderStop), so these thresholds only affect
// HOW PROMPTLY a turn auto-ends, never whether speech is heard at all.
const VAD_CALIBRATE_MS = 200;    // settle on the room level before judging speech
const VAD_ENTER_FACTOR = 2.0;    // speech: level > floor * 2.0 (and > MIN)
const VAD_EXIT_FACTOR  = 1.4;    // silence again below floor * 1.4 (hysteresis)
const VAD_MIN_LEVEL    = 0.005;  // absolute gate so dead-quiet rooms don't fire on hiss
const VAD_ENTER_FRAMES = 2;      // ~2 consecutive loud frames (~35 ms) to confirm speech
const SEMANTIC_QUIET_MS = 650;   // let a natural pause pass before checking completion
const VAD_SILENCE_MS   = 1800;   // fallback when a completion verdict is missing or negative
const MIN_RECORDING_MS = 350;   // ignore accidental taps on the recorded fallback
const VAD_HIGHPASS_HZ  = 85;    // filter low room rumble for detection only
const VAD_IDLE_ROTATE_MS = 60000; // renew silent backup recordings without ending the call
const VAD_MAX_TURN_MS  = 5 * 60 * 1000;  // hard safety cap per turn

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
function stripForSpeech(md = "", isStartOfTurn = false, language = "en") {
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
    .replace(/[ \t\r\n]+/g, " ")
    .replace(/\bBmo\b/gi, language === "en" ? "Bee Em Oh" : "B M O");
  return language === "en" ? expandYearsForSpeech(cleaned) : cleaned;
}

export function voiceDelivery(tone = "neutral") {
  // Flux expression is a per-connection beta; keep register shifts restrained.
  if (tone === "gentle") return { speed: 1, expressivity: -1 };
  if (tone === "lively") return { speed: 1.1, expressivity: 1 };
  return { speed: 1.05, expressivity: 0 };
}

/**
 * @param {object} ctx
 * @param {string} ctx.token - Supabase access token for API calls.
 * @param {(text:string)=>Promise<string>} ctx.sendTurn - sends a user turn and
 *        resolves with the assistant's reply text.
 * @param {()=>void} [ctx.onClose] - called when the overlay closes.
 * @returns {{ close: ()=>void }}
 */
export function openVoiceOverlay({ token, sendTurn, onClose, onInterrupt } = {}) {
  let active = true;
  let state = "idle";
  let turnInFlight = false;
  let turnSequence = 0;
  let currentTone = "neutral";

  let mediaRecorder = null;
  let mediaStream = null;
  let audioChunks = [];
  let transcription = null;
  let liveInput = null;
  let semanticTurn = null;
  let previousAssistant = "";
  let completionWarningShown = false;
  let waitPhraseTimer = null;
  let inputDelivery = "neutral";
  let audioCtx = null;
  let ttsSource = null;
  let meterRaf = null;
  let playbackAnalyser = null;
  let playbackMeter = null;
  let microphoneMeter = null;
  let recorderSequence = 0;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let activeSpeech = null;   // current speech playback handle

  // Language selection (42 Flux TTS languages)
  let currentLangId = "en";
  let autoLanguage = true;
  try {
    autoLanguage = localStorage.getItem("bimo-voice-auto-lang") !== "0";
    const saved = localStorage.getItem("bimo-voice-lang");
    if (saved && VOICE_LANGUAGES.some((l) => l.id === saved)) currentLangId = saved;
  } catch {}

  function getLangConfig() {
    return VOICE_LANGUAGES.find((l) => l.id === currentLangId) || VOICE_LANGUAGES.find(language => language.id === "en");
  }

  function applyDetectedLanguage(language) {
    if (!autoLanguage || !language) return;
    const code = normalizeVoiceLanguage(language);
    if (!code) return;
    currentLangId = code;
    try { localStorage.setItem("bimo-voice-lang", code); } catch {}
    langBtn.setAttribute("aria-label", `Language: Automatic (${getLangConfig().label})`);
  }

  // Voice-activity detection state (tuning constants at the top of the file).
  let vadAnalyser = null;
  let vadSource = null;
  let vadHighpass = null;
  let vadRaf = null;
  let vadHadSpeech = false;   // did this take ever contain confirmed speech?
  let interimTranscript = "";
  let lastTranscriptChangeAt = 0;
  let discardTake = false;    // drop the in-flight recording on stop (typed turn)
  let recordStartedAt = 0;    // performance.now() when the current take began

  let listenRestartTimer = null;
  let capturePending = 0;
  const TTS_COOLDOWN_MS = 250; // let the last frame clear before reopening the mic

  // ---------- DOM ----------
  const orbCanvas = el("canvas", { class: "voice-orb-canvas", "aria-hidden": "true" });
  const globe = el("div", { class: "voice-globe", "aria-hidden": "true" }, [orbCanvas]);
  const statusText = el("div", { class: "voice-status", "aria-live": "polite", text: "Start talking" });
  const transcriptText = el("div", { class: "voice-transcript" });

  const typeInput = el("input", {
    class: "voice-type",
    type: "text",
    placeholder: "Type",
    "aria-label": "Type a message",
    onkeydown: (e) => { if (e.key === "Enter") submitTyped(); },
  });

  // Native dropdown supports direct selection, keyboard use, and mobile pickers.
  function selectLanguage(id) {
    const nextAuto = id === "auto";
    if (!nextAuto && !VOICE_LANGUAGES.some(language => language.id === id)) return;
    if (autoLanguage === nextAuto && (nextAuto || currentLangId === id)) return;
    autoLanguage = nextAuto;
    try { localStorage.setItem("bimo-voice-auto-lang", nextAuto ? "1" : "0"); } catch {}
    if (nextAuto) id = currentLangId;
    if (activeSpeech || turnInFlight || transcription) {
      cancelTranscription();
      stopSpeaking();
    }
    currentLangId = id;
    try { localStorage.setItem("bimo-voice-lang", id); } catch {}
    const conf = getLangConfig();
    langBtn.value = autoLanguage ? "auto" : id;
    langLabel.textContent = autoLanguage ? "Auto" : conf.label;
    langBtn.setAttribute("aria-label", autoLanguage ? "Language: Automatic" : `Language: ${conf.label}`);

    if (state === "listening" && navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined") {
      discardTake = true;
      const pendingRecorder = Boolean(mediaRecorder);
      stopRecorder();
      if (!pendingRecorder) startListening();
      return;
    }
    if (state === "idle") startListening();
  }

  const langBtn = el("select", {
    class: "voice-lang-btn",
    "aria-label": autoLanguage ? "Language: Automatic" : `Language: ${getLangConfig().label}`,
    title: "Auto follows the language you speak. Choose a language to keep it fixed.",
    onchange: (event) => selectLanguage(event.target.value),
  }, [el("option", { value: "auto", text: "Auto" }), ...VOICE_LANGUAGES.map(language => el("option", {
    value: language.id, text: language.label,
  }))]);
  langBtn.value = autoLanguage ? "auto" : currentLangId;

  const langLabel = el("span", { class: "voice-lang-label", "aria-hidden": "true",
    text: autoLanguage ? "Auto" : getLangConfig().label });
  const langWrap = el("div", { class: "voice-lang-wrap" }, [
    langLabel, langBtn,
    el("span", { class: "voice-lang-arrow", "aria-hidden": "true", html: icon("chevronDown", { width: 14, height: 14 }) }),
  ]);

  const micBtn = el("button", {
    class: "voice-mic", type: "button", "aria-label": "Microphone", title: "Talk",
    onclick: onMicTap, html: icon("mic", { width: 22, height: 22 }),
  });
  const closeBtn = el("button", {
    class: "voice-close", type: "button", "aria-label": "Close voice", title: "Close",
    onclick: () => close(), html: icon("x", { width: 22, height: 22 }),
  });

  const overlay = el("div", {
    class: "voice-overlay", role: "dialog", "aria-modal": "true", "aria-label": "Bmo",
  }, [
    el("header", { class: "voice-header" }, [
      el("span", { class: "voice-title", text: "Bmo" }),
    ]),
    el("div", { class: "voice-stage" }, [globe, statusText, transcriptText]),
    el("div", { class: "voice-bar" }, [
      el("div", { class: "voice-input-wrap" }, [typeInput]),
      langWrap,
      micBtn,
      closeBtn,
    ]),
  ]);

  const previousFocus = document.activeElement;
  document.body.append(overlay);
  const orb = createVoiceOrb(orbCanvas);
  document.body.classList.add("voice-open");
  requestAnimationFrame(() => overlay.classList.add("open"));
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

  const onKey = (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Tab") {
      const controls = [typeInput, langBtn, micBtn, closeBtn];
      const index = controls.indexOf(document.activeElement);
      if (index === -1 || (event.shiftKey && index === 0) || (!event.shiftKey && index === controls.length - 1)) {
        event.preventDefault();
        controls[event.shiftKey ? controls.length - 1 : 0].focus();
      }
    }
  };
  document.addEventListener("keydown", onKey);
  closeBtn.focus();
  document.addEventListener("visibilitychange", meterVisibilityChanged);
  reducedMotion?.addEventListener?.("change", meterVisibilityChanged);

  // ---------- state ----------
  function setState(next, label) {
    state = next;
    orb.setState(next);
    if (next !== "listening") stopMicrophoneMeter();
    overlay.dataset.state = next;
    globe.className = `voice-globe ${next}`;
    if (label != null) statusText.textContent = label;
    clearTimeout(waitPhraseTimer);
    waitPhraseTimer = null;
    // Real search/transcription labels own their states. Only generic reply
    // waiting rotates, and every state change cancels the previous timer.
    if (next === "thinking" && label == null) {
      const rotate = () => {
        if (!active || state !== "thinking") return;
        statusText.textContent = getRandomPhrase();
        waitPhraseTimer = setTimeout(rotate, 3000);
      };
      rotate();
    }
  }
  function setTranscript(t) {
    transcriptText.textContent = t || "";
    transcriptText.scrollTop = transcriptText.scrollHeight;
  }

  // ---------- listening ----------
  function startListening() {
    clearTimeout(listenRestartTimer);
    listenRestartTimer = null;
    if (state === "listening" && (mediaRecorder?.state === "recording" || (capturePending && capturePending === recorderSequence))) return;
    if (!active || turnInFlight || state === "speaking" || activeSpeech || ttsSource) return;
    cancelTranscription();
    setTranscript("");
    setState("listening", "Listening…");
    micBtn.classList.add("active");
    if (navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined") {
      startRecorder();
    } else {
      setState("idle", "Voice input isn't supported here — type instead");
      micBtn.classList.remove("active");
    }
  }

  function stopMicrophoneMeter() {
    microphoneMeter = null;
    orb.setLevels({ mic: 0, low: 0, mid: 0 });
    if (!playbackMeter && meterRaf !== null) { cancelAnimationFrame(meterRaf); meterRaf = null; }
  }

  // Keep a local recording so Deepgram can recover a failed live turn.
  async function startRecorder() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setState("idle", "Voice input isn't supported here — type instead");
      micBtn.classList.remove("active");
      return;
    }
    const sequence = ++recorderSequence;
    capturePending = sequence;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
      if (!active || state !== "listening" || sequence !== recorderSequence) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      mediaStream = stream;
    } catch {
      if (!active || sequence !== recorderSequence) return;
      toast("Mic denied", { tone: "error" });
      micBtn.classList.remove("active");
      setState("idle", "Tap the mic to talk");
      return;
    } finally {
      if (capturePending === sequence) capturePending = 0;
    }
    audioChunks = [];
    inputDelivery = "neutral";
    try {
      const mime = MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported?.("audio/webm") ? "audio/webm" : "";
      mediaRecorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
      mediaRecorder.addEventListener("dataavailable", (e) => { if (e.data.size) audioChunks.push(e.data); });
      mediaRecorder.addEventListener("stop", onRecorderStop);
      mediaRecorder.start(1000);
    } catch (error) {
      mediaStream.getTracks().forEach(track => track.stop());
      mediaStream = null;
      mediaRecorder = null;
      micBtn.classList.remove("active");
      setState("idle", "Tap the mic to try again");
      toast("Couldn't start microphone recording", { tone: "error" });
      return;
    }
    recordStartedAt = performance.now();
    setState("listening", "Listening…");
    if (typeof api.checkVoiceTurn === "function" && typeof AudioWorkletNode !== "undefined") {
      const detector = new SemanticTurnDetector({
        check: (text, { signal }) => api.checkVoiceTurn(token, text.slice(-6000), previousAssistant.slice(-1200), { signal }),
        onComplete: () => {
          if (active && semanticTurn === detector && sequence === recorderSequence && state === "listening") {
            // Flush Nova's finalized words rather than send its interim caption.
            stopRecorder();
          }
        },
        onUnavailable: () => {
          if (!active || semanticTurn !== detector || completionWarningShown) return;
          completionWarningShown = true;
          toast("Smart turn detection is unavailable. Voice will send after a short pause.");
        },
      });
      semanticTurn = detector;
    }

    // Audio gates both early semantic checks and delayed provider endpoints.
    let lastAcousticSpeechAt = -Infinity;
    vadHadSpeech = false;
    interimTranscript = "";
    lastTranscriptChangeAt = 0;
    discardTake = false;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const vadCtx = audioCtx || (audioCtx = new Ctx());
      if (vadCtx.state === "suspended") vadCtx.resume().catch(() => {});
      vadSource = vadCtx.createMediaStreamSource(mediaStream);
      vadAnalyser = vadCtx.createAnalyser();
      vadAnalyser.fftSize = 512;
      vadAnalyser.smoothingTimeConstant = 0.2;
      if (vadCtx.createBiquadFilter) {
        vadHighpass = vadCtx.createBiquadFilter();
        vadHighpass.type = "highpass";
        vadHighpass.frequency.value = VAD_HIGHPASS_HZ;
        vadSource.connect(vadHighpass);
        vadHighpass.connect(vadAnalyser);
      } else {
        vadSource.connect(vadAnalyser);
      }
      microphoneMeter = createAudioMeter(vadAnalyser, vadCtx.sampleRate);
      scheduleMeter();

      const startedAt = performance.now();
      let noiseFloor = 0;
      let peakLevel = 0;
      let loudFrames = 0;
      let speaking = false;
      let silenceStart = 0;
      let lastLogAt = 0;

      const tickVAD = () => {
        if (!active || state !== "listening" || !mediaRecorder || mediaRecorder.state === "inactive") {
          stopVAD();
          return;
        }
        const now = performance.now();
        const sample = microphoneMeter.sample(now);
        // FFT display bytes are logarithmic; speech/noise ratios need actual
        // waveform amplitude, not the orb's normalized visual envelope.
        const level = sample.rms;
        peakLevel = Math.max(peakLevel, level);
        const elapsed = now - startedAt;

        // Learn the room before speech and lower the estimate in quiet gaps.
        // Sustained speech must never become its own background estimate.
        if (!noiseFloor) noiseFloor = level;
        else if (level < noiseFloor) noiseFloor = noiseFloor * 0.7 + level * 0.3;
        else if (!speaking) noiseFloor = noiseFloor * 0.995 + level * 0.005;

        // Let the tracker settle on the room before judging anything (also
        // swallows the mic-activation pop).
        if (elapsed <= VAD_CALIBRATE_MS) {
          // A newly opened microphone can ramp up from near-zero samples.
          // Seed the room level from the settled calibration peak instead of
          // freezing an artificially low first-frame estimate as "speech".
          noiseFloor = peakLevel;
          vadRaf = requestAnimationFrame(tickVAD);
          return;
        }

        const enterAt = Math.max(noiseFloor * VAD_ENTER_FACTOR, VAD_MIN_LEVEL);
        const exitAt = Math.max(noiseFloor * VAD_EXIT_FACTOR, VAD_MIN_LEVEL * 0.7);

        // Speech can begin during calibration. Its first quiet gap still ends
        // the take even if that speech was initially learned as the room floor.
        const hasTranscript = Boolean(interimTranscript);
        const speechDropRatio = hasTranscript ? 0.7 : 0.35;
        // Recognized words also prove speech when the local gate missed a very
        // soft voice. A near-silent microphone can still end that utterance.
        const quietTranscript = hasTranscript && level <= exitAt;
        if (!speaking && (quietTranscript || (peakLevel >= VAD_MIN_LEVEL && level < peakLevel * speechDropRatio))) {
          speaking = true;
          vadHadSpeech = true;
          silenceStart = now;
        }

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
          }
        }

        const captureSpeaking = level > (speaking ? exitAt : enterAt);
        if (captureSpeaking) lastAcousticSpeechAt = now;
        if (speaking) {
          if (captureSpeaking) {
            silenceStart = 0;
            semanticTurn?.setSpeaking(true);
          } else {
            if (!silenceStart) silenceStart = now;
            // New words can indicate continued speech even at a low audio level.
            const quietFor = now - Math.max(silenceStart, lastTranscriptChangeAt);
            semanticTurn?.setSpeaking(quietFor < SEMANTIC_QUIET_MS);
            if (quietFor >= VAD_SILENCE_MS) {
              stopRecorder();
              return;
            }
          }
        }

        // Silent recordings are renewed without a user turn; the call stays
        // ready while the user thinks, with bounded backup audio in memory.
        if (!vadHadSpeech && elapsed >= VAD_IDLE_ROTATE_MS) {
          discardTake = true;
          stopRecorder();
          return;
        }
        if (vadHadSpeech && elapsed >= VAD_MAX_TURN_MS) {
          stopRecorder();
          return;
        }
        vadRaf = requestAnimationFrame(tickVAD);
      };
      vadRaf = requestAnimationFrame(tickVAD);
    } catch (err) {
      console.warn("[bimo-voice] VAD init failed:", err);
      semanticTurn?.cancel();
      semanticTurn = null;
      // No detector → the user stops manually with a mic tap; that take must
      // still be transcribed, so don't let the no-speech skip kick in.
      vadHadSpeech = true;
    }
    if (typeof AudioWorkletNode !== "undefined") {
      const live = new LiveTranscriber({
        token, language: autoLanguage ? "multi" : currentLangId, endpointingMs: VAD_SILENCE_MS,
        onLanguage: language => {
          if (!active || liveInput !== live || !autoLanguage) return;
          applyDetectedLanguage(language);
        },
        onTranscript: text => {
          if (!active || liveInput !== live || state !== "listening") return;
          if (text !== interimTranscript) {
            interimTranscript = text;
            if (text) {
              vadHadSpeech = true;
              lastTranscriptChangeAt = performance.now();
            }
            semanticTurn?.update(text);
          }
        },
        onUtteranceEnd: () => {
          // A delayed endpoint may describe an earlier pause rather than the latest speech.
          const quietFor = performance.now() - lastAcousticSpeechAt;
          if (active && liveInput === live && state === "listening" && quietFor >= SEMANTIC_QUIET_MS) {
            stopRecorder();
          }
        },
        onError: error => {
          if (!active || liveInput !== live || error.name === "AbortError") return;
          // With no live transcript, a semantic check cannot see the rest of
          // this take. Recover the complete recording using the audio endpoint.
          semanticTurn?.cancel();
          semanticTurn = null;
          // Preserve this take's recorded audio for recovery; never submit an
          // incomplete streaming hypothesis as the user's whole question.
        },
      });
      liveInput = live;
      live.start(mediaStream);
    }
  }

  function stopVAD() {
    stopMicrophoneMeter();
    if (vadRaf) { cancelAnimationFrame(vadRaf); vadRaf = null; }
    if (vadSource) { try { vadSource.disconnect(); } catch { /* ignore */ } vadSource = null; }
    if (vadHighpass) { vadHighpass.disconnect(); vadHighpass = null; }
    vadAnalyser = null;
  }

  function stopRecorder() {
    semanticTurn?.cancel();
    semanticTurn = null;
    recorderSequence++;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      if (liveInput) {
        mediaRecorder.liveInput = liveInput;
        mediaRecorder.liveResult = liveInput.finish();
        liveInput = null;
      }
      try { mediaRecorder.stop(); } catch { /* ignore */ }
      mediaStream?.getTracks().forEach(track => track.stop());
      mediaStream = null;
      micBtn.classList.remove("active");
    }
  }

  function cancelTranscription() {
    transcription?.abort();
    transcription = null;
  }

  async function onRecorderStop() {
    semanticTurn?.cancel();
    semanticTurn = null;
    stopVAD();
    if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
    const recorder = mediaRecorder;
    mediaRecorder = null;
    if (!active) { recorder?.liveInput?.cancel(); return; }
    micBtn.classList.remove("active");
    // A typed turn superseded this take — drop the audio without touching the
    // UI state (endTurn owns it now).
    if (discardTake) {
      recorder?.liveInput?.cancel();
      discardTake = false;
      audioChunks = [];
      if (state === "listening" && !turnInFlight) startListening();
      return;
    }
    const took = recordStartedAt ? performance.now() - recordStartedAt : 0;
    recordStartedAt = 0;
    if (!recorder?.liveResult && (!audioChunks.length || took < MIN_RECORDING_MS)) {
      audioChunks = [];
      afterSpeaking();
      return;
    }
    cancelTranscription();
    const controller = new AbortController();
    transcription = controller;
    const isCurrent = () => active && transcription === controller && !controller.signal.aborted;
    setState("thinking", "Transcribing…");
    controller.signal.addEventListener("abort", () => recorder?.liveInput?.cancel(), { once: true });
    try {
      let t;
      if (recorder?.liveResult) {
        try {
          t = (await recorder.liveResult).trim();
          if (!isCurrent()) return;
          inputDelivery = recorder.liveInput.delivery || "neutral";
          applyDetectedLanguage(recorder.liveInput.detectedLanguage);
        }
        catch { if (!isCurrent()) return; }
      }
      if (!isCurrent()) return;
      if ((t === undefined || (autoLanguage && !t)) && audioChunks.length) {
        const blob = new Blob(audioChunks, { type: recorder?.mimeType || "audio/webm" });
        const wav = await blobToWav16kMono(blob);
        if (!isCurrent()) return;
        const res = await api.transcribeAudio(token, wav, { language: autoLanguage ? "auto" : currentLangId, deepgramOnly: true, signal: controller.signal });
        if (!isCurrent()) return;
        t = (res?.text || "").trim();
        applyDetectedLanguage(res?.language);
      }
      audioChunks = [];
      if (t) endTurn(t);
      else afterSpeaking();
    } catch (err) {
      if (isCurrent()) {
        toast(err.message || "Transcription failed", { tone: "error" });
        setState("idle", "Tap the mic to talk");
      }
    } finally {
      if (transcription === controller) transcription = null;
    }
  }

  // ---------- turn ----------
  async function endTurn(text) {
    if (turnInFlight || !active) return;
    cancelTranscription();
    const turn = ++turnSequence;
    const isCurrent = () => active && turn === turnSequence;
    turnInFlight = true;
    micBtn.classList.remove("active");
    stopRecorder();
    setTranscript(text);
    setState("thinking");

    currentTone = inputDelivery;
    let speech = null;
    let searchSpeech = null;
    let searchActive = false;
    let searchAnnounced = false;
    let searchDone = Promise.resolve();
    let pendingText = "";
    let responseFailed = false;
    const startedAt = performance.now();
    function pushReply() {
      if (!isCurrent() || responseFailed || !audioCtx || searchActive || speech?.cancelled) return;
      if (!speech) {
        speech = createDeepgramTTSStream(startedAt);
        activeSpeech = speech;
      }
      speech.pushText(pendingText);
    }

    const activeLang = getLangConfig();
    function announceSearch() {
      if (!isCurrent() || !audioCtx || searchAnnounced || pendingText) return;
      searchAnnounced = true;
      searchActive = true;
      searchSpeech = createDeepgramTTSStream(startedAt);
      activeSpeech = searchSpeech;
      searchSpeech.finish(getVoiceAcknowledgment(activeLang.id, "search"));
      searchDone = searchSpeech.done().then(() => {
        searchActive = false;
        if (!isCurrent() || responseFailed) return;
        if (activeSpeech === searchSpeech) activeSpeech = null;
        setState("thinking");
        if (pendingText) pushReply();
      });
    }
    try {
      const reply = (await sendTurn(text, {
        language: activeLang.id,
        languageName: activeLang.label,
        delivery: inputDelivery,
        onVoiceStyle: tone => { if (isCurrent()) currentTone = ["gentle", "lively"].includes(tone) ? tone : "neutral"; },
        onSearching: () => {
          if (!isCurrent()) return;
          setState("thinking", "Searching…");
          announceSearch();
        },
        onDelta: soFar => {
          if (!isCurrent()) return;
          pendingText = soFar;
          // A slow acknowledgment synthesizer must never hold up real output.
          if (pendingText && searchSpeech && !searchSpeech.hasAudio()) searchSpeech.cancel();
          pushReply();
        },
      })) || "";

      if (reply && searchSpeech && !searchSpeech.hasAudio()) searchSpeech.cancel();
      await searchDone;
      if (!isCurrent()) { speech?.cancel(); searchSpeech?.cancel(); return; }
      previousAssistant = reply;
      if (!reply || !audioCtx) {
        speech?.cancel();
        afterSpeaking();
        return;
      }
      pendingText = reply;
      pushReply();
      speech.finish(reply);
      let timeout;
      await Promise.race([speech.done(), new Promise(resolve => { timeout = setTimeout(resolve, 300000); })])
        .finally(() => clearTimeout(timeout));
      if (!isCurrent() || speech.cancelled) return;
      afterSpeaking();
    } catch (err) {
      responseFailed = true;
      if (isCurrent()) {
        console.warn("[bimo-voice] sendTurn failed:", err?.message);
        toast(err?.message || "Couldn't connect", { tone: "error" });
        speech?.cancel();
        searchSpeech?.cancel();
        afterSpeaking();
      }
    } finally {
      if (isCurrent()) turnInFlight = false;
    }
  }

  function afterSpeaking() {
    if (!active) return;
    turnInFlight = false;
    activeSpeech = null;
    ttsSource = null;
    setState("idle", "");
    clearTimeout(listenRestartTimer);
    const completedTurn = turnSequence;
    listenRestartTimer = setTimeout(() => {
      listenRestartTimer = null;
      if (active && completedTurn === turnSequence && !turnInFlight && !activeSpeech && state === "idle") startListening();
    }, TTS_COOLDOWN_MS);
  }

  // ---------- speaking (streaming Deepgram Flux via Web Audio) ----------
  function createDeepgramTTSStream(startedAt = performance.now()) {
    const activeLang = getLangConfig();
    let cancelled = false;
    let offset = 0;
    let finished = false;
    let flushSent = false;
    let serverAudioDone = false;
    let hasReceivedAudio = false;
    let wsClosed = false;
    let nextPlayTime = 0;
    let finishTimer = null;
    let hasSentFirstChunk = false;
    let completed = false;
    const queuedSources = [];
    const pendingTextQueue = [];
    let resolveDone;
    const donePromise = new Promise((r) => { resolveDone = r; });

    // Each open TTS socket occupies a gateway request thread. Keep it scoped
    // to one utterance so listening or waiting for a reply uses no TTS slot.
    let ws = null;

    function complete() {
      if (completed) return;
      completed = true;
      if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
      try { ws?.close(); } catch {}
      stopMeter();
      ttsSource = null;
      resolveDone();
    }

    function isAudioPlaying() {
      if (!audioCtx) return false;
      if (queuedSources.length > 0) return true;
      if (nextPlayTime > 0 && audioCtx.currentTime < nextPlayTime - 0.02) return true;
      return false;
    }

    function checkDone() {
      if (cancelled || completed) return;
      if (isAudioPlaying()) {
        if (queuedSources.length === 0 && audioCtx && nextPlayTime > audioCtx.currentTime) {
          const waitMs = Math.max(20, Math.ceil((nextPlayTime - audioCtx.currentTime) * 1000) + 40);
          setTimeout(() => { if (!cancelled) checkDone(); }, waitMs);
        }
        return;
      }

      if (!finished) return;

      if (!ws || serverAudioDone || wsClosed) {
        complete();
        return;
      }

      if (!finishTimer) {
        const stallMs = hasReceivedAudio ? 2500 : 8000;
        finishTimer = setTimeout(() => {
          if (!cancelled && !isAudioPlaying()) {
            complete();
          }
        }, stallMs);
      }
    }

    function openSocket() {
      const delivery = voiceDelivery(currentTone);
      const controls = activeLang.id === "en" ? delivery : { expressivity: delivery.expressivity };
      try {
        const url = api.ttsStreamUrl(token, { model: activeLang.model, sampleRate: 24000, ...controls });
        ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
      } catch (err) {
        console.warn("[bimo-voice] Could not open speech WebSocket:", err);
        return;
      }

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
        if (cancelled || completed || !active) return;
        if (typeof event.data === "string") {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "SpeechMetadata") {
              serverAudioDone = true;
              checkDone();
            } else if (data.type === "Flushed") {
              const isFlux = (activeLang?.model || "").startsWith("flux");
              if (!isFlux) {
                serverAudioDone = true;
              }
              checkDone();
            } else if (data.type === "Warning" && (data.code === "NO_ACTIVE_SPEECH" || data.code === "NO_SYNTHESIZABLE_TEXT")) {
              serverAudioDone = true;
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
        pendingTextQueue.length = 0;
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
        stopRecorder();
        micBtn.classList.remove("active");
        setState("speaking", "Speaking…");
      }

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      if (!playbackAnalyser) {
        playbackAnalyser = audioCtx.createAnalyser();
        playbackAnalyser.fftSize = 512;
        playbackAnalyser.smoothingTimeConstant = 0.15;
        playbackAnalyser.connect(audioCtx.destination);
      }
      source.connect(playbackAnalyser);
      ttsSource = source;
      if (!playbackMeter) playbackMeter = createAudioMeter(playbackAnalyser, audioCtx.sampleRate);
      scheduleMeter();

      const now = audioCtx.currentTime;
      // Start immediately with minimum jitter buffer (10ms)
      const startTime = Math.max(now + 0.010, nextPlayTime);
      source.start(startTime);
      nextPlayTime = startTime + audioBuffer.duration;

      if (!hasReceivedAudio) console.debug("[bimo-voice] first-audio-ms", Math.round(performance.now() - startedAt));
      hasReceivedAudio = true;
      queuedSources.push(source);
      source.onended = () => {
        source.disconnect();
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
      const clean = stripForSpeech(rawText, isStart, activeLang.id).trim();
      // Skip chunks with no actual spoken words (prevents sending orphan dots or bare punctuation)
      if (!clean || !clean.replace(/[\s.,;:!?…-]/g, "")) return;
      if (isStart) {
        hasSentFirstChunk = true;
        openSocket();
      }
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
      if (cancelled || completed || typeof soFar !== "string") return;
      const pending = soFar.slice(offset);
      if (!pending) return;

      // Prefer sentence boundaries; keep a useful first phrase for fast startup.
      const match = pending.match(/([.!?](?=\s|$)|[。！？۔؟।॥\n])/);
      if (match && match.index != null) {
        const endIdx = match.index + match[0].length;
        const toSend = pending.slice(0, endIdx);
        offset += endIdx;
        sendChunk(toSend);
        return;
      }

      // Longer later chunks give synthesis more context without splitting words.
      if (pending.length >= (hasSentFirstChunk ? 160 : 40)) {
        const lastSpace = pending.lastIndexOf(" ");
        if (lastSpace > 0) {
          const toSend = pending.slice(0, lastSpace + 1);
          offset += lastSpace + 1;
          sendChunk(toSend);
        }
      }
    }

    function finish(finalText) {
      if (cancelled || completed) { resolveDone(); return; }
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
        try { s.onended = null; s.stop(); s.disconnect(); } catch {}
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
      complete();
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

  function scheduleMeter() {
    if (!active || document.hidden || reducedMotion?.matches || meterRaf !== null || (!microphoneMeter && !playbackMeter)) return;
    meterRaf = requestAnimationFrame(sampleMeters);
  }

  function sampleMeters(now) {
    meterRaf = null;
    if (!active || document.hidden) return;
    const mic = state === "listening" ? microphoneMeter?.sample(now) : null;
    const playback = state === "speaking" ? playbackMeter?.sample(now) : null;
    const bands = playback || mic;
    orb.setLevels({ mic: mic?.level || 0, playback: playback?.level || 0,
      low: bands?.low || 0, mid: bands?.mid || 0 });
    scheduleMeter();
  }

  function meterVisibilityChanged() {
    if (meterRaf !== null) { cancelAnimationFrame(meterRaf); meterRaf = null; }
    scheduleMeter();
  }

  function stopMeter() {
    playbackMeter = null;
    orb.setLevels({ playback: 0, low: 0, mid: 0 });
    if (!microphoneMeter && meterRaf !== null) { cancelAnimationFrame(meterRaf); meterRaf = null; }
  }

  function stopSpeaking() {
    clearTimeout(listenRestartTimer);
    listenRestartTimer = null;
    turnSequence++;
    if (turnInFlight) onInterrupt?.();
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
    stopSpeaking();
    // If the mic was live, release it and discard that take — otherwise the
    // recorder keeps the mic hot through the whole typed turn and its stale
    // audio collides with the next listening round.
    if (mediaRecorder) {
      discardTake = true;
      stopRecorder();
    }
    await endTurn(t);
  }

  function close() {
    if (!active) return;
    active = false;
    cancelTranscription();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("visibilitychange", meterVisibilityChanged);
    reducedMotion?.removeEventListener?.("change", meterVisibilityChanged);
    stopRecorder();
    stopSpeaking();
    stopVAD();
    if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
    if (playbackAnalyser) { try { playbackAnalyser.disconnect(); } catch {} playbackAnalyser = null; }
    orb.destroy();
    if (audioCtx) { try { audioCtx.close(); } catch { /* ignore */ } audioCtx = null; }
    document.body.classList.remove("voice-open");
    overlay.classList.remove("open");
    setTimeout(() => overlay.remove(), 220);
    if (previousFocus?.isConnected) previousFocus.focus();
    if (typeof onClose === "function") onClose();
  }

  // Request capture from the opening gesture; the visual transition must not
  // delay or discard the beginning of the user's first utterance.
  startListening();

  return { close };
}
