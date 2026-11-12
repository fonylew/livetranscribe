/**
 * Direct WebSocket client for the Gemini Live API (`BidiGenerateContent`),
 * inspired by `lib/live-session.js` and `lib/preflight.js` in `kazunori279/interpretab`
 * and updated for `gemini-3.8-live` per `gemini-live-api-dev`.
 */

import { buildBidirectionalInstruction } from "./instructions.js";
import { DEFAULT_MODEL, FALLBACK_MODEL } from "./usage.js";

export const ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const MODELS_REST_URL = "https://generativelanguage.googleapis.com/v1beta/models";
export const PREFLIGHT_TIMEOUT_MS = 2500;

export const UPLINK_RATE = 16000;
export const DOWNLINK_RATE = 24000;

/**
 * Coalesce 128-sample (8 ms) AudioWorklet blocks into 64 ms frames (2048 bytes, ~15.6 fps)
 * before base64 JSON wrapping for smooth, low-jitter WebSocket audio streaming.
 */
export const UPLINK_CHUNK_MS = 64;
export const UPLINK_CHUNK_BYTES = Math.round((UPLINK_RATE * 2 * UPLINK_CHUNK_MS) / 1000);

export const CANDIDATE_MODELS = [DEFAULT_MODEL, FALLBACK_MODEL];

export const VOICES = {
  Puck: "Upbeat (Default)",
  Aoede: "Breezy",
  Charon: "Informative",
  Kore: "Firm",
  Fenrir: "Excitable",
  Leda: "Youthful",
  Orus: "Firm",
  Zephyr: "Bright",
};

export const DEFAULT_VOICE = "Puck";

export function resolveVoice(name) {
  if (!name) return DEFAULT_VOICE;
  const wanted = String(name).trim().toLowerCase();
  for (const voice of Object.keys(VOICES)) {
    if (voice.toLowerCase() === wanted) return voice;
  }
  return DEFAULT_VOICE;
}

export function arrayToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToArray(base64) {
  let standard = String(base64 || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  while (standard.length % 4) standard += "=";
  const binary = atob(standard);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function endpointUrl(apiKey) {
  return `${ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
}

/**
 * Build the `setup` frame for a bidirectional Thai ⇄ English Live session.
 *
 * Note:
 * - `inputAudioTranscription` and `outputAudioTranscription` are placed on `setup`
 *   (not nested inside `generationConfig`), matching the Gemini Live WebSocket schema.
 * - For `gemini-3.8-live`, `thinking_level`, `proactive_audio: false`, and
 *   `enable_affective_dialog` are omitted per the Gemini 3.8 Live migration spec.
 */
export function buildSetup({
  model = DEFAULT_MODEL,
  voice = DEFAULT_VOICE,
  speakerLang = "auto",
  glossary = [],
  eventContext = "",
  silenceDurationMs = 1000,
  prefixPaddingMs = 200,
} = {}) {
  const voiceName = resolveVoice(voice);
  return {
    setup: {
      model: `models/${String(model).replace(/^models\//, "")}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName },
          },
        },
      },
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
          endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
          prefixPaddingMs,
          silenceDurationMs,
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      systemInstruction: {
        parts: [
          {
            text: buildBidirectionalInstruction({
              langA: "th",
              langB: "en",
              speakerLang,
              glossary,
              eventContext,
            }),
          },
        ],
      },
    },
  };
}

/**
 * Preflight REST check before opening the WebSocket so that an invalid API key
 * or exhausted quota is reported clearly instead of failing with an opaque WS 1006.
 */
