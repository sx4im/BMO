/**
 * Audio recorder and voice transcriber for Bmo composer.
 * Captures microphone stream, converts to 16 kHz mono WAV, and transcribes via API.
 */

import { blobToWav16kMono } from "../audio-wav.js?v=30";
import { toast } from "../components/toast.js?v=58";
import * as api from "../api.js?v=56";

export class AudioRecorder {
  constructor({ onStateChange, onTranscription, getAuthToken }) {
    this.onStateChange = onStateChange || (() => {});
    this.onTranscription = onTranscription || (() => {});
    this.getAuthToken = getAuthToken || (() => null);

    this.isRecording = false;
    this.isTranscribing = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
  }

  async start() {
    if (this.isRecording || this.isTranscribing) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = new MediaRecorder(stream);
      this.audioChunks = [];

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };

      this.mediaRecorder.onstop = async () => {
        const rawBlob = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType });
        stream.getTracks().forEach((t) => t.stop());
        await this._processAudio(rawBlob);
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      this.onStateChange({ isRecording: true, isTranscribing: false });
    } catch (err) {
      console.warn("Microphone access denied or error:", err);
      toast("Microphone access is required for voice input.", { tone: "error" });
      this.isRecording = false;
      this.onStateChange({ isRecording: false, isTranscribing: false });
    }
  }

  stop() {
    if (!this.isRecording || !this.mediaRecorder) return;
    this.mediaRecorder.stop();
    this.isRecording = false;
    this.isTranscribing = true;
    this.onStateChange({ isRecording: false, isTranscribing: true });
  }

  toggle() {
    if (this.isRecording) {
      this.stop();
    } else {
      this.start();
    }
  }

  async _processAudio(rawBlob) {
    const token = this.getAuthToken();
    if (!token) {
      this.isTranscribing = false;
      this.onStateChange({ isRecording: false, isTranscribing: false });
      return;
    }

    try {
      const wavBlob = await blobToWav16kMono(rawBlob);
      const res = await api.transcribeAudio(token, wavBlob, { filename: "voice.wav" });
      if (res && res.text && res.text.trim()) {
        this.onTranscription(res.text.trim());
      } else {
        toast("No speech detected. Try speaking closer to the mic.", { tone: "neutral" });
      }
    } catch (err) {
      console.warn("Transcription failed:", err);
      toast(err.message || "Could not transcribe audio.", { tone: "error" });
    } finally {
      this.isTranscribing = false;
      this.onStateChange({ isRecording: false, isTranscribing: false });
    }
  }
}