export async function preflight(apiKey, { fetchImpl = fetch } = {}) {
  if (!apiKey || !String(apiKey).trim()) {
    return {
      ok: false,
      fatal: true,
      detail: "Please enter your Gemini API key in Settings before starting.",
    };
  }

  const stop = AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${MODELS_REST_URL}?pageSize=1&key=${encodeURIComponent(apiKey.trim())}`, {
      method: "GET",
      signal: stop,
      headers: { "x-goog-api-client": "livetranscribe/1.0.0" },
    });
  } catch {
    return { ok: false, fatal: false, detail: "" };
  }

  if (res.ok) {
    return { ok: true, fatal: false, detail: "API key verified." };
  }

  let error = null;
  try {
    error = (await res.json())?.error ?? null;
  } catch {
    // Non-JSON error body
  }

  const reason = error?.details?.find((d) => d.reason)?.reason || "";
  const code = error?.status || "";

  if (reason === "API_KEY_INVALID" || code === "UNAUTHENTICATED" || res.status === 401) {
    return {
      ok: false,
      fatal: true,
      detail: "Your Gemini API key was rejected. Check your key at aistudio.google.com/apikey.",
    };
  }
  if (code === "RESOURCE_EXHAUSTED" || res.status === 429) {
    return {
      ok: false,
      fatal: true,
      detail: "Your Gemini API quota is exhausted. Check your plan and billing in Google AI Studio.",
    };
  }
  if (code === "PERMISSION_DENIED" || res.status === 403) {
    return {
      ok: false,
      fatal: true,
      detail: "This API key does not have permission to call the Gemini API.",
    };
  }

  return { ok: false, fatal: false, detail: "" };
}

export class LiveSession {
  constructor({ apiKey, setup, onEvent, onStatus, closeHint = "", WebSocketClass = WebSocket }) {
    this._apiKey = apiKey;
    this._setup = setup;
    this._onEvent = onEvent || (() => {});
    this._onStatus = onStatus || (() => {});
    this._closeHint = closeHint;
    this._WebSocket = WebSocketClass;
    this._ws = null;
    this._closed = false;
    this._live = false;
    this._pending = [];
    this._pendingBytes = 0;
    this._settleOpen = null;
  }

  open() {
    this._closed = false;
    this._onStatus("connecting");
    return new Promise((resolve, reject) => {
      this._settleOpen = (err) => {
        this._settleOpen = null;
        if (err) reject(err);
        else resolve(this);
      };

      const ws = new this._WebSocket(endpointUrl(this._apiKey));
      ws.binaryType = "arraybuffer";
      this._ws = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify(this._setup));
      };

      ws.onmessage = async (event) => {
        const msg = await parseFrame(event.data);
        if (!msg) return;
        if (msg.setupComplete) {
          this._live = true;
          this._onStatus("connected");
          this._settleOpen?.(null);
          return;
        }
        this._dispatch(msg);
      };

      ws.onerror = () => {};

      ws.onclose = (event) => {
        this._ws = null;
        this._live = false;
        if (this._settleOpen) {
          this._settleOpen(new Error(closeReason(event, this._closeHint)));
        } else if (!this._closed) {
          this._onEvent({
            type: "closed",
            code: event.code,
            reason: event.reason || "",
          });
        }
      };
    });
  }

  _dispatch(msg) {
    if (msg.goAway) {
      this._onEvent({
        type: "goAway",
        timeLeft: parseDuration(msg.goAway.timeLeft),
      });
      return;
    }

    if (msg.usageMetadata) {
      this._onEvent({ type: "usage", usage: msg.usageMetadata });
    }

    const content = msg.serverContent;
    if (!content) return;

    if (content.interimInputTranscription?.text) {
      this._onEvent({
        type: "input",
        text: content.interimInputTranscription.text,
        finished: false,
        interim: true,
      });
    }

    if (content.inputTranscription?.text) {
      this._onEvent({
        type: "input",
        text: content.inputTranscription.text,
        finished: !!content.inputTranscription.finished,
      });
    }

    if (content.outputTranscription?.text) {
      this._onEvent({
        type: "output",
        text: content.outputTranscription.text,
        finished: !!content.outputTranscription.finished,
      });
    }

    for (const part of content.modelTurn?.parts || []) {
      const inline = part.inlineData;
      if (inline && (inline.mimeType || "").startsWith("audio/pcm")) {
        this._onEvent({ type: "audio", buffer: base64ToArray(inline.data) });
      }
    }

    if (content.turnComplete) {
      this._onEvent({ type: "turnComplete" });
    }
  }

  get ready() {
    return this._live && !!this._ws && this._ws.readyState === 1; // WebSocket.OPEN === 1
  }

  /**
   * Queue a 16 kHz PCM16 ArrayBuffer and flush once 32 ms (1024 bytes) has accumulated.
   */
  send(pcmBuffer) {
    if (!this.ready) return;
    this._pending.push(new Uint8Array(pcmBuffer));
    this._pendingBytes += pcmBuffer.byteLength;
    if (this._pendingBytes >= UPLINK_CHUNK_BYTES) {
      this.flush();
    }
  }

  /**
   * Flush any buffered PCM bytes over the WebSocket using `realtimeInput.audio`.
   */
  flush() {
    if (!this._pendingBytes || !this.ready) return;
    const merged = new Uint8Array(this._pendingBytes);
    let offset = 0;
    for (const part of this._pending) {
      merged.set(part, offset);
      offset += part.length;
    }
    this._pending = [];
    this._pendingBytes = 0;
    this._ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: arrayToBase64(merged.buffer),
            mimeType: `audio/pcm;rate=${UPLINK_RATE}`,
          },
        },
      })
    );
  }

  /**
   * Hybrid VAD / Mic Off signal: flush any pending audio and notify the Live API
   * that the audio stream has paused (`audioStreamEnd: true`), immediately ending
   * the current speech turn and saving money while the mic is off or silent.
   */
  sendAudioStreamEnd() {
    if (!this.ready) {
      this._pending = [];
      this._pendingBytes = 0;
      return;
    }
    this.flush();
    this._ws.send(
      JSON.stringify({
        realtimeInput: {
          audioStreamEnd: true,
        },
      })
    );
  }

  close() {
    this._closed = true;
    this._live = false;
    this._pending = [];
    this._pendingBytes = 0;
    this._settleOpen?.(new Error("Session closed before handshake completed."));
    if (this._ws) {
      this._ws.onclose = null;
      this._ws.onmessage = null;
      this._ws.close();
      this._ws = null;
    }
  }
}

async function parseFrame(data) {
  let text = data;
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    text = await data.text();
  } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    text = new TextDecoder().decode(data);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function closeReason(event, hint = "") {
  if (event.reason) return `Connection closed: ${event.reason}`;
  if (event.code === 1006) {
    if (hint) return `Connection closed (1006). ${hint} Check quota or network connection.`;
    return "Connection refused (1006). Check your Gemini API key, quota, or network connection.";
  }
  return `Connection closed with code ${event.code}.`;
}

export function isQuotaClose(reason = "") {
  return /exceeded your current quota|RESOURCE_EXHAUSTED/i.test(reason);
}

export function isModelUnavailableClose(reason = "") {
  return (
    /\bmodels?\b/i.test(reason) &&
    /not found|not supported|is deprecated|has been (?:retired|discontinued|turned off)/i.test(
      reason
    )
  );
}

export function parseDuration(value) {
  if (typeof value === "number") return value * 1000;
  const seconds = parseFloat(String(value || "").replace(/s$/, ""));
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}
