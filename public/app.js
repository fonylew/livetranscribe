/**
 * Main Application Controller for LiveTranscribe
 * Real-time Event Transcription & Bidirectional Thai (th) ⇄ English (en) Translation
 * Inspired by `kazunori279/interpretab` and powered by the Gemini Live API.
 */

import {
  cleanTranscriptSpacing,
  detectLanguage,
  parseGlossaryText,
} from "./lib/instructions.js";
import {
  buildSetup,
  CANDIDATE_MODELS,
  DOWNLINK_RATE,
  preflight,
  UPLINK_RATE,
} from "./lib/live-session.js";
import { SessionLoop } from "./lib/session-loop.js";
import { extractThaiAndEnglish, turnsToSrt } from "./lib/srt.js";
import {
  computeUsageMetrics,
  DEFAULT_MODEL,
  emptyUsage,
  formatClock,
  formatTHB,
  formatTokenCount,
  formatUSD,
  noteAudioIn,
  noteAudioOut,
  noteAudioSaved,
  noteServerUsage,
} from "./lib/usage.js";

const STORAGE_KEY = "livetranscribe_settings_v1";
const LOCAL_SESSIONS_KEY = "livetranscribe_sessions_v1";
const LIVE_SNAPSHOT_KEY = "livetranscribe_live_snapshot_v1";
const HISTORY_LIMIT = 300;

/** Noise floor & Smart Silence Gate constants */
const SILENCE_FLOOR = 0.0025;
const SILENCE_HOLD_MS = 1500; // Pause stream after 1.5s of silence
const PREROLL_MAX_FRAMES = 44; // ~350ms of 8ms worklet frames kept when silence-gated
const MIC_DEAD_WARN_MS = 8000; // Warn if selected input has zero signal for first 8s

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: DEFAULT_MODEL,
  speakerLang: "th", // "auto" | "th" | "en" — defaults to Thai ("th")
  fontScale: 100,
  layoutMode: "side-by-side", // "side-by-side" | "stacked"
  obsMode: "auto", // "auto" | "horizontal" | "vertical"
  lineInMode: false,
  silenceGate: true,
  ttsAudio: false,
  audioSource: "",
  eventContext: "",
  glossaryText: "",
};

const params = new URLSearchParams(window.location.search);
const isDisplayMode = params.get("view") === "display" || params.get("obs") === "1";
const urlToken = (params.get("token") || "").trim();
const urlObsLayout = (params.get("obsLayout") || params.get("layout") || "").trim();

const state = {
  settings: loadSettings(),
  running: false,
  micMuted: false,
  silenceGated: false,
  activeModel: DEFAULT_MODEL,
  status: "disconnected",
  statusDetail: "Idle",

  // Server & Multi-session identity
  clientToken: urlToken || "",
  serverEnvApiKey: "",
  hasEnvApiKey: false,
  storageInfo: { local: true, gcs: false, firestore: false },

  // Current recording session tracking for .SRT persistence
  sessionId: "",
  sessionStartEpochMs: 0,
  pastSessions: [],
  selectedPastSession: null,

  // Audio contexts & nodes
  ctxUp: null,
  ctxDown: null,
  workletUpReady: false,
  workletDownReady: false,
  mediaStream: null,
  recorderNode: null,
  playerNode: null,
  sessionLoop: null,

  // Silence Gate & Mic level tracking
  lastSoundAt: 0,
  prerollFrames: [],
  micEverHeardSound: false,
  micWarnTimer: null,
  smoothedLevel: 0,

  // Usage & timers
  usage: emptyUsage(),
  startedAt: 0,
  clockTimer: null,

  // Transcript state
  historyTurns: [],
  currentTurn: {
    input: "",
    output: "",
    sourceLang: "auto",
    targetLang: "auto",
    startedAt: null,
    epochMs: null,
    geminiInputStarted: false,
    isLocalPreview: false,
  },
  browserAiMode: false, // True when running without a Gemini API key (Web Speech API + On-Device/Browser Translation)
  speechRec: null,
  speechRecLang: "th", // Active Web Speech API language ("th" | "en"), auto-switches when speaker changes language
  browserTranslators: {}, // Cache of Chrome On-Device Translator instances ("th->en", "en->th")
  browserTranslateSeq: 0,
  turnIdleTimer: null,
  userScrolledUp: false,

  // Cross-window / OBS sync channels
  bc: null,
  bcGlobal: null,
  relayWs: null,
};

const el = (id) => document.getElementById(id);

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(patch = {}) {
  Object.assign(state.settings, patch);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch {
    // Ignore storage quota errors
  }
}

function createNewSessionId() {
  const iso = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  return `session-${iso}-${rand}`;
}

async function init() {
  // If opened at http://0.0.0.0:3000 locally, redirect to http://localhost:3000
  // because browsers treat 0.0.0.0 as an insecure origin (disabling AudioWorklet & getUserMedia),
  // whereas http://localhost is a Secure Context.
  if (
    typeof window !== "undefined" &&
    window.location.hostname === "0.0.0.0" &&
    window.location.protocol === "http:"
  ) {
    const targetUrl = new URL(window.location.href);
    targetUrl.hostname = "localhost";
    window.location.replace(targetUrl.toString());
    return;
  }

  if (isDisplayMode) {
    document.body.classList.add("display-mode");
  }

  applyVisualSettings();
  bindUI();
  setupPwaSupport();

  await loadServerConfig();
  restoreLiveSnapshotFromLocal();
  setupSyncChannels();

  if (!isDisplayMode) {
    populateAudioDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", () => populateAudioDevices());
    refreshPastSessionsList();
  }

  window.addEventListener("resize", () => {
    if (isDisplayMode) {
      renderObsStage();
    }
  });

  renderControlState();
  renderUsageMetrics();
  renderCurrentTurn();
  renderHistory();
  renderObsStage();
}

/**
 * Load server config (`/api/config`):
 * - Obtains or verifies `clientToken` (also set via `lt_token` cookie for same-browser OBS sync)
 * - Loads `GEMINI_API_KEY` from `.env` / Cloud Run environment if configured
 * - Reads active storage targets (Local `.SRT`, Google Cloud Storage, Firestore)
 */
async function loadServerConfig() {
  try {
    const query = state.clientToken ? `?token=${encodeURIComponent(state.clientToken)}` : "";
    const res = await fetch(`/api/config${query}`, { credentials: "same-origin" });
    if (!res.ok) return;
    const cfg = await res.json();

    if (cfg.clientToken) {
      state.clientToken = cfg.clientToken;
    }
    state.hasEnvApiKey = Boolean(cfg.hasEnvApiKey);
    state.serverEnvApiKey = cfg.envApiKey || "";
    if (cfg.storage) {
      state.storageInfo = cfg.storage;
    }

    updateEnvApiKeyUI();
    updateObsPairingLinks();
    updateStorageBadgesUI();
  } catch {
    // Running without server backend
    updateObsPairingLinks();
  }
}

function updateEnvApiKeyUI() {
  const badge = el("envKeyBadge");
  const help = el("apiKeyHelpText");
  const input = el("apiKeyInput");

  if (state.hasEnvApiKey) {
    if (badge) badge.hidden = false;
    if (input && !state.settings.apiKey) {
      input.placeholder = "Using GEMINI_API_KEY from server .env (or enter key to override)";
    }
    if (help) {
      help.textContent =
        "Server .env GEMINI_API_KEY is active. Leave blank to use the server key, or enter a custom key to override.";
    }
  } else {
    if (badge) badge.hidden = true;
  }
}

function setupPwaSupport() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {
        // Ignore service worker registration errors in unsupported contexts
      });
    });
  }

  let deferredInstallPrompt = null;
  const installBtn = el("installPwaBtn");

  window.addEventListener("beforeinstallprompt", (ev) => {
    ev.preventDefault();
    deferredInstallPrompt = ev;
    if (installBtn && !isDisplayMode) {
      installBtn.hidden = false;
    }
  });

  installBtn?.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    try {
      await deferredInstallPrompt.userChoice;
    } catch {
      // Ignore
    }
    deferredInstallPrompt = null;
    installBtn.hidden = true;
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    if (installBtn) {
      installBtn.hidden = true;
    }
  });
}

function updateObsPairingLinks() {
  const tokenParam = state.clientToken ? `&token=${encodeURIComponent(state.clientToken)}` : "";
  const basePath = window.location.pathname || "/";
  const obsPath = `${basePath}?view=display${tokenParam}`;
  const obsFullUrl = `${window.location.origin}${obsPath}`;

  const link = el("obsViewLink");
  if (link) {
    link.href = obsPath;
  }
  const copyInput = el("obsUrlCopyInput");
  if (copyInput) {
    copyInput.value = obsFullUrl;
  }
}

function updateStorageBadgesUI() {
  const gcsBadge = el("storageGcsBadge");
  const fsBadge = el("storageFirestoreBadge");

  if (gcsBadge) {
    if (state.storageInfo.gcs) {
      gcsBadge.textContent = `GCS: gs://${state.storageInfo.gcsBucket}`;
      gcsBadge.classList.add("active");
    } else {
      gcsBadge.textContent = "GCS: Not configured";
      gcsBadge.classList.remove("active");
    }
  }

  if (fsBadge) {
    if (state.storageInfo.firestore) {
      fsBadge.textContent = `Firestore: ${state.storageInfo.firestoreCollection}`;
      fsBadge.classList.add("active");
    } else {
      fsBadge.textContent = "Firestore: Not configured";
      fsBadge.classList.remove("active");
    }
  }
}

function resolveEffectiveApiKey() {
  const manualKey = (state.settings.apiKey || "").trim();
  if (manualKey) return manualKey;
  return (state.serverEnvApiKey || "").trim();
}

function applyVisualSettings() {
  const scale = Math.max(70, Math.min(200, Number(state.settings.fontScale) || 100)) / 100;
  document.documentElement.style.setProperty("--transcript-scale", String(scale));
  document.body.classList.toggle("layout-stacked", state.settings.layoutMode === "stacked");

  if (el("fontScaleRange")) el("fontScaleRange").value = String(state.settings.fontScale);
  if (el("fontScaleOut")) el("fontScaleOut").textContent = `${state.settings.fontScale}%`;
  if (el("layoutToggleLabel")) {
    el("layoutToggleLabel").textContent =
      state.settings.layoutMode === "stacked" ? "Stacked" : "Side-by-Side";
  }
  if (el("obsModeSelect")) {
    el("obsModeSelect").value = state.settings.obsMode || "auto";
  }
  if (el("apiKeyInput")) el("apiKeyInput").value = state.settings.apiKey || "";
  if (el("modelSelect")) el("modelSelect").value = state.settings.model || DEFAULT_MODEL;
  if (el("lineInModeCheck")) el("lineInModeCheck").checked = !!state.settings.lineInMode;
  if (el("silenceGateCheck")) el("silenceGateCheck").checked = state.settings.silenceGate !== false;
  if (el("ttsAudioCheck")) el("ttsAudioCheck").checked = !!state.settings.ttsAudio;
  if (el("eventContextInput")) el("eventContextInput").value = state.settings.eventContext || "";
  if (el("glossaryInput")) el("glossaryInput").value = state.settings.glossaryText || "";

  const currentSpeakerLang = state.settings.speakerLang || "th";
  document.querySelectorAll("[data-speaker-lang]").forEach((btn) => {
    const active = btn.getAttribute("data-speaker-lang") === currentSpeakerLang;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
}

function bindUI() {
  el("startStopBtn")?.addEventListener("click", () => {
    if (state.running) stopSession();
    else startSession();
  });

  el("micToggleBtn")?.addEventListener("click", () => toggleMicMute());

  // Keyboard shortcut: 'M' toggles Mic On/Off when not focused in a text input
  window.addEventListener("keydown", (ev) => {
    if (isDisplayMode) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (ev.key === "m" || ev.key === "M") {
      ev.preventDefault();
      toggleMicMute();
    }
  });

  el("refreshDevicesBtn")?.addEventListener("click", () => populateAudioDevices(true));

  el("audioSourceSelect")?.addEventListener("change", async (ev) => {
    saveSettings({ audioSource: ev.target.value });
    if (state.running) {
      await switchAudioSourceMidSession();
      syncWebSpeechPreview();
    }
  });

  document.querySelectorAll("[data-speaker-lang]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lang = btn.getAttribute("data-speaker-lang") || "th";
      saveSettings({ speakerLang: lang });
      if (lang === "th" || lang === "en") {
        state.speechRecLang = lang;
      }
      applyVisualSettings();
      if (state.running) {
        if (state.sessionLoop) {
          const glossary = parseGlossaryText(state.settings.glossaryText);
          state.sessionLoop.setup = buildSetup({
            model: state.activeModel || state.settings.model || DEFAULT_MODEL,
            speakerLang: lang,
            glossary,
            eventContext: state.settings.eventContext,
          });
        }
        syncWebSpeechPreview();
      }
      renderCurrentTurn();
      renderObsStage();
      broadcastSnapshot();
    });
  });

  el("layoutToggleBtn")?.addEventListener("click", () => {
    const next = state.settings.layoutMode === "stacked" ? "side-by-side" : "stacked";
    saveSettings({ layoutMode: next });
    applyVisualSettings();
    broadcastSnapshot();
  });

  el("obsModeSelect")?.addEventListener("change", (ev) => {
    saveSettings({ obsMode: ev.target.value });
    renderObsStage();
    broadcastSnapshot();
  });

  el("copyObsUrlBtn")?.addEventListener("click", async () => {
    const input = el("obsUrlCopyInput");
    if (!input) return;
    try {
      await navigator.clipboard.writeText(input.value);
      const btn = el("copyObsUrlBtn");
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = prev;
        }, 1500);
      }
    } catch {
      input.select();
    }
  });

  el("closeErrorBtn")?.addEventListener("click", () => hideError());

  // Settings inputs
  el("apiKeyInput")?.addEventListener("input", (ev) => {
    saveSettings({ apiKey: ev.target.value.trim() });
    if (resolveEffectiveApiKey()) hideError();
  });

  el("toggleKeyVisBtn")?.addEventListener("click", () => {
    const input = el("apiKeyInput");
    if (!input) return;
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";
    el("toggleKeyVisBtn").textContent = isPassword ? "Hide" : "Show";
  });

  el("modelSelect")?.addEventListener("change", (ev) => {
    saveSettings({ model: ev.target.value });
    state.activeModel = ev.target.value;
    renderUsageMetrics();
    renderObsStage();
    broadcastSnapshot();
  });

  el("fontScaleRange")?.addEventListener("input", (ev) => {
    saveSettings({ fontScale: Number(ev.target.value) });
    applyVisualSettings();
    renderObsStage();
    broadcastSnapshot();
  });

  el("lineInModeCheck")?.addEventListener("change", async (ev) => {
    saveSettings({ lineInMode: ev.target.checked });
    if (state.running && state.settings.audioSource !== "__tab__") {
      await switchAudioSourceMidSession();
    }
  });

  el("silenceGateCheck")?.addEventListener("change", (ev) => {
    saveSettings({ silenceGate: ev.target.checked });
    if (!ev.target.checked && state.silenceGated) {
      state.silenceGated = false;
      renderControlState();
    }
  });

  el("ttsAudioCheck")?.addEventListener("change", (ev) => {
    saveSettings({ ttsAudio: ev.target.checked });
    if (!ev.target.checked && state.playerNode) {
      state.playerNode.port.postMessage({ command: "endOfAudio" });
    }
  });

  el("eventContextInput")?.addEventListener("change", (ev) => {
    saveSettings({ eventContext: ev.target.value });
  });

  el("glossaryInput")?.addEventListener("change", (ev) => {
    saveSettings({ glossaryText: ev.target.value });
  });

  el("demoTurnBtn")?.addEventListener("click", () => insertSampleTurn());
  el("clearHistoryBtn")?.addEventListener("click", () => clearHistory());
  el("exportTranscriptBtn")?.addEventListener("click", () => exportTranscriptTxt());
  el("exportSrtBtn")?.addEventListener("click", () => exportCurrentSessionSrt());

  // Past Sessions & .SRT Popover controls
  el("sessionsBtn")?.addEventListener("click", () => {
    refreshPastSessionsList();
  });
  el("refreshSessionsBtn")?.addEventListener("click", () => {
    refreshPastSessionsList();
  });
  el("srtLangFilterSelect")?.addEventListener("change", () => {
    renderSelectedPastSessionDetail();
  });
  el("copySrtBtn")?.addEventListener("click", async () => {
    const preview = el("srtPreviewBox");
    if (!preview || !preview.textContent) return;
    try {
      await navigator.clipboard.writeText(preview.textContent);
      const btn = el("copySrtBtn");
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = prev;
        }, 1500);
      }
    } catch {
      // Ignore clipboard error
    }
  });
  el("loadSessionToStageBtn")?.addEventListener("click", () => {
    if (!state.selectedPastSession || !Array.isArray(state.selectedPastSession.turns)) return;
    state.sessionId = state.selectedPastSession.sessionId;
    state.sessionStartEpochMs = state.selectedPastSession.startedAtEpochMs || Date.now();
    state.historyTurns = [...state.selectedPastSession.turns];
    renderHistory();
    renderCurrentTurn();
    renderObsStage();
    broadcastSnapshot();
    el("sessionsPopover")?.hidePopover?.();
  });

  // Scroll tracking on history section
  const scroller = el("historyScroller");
  scroller?.addEventListener("scroll", () => {
    const distanceFromBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    state.userScrolledUp = distanceFromBottom > 80;
    const jumpBtn = el("jumpLiveBtn");
    if (jumpBtn) jumpBtn.hidden = !state.userScrolledUp;
  });

  el("jumpLiveBtn")?.addEventListener("click", () => {
    state.userScrolledUp = false;
    el("jumpLiveBtn").hidden = true;
    scrollToBottom(true);
  });
}

/**
 * Populate the Audio Input / Line-In selector.
 * Supports physical Microphones, Line-In audio interfaces (for OBS / Soundboards),
 * Virtual Audio Cables, and Browser Tab / System Audio capture.
 */
async function populateAudioDevices(requestPermissionFirst = false) {
  const select = el("audioSourceSelect");
  if (!select || !navigator.mediaDevices?.enumerateDevices) return;

  if (requestPermissionFirst) {
    try {
      const temp = await navigator.mediaDevices.getUserMedia({ audio: true });
      temp.getTracks().forEach((t) => t.stop());
    } catch {
      // Ignore if permission denied
    }
  }

  let devices = [];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    devices = all.filter((d) => d.kind === "audioinput");
  } catch {
    return;
  }

  const currentVal = state.settings.audioSource || "";
  select.innerHTML = "";

  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "🎤 Default Microphone / Line-In";
  select.appendChild(defaultOpt);

  devices.forEach((dev, idx) => {
    if (!dev.deviceId || dev.deviceId === "default") return;
    const opt = document.createElement("option");
    opt.value = dev.deviceId;
    const label = dev.label || `Audio Input / Line-In #${idx + 1}`;
    const isLineOrVirtual = /line|mixer|cable|virtual|blackhole|obs|usb|interface|monitor/i.test(
      label
    );
    opt.textContent = `${isLineOrVirtual ? "🎛️" : "🎤"} ${label}`;
    select.appendChild(opt);
  });

  const tabOpt = document.createElement("option");
  tabOpt.value = "__tab__";
  tabOpt.textContent = "🌐 Browser Tab / System Audio (OBS / Web)";
  select.appendChild(tabOpt);

  const exists = [...select.options].some((o) => o.value === currentVal);
  select.value = exists ? currentVal : "";
}

/**
 * Build `getUserMedia` constraints for either a standard room Microphone or
 * a clean Line-In / Mixer feed (for OBS / soundboards).
 */
function buildAudioConstraints(deviceId, lineInMode) {
  const audio = {
    channelCount: 1,
    echoCancellation: !lineInMode,
    noiseSuppression: !lineInMode,
    autoGainControl: false, // Keep speaker dynamics natural as in Interpretab
  };
  if (deviceId) {
    audio.deviceId = { exact: deviceId };
  }
  return { audio };
}

/**
 * Acquire the selected audio stream (Microphone, Line-In, or Browser Tab / System Audio).
 */
async function acquireAudioStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const httpsPort = Number(window.location.port || 3000) === 3000 ? 3443 : window.location.port;
    const httpsUrl = `https://${window.location.hostname}:${httpsPort}${window.location.pathname}${window.location.search}`;
    throw new Error(
      `Browser security blocks Microphone/Line-In on plain HTTP (${window.location.origin}). ` +
        `Open http://localhost:${window.location.port || 3000} (on this machine) or ${httpsUrl} (over LAN HTTPS).`
    );
  }

  const source = state.settings.audioSource || "";
  if (source === "__tab__") {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Browser Tab / System Audio capture is not supported in this browser.");
    }
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const audioTracks = displayStream.getAudioTracks();
    if (!audioTracks.length) {
      displayStream.getTracks().forEach((t) => t.stop());
      throw new Error(
        'No audio track was shared. Please check "Share tab audio" or "Share system audio" in the browser prompt.'
      );
    }
    // Stop unneeded video tracks immediately so only audio is processed
    displayStream.getVideoTracks().forEach((t) => t.stop());
    return new MediaStream(audioTracks);
  }

  try {
    return await navigator.mediaDevices.getUserMedia(
      buildAudioConstraints(source, state.settings.lineInMode)
    );
  } catch (err) {
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      throw new Error(
        "Microphone / Line-In permission was denied. Please allow microphone access in your browser address bar."
      );
    }
    if (source) {
      // Selected device was unplugged; fall back to default input and notify
      showMicWarning(
        "Selected audio input device was unavailable; switched to the system default input."
      );
      saveSettings({ audioSource: "" });
      if (el("audioSourceSelect")) el("audioSourceSelect").value = "";
      return await navigator.mediaDevices.getUserMedia(
        buildAudioConstraints("", state.settings.lineInMode)
      );
    }
    throw err;
  }
}

async function ensureAudioContexts() {
  if (!state.ctxUp) {
    state.ctxUp = new AudioContext({ sampleRate: UPLINK_RATE });
    if (state.ctxUp.audioWorklet?.addModule) {
      try {
        const recUrl = new URL("./audio/pcm-recorder-processor.js", window.location.href).href;
        await state.ctxUp.audioWorklet.addModule(recUrl);
        state.workletUpReady = true;
      } catch {
        state.workletUpReady = false;
      }
    }
  }
  if (!state.ctxDown) {
    state.ctxDown = new AudioContext({ sampleRate: DOWNLINK_RATE });
    if (state.ctxDown.audioWorklet?.addModule) {
      try {
        const playUrl = new URL("./audio/pcm-player-processor.js", window.location.href).href;
        await state.ctxDown.audioWorklet.addModule(playUrl);
        state.workletDownReady = true;
      } catch {
        state.workletDownReady = false;
      }
    }
  }
  if (state.ctxUp.state === "suspended") await state.ctxUp.resume();
  if (state.ctxDown.state === "suspended") await state.ctxDown.resume();
}

function createPlayerNode(ctx) {
  if (state.workletDownReady && typeof AudioWorkletNode !== "undefined") {
    const node = new AudioWorkletNode(ctx, "pcm-player-processor");
    node.connect(ctx.destination);
    return node;
  }

  // Fallback ring-buffer player when AudioWorklet is unavailable
  const bufferSize = DOWNLINK_RATE * 180;
  const ring = new Float32Array(bufferSize);
  let writeIdx = 0;
  let readIdx = 0;
  const scriptNode = ctx.createScriptProcessor(1024, 1, 1);
  scriptNode.onaudioprocess = (ev) => {
    const out = ev.outputBuffer.getChannelData(0);
    for (let i = 0; i < out.length; i++) {
      if (readIdx !== writeIdx) {
        out[i] = ring[readIdx];
        readIdx = (readIdx + 1) % bufferSize;
      } else {
        out[i] = 0;
      }
    }
  };
  scriptNode.connect(ctx.destination);
  return {
    port: {
      postMessage(data) {
        if (data?.command === "endOfAudio") {
          readIdx = writeIdx;
          return;
        }
        const int16 = new Int16Array(data);
        for (let i = 0; i < int16.length; i++) {
          ring[writeIdx] = int16[i] / 32768;
          writeIdx = (writeIdx + 1) % bufferSize;
          if (writeIdx === readIdx) readIdx = (readIdx + 1) % bufferSize;
        }
      },
    },
    disconnect() {
      scriptNode.onaudioprocess = null;
      scriptNode.disconnect();
    },
  };
}

/**
 * Start the Gemini Live transcription & Thai ⇄ English translation session.
 */
async function startSession() {
  hideError();
  hideMicWarning();

  const apiKey = resolveEffectiveApiKey();
  const startBtn = el("startStopBtn");
  if (startBtn) startBtn.disabled = true;

  // Fallback to On-Device Browser AI Mode (Web Speech API + Browser Translation) when Gemini API Key is missing
  if (!apiKey) {
    try {
      await ensureAudioContexts();
      state.mediaStream = await acquireAudioStream();
      await populateAudioDevices(false);

      state.browserAiMode = true;
      state.activeModel = "browser-ai (web-speech)";
      state.usage = emptyUsage();
      state.startedAt = performance.now();
      state.sessionId = createNewSessionId();
      state.sessionStartEpochMs = Date.now();
      state.silenceGated = false;
      state.lastSoundAt = performance.now();
      state.prerollFrames = [];

      wireAudioStreamToSession(state.mediaStream);
      state.running = true;
      syncWebSpeechPreview();
      startClockTimer();
      setStatus("connected", "Browser AI (No API Key)");
      renderControlState();
      renderUsageMetrics();
      renderObsStage();
      broadcastSnapshot();
    } catch (err) {
      await stopSession({ preserveError: true });
      showError(err?.message || String(err));
    } finally {
      if (startBtn) startBtn.disabled = false;
    }
    return;
  }

  state.browserAiMode = false;
  setStatus("connecting", "Verifying API Key...");

  try {
    const check = await preflight(apiKey);
    if (check.fatal) {
      throw new Error(check.detail);
    }

    await ensureAudioContexts();
    state.mediaStream = await acquireAudioStream();
    await populateAudioDevices(false);

    const glossary = parseGlossaryText(state.settings.glossaryText);
    const preferredModel = state.settings.model || DEFAULT_MODEL;
    const models = [
      preferredModel,
      ...CANDIDATE_MODELS.filter((m) => m !== preferredModel),
    ];

    state.activeModel = models[0];
    state.usage = emptyUsage();
    state.startedAt = performance.now();
    state.sessionId = createNewSessionId();
    state.sessionStartEpochMs = Date.now();
    state.silenceGated = false;
    state.lastSoundAt = performance.now();
    state.prerollFrames = [];

    const setup = buildSetup({
      model: state.activeModel,
      speakerLang: state.settings.speakerLang || "th",
      glossary,
      eventContext: state.settings.eventContext,
    });

    state.playerNode = createPlayerNode(state.ctxDown);

    state.sessionLoop = new SessionLoop({
      apiKey,
      setup,
      closeHint: check.ok ? "Your API key was accepted." : "",
      models,
      onModel: (model) => {
        state.activeModel = model;
        renderUsageMetrics();
      },
      onStatus: (status, detail) => {
        handleSessionStatus(status, detail);
      },
      onEvent: (ev) => {
        handleLiveEvent(ev);
      },
    });

    wireAudioStreamToSession(state.mediaStream);
    state.sessionLoop.start();

    state.running = true;
    syncWebSpeechPreview();
    startClockTimer();
    renderControlState();
    renderUsageMetrics();
    renderObsStage();
    broadcastSnapshot();
  } catch (err) {
    await stopSession({ preserveError: true });
    showError(err?.message || String(err));
  } finally {
    if (startBtn) startBtn.disabled = false;
  }
}

/**
 * Connect the active `MediaStream` to the 16 kHz `pcm-recorder-processor` worklet,
 * applying both the manual **Mic Off** gate and the automatic **Smart Silence Gate**.
 */
function wireAudioStreamToSession(stream) {
  if (state.recorderNode) {
    if (state.recorderNode.port) state.recorderNode.port.onmessage = null;
    state.recorderNode.onaudioprocess = null;
    state.recorderNode.disconnect();
  }

  state.lastSoundAt = performance.now();
  state.prerollFrames = [];
  watchOpeningMicSilence(stream);

  const onSamples = (floatSamples) => {
    const frameSeconds = floatSamples.length / UPLINK_RATE;
    const peak = measurePeakAndMeter(floatSamples);
    const now = performance.now();

    if (peak >= SILENCE_FLOOR) {
      state.lastSoundAt = now;
      if (!state.micEverHeardSound) {
        state.micEverHeardSound = true;
        clearInterval(state.micWarnTimer);
        state.micWarnTimer = null;
        hideMicWarning();
      }
    }

    // 1. Manual Mic OFF: Drop frames immediately and count saved tokens/cost.
    if (state.micMuted) {
      noteAudioSaved(state.usage, frameSeconds);
      return;
    }

    const pcmBuffer = floatToPcm16(floatSamples);

    // 2. Smart Silence Gate: If line-in/mic is silent for > 1.5s, pause uplink stream
    //    and hold a 350ms circular pre-roll buffer in memory.
    if (state.settings.silenceGate !== false) {
      const silentDuration = now - state.lastSoundAt;

      if (silentDuration >= SILENCE_HOLD_MS) {
        if (!state.silenceGated) {
          state.silenceGated = true;
          state.sessionLoop?.sendAudioStreamEnd();
          renderControlState();
        }
        state.prerollFrames.push(pcmBuffer);
        if (state.prerollFrames.length > PREROLL_MAX_FRAMES) {
          state.prerollFrames.shift();
        }
        noteAudioSaved(state.usage, frameSeconds);
        return;
      }

      // Speech resumed after Silence Gate: flush 350ms pre-roll first so no syllable is clipped
      if (state.silenceGated) {
        state.silenceGated = false;
        for (const buffered of state.prerollFrames) {
          state.sessionLoop?.send(buffered);
          noteAudioIn(state.usage, buffered.byteLength / 2 / UPLINK_RATE);
        }
        state.prerollFrames = [];
        renderControlState();
      }
    }

    // 3. Active speech: stream PCM16 to Gemini Live API and count input audio tokens
    if (!state.browserAiMode) {
      state.sessionLoop?.send(pcmBuffer);
      noteAudioIn(state.usage, frameSeconds);
    }
  };

  const sourceNode = state.ctxUp.createMediaStreamSource(stream);

  if (state.workletUpReady && typeof AudioWorkletNode !== "undefined") {
    const node = new AudioWorkletNode(state.ctxUp, "pcm-recorder-processor", {
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    node.port.onmessage = (event) => onSamples(event.data);
    sourceNode.connect(node);
    state.recorderNode = node;
  } else {
    // Fallback ScriptProcessorNode when AudioWorklet is unavailable
    const scriptNode = state.ctxUp.createScriptProcessor(512, 1, 1);
    scriptNode.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      onSamples(new Float32Array(input));
    };
    sourceNode.connect(scriptNode);
    scriptNode.connect(state.ctxUp.destination);
    state.recorderNode = scriptNode;
  }

  // If user shared a browser tab and clicks "Stop sharing" in Chrome's bar, handle cleanly
  const track = stream.getAudioTracks()[0];
  if (track) {
    track.onended = () => {
      if (state.running) {
        stopSession();
      }
    };
  }
}

/**
 * Switch between Mic / Line-In devices while a session is already running.
 */
async function switchAudioSourceMidSession() {
  if (!state.running) return;
  try {
    const newStream = await acquireAudioStream();
    state.mediaStream?.getTracks().forEach((t) => t.stop());
    state.mediaStream = newStream;
    wireAudioStreamToSession(newStream);
    hideMicWarning();
  } catch (err) {
    showError(err?.message || String(err));
  }
}

/**
 * Toggle Microphone / Line-In Mute.
 * When Mic is turned OFF:
 * - Immediately stops sending audio frames to Gemini Live API to save money/tokens.
 * - Sends `audioStreamEnd: true` (Hybrid VAD) to finalize any open turn.
 */
function toggleMicMute(forceState) {
  const nextMuted = typeof forceState === "boolean" ? forceState : !state.micMuted;
  state.micMuted = nextMuted;

  if (state.micMuted) {
    state.prerollFrames = [];
    state.sessionLoop?.sendAudioStreamEnd();
    updateMeterUI(0);
  } else {
    state.lastSoundAt = performance.now();
    state.silenceGated = false;
  }

  syncWebSpeechPreview();
  renderControlState();
  broadcastSnapshot();
}

/**
 * Local Web Speech API (`webkitSpeechRecognition` / `SpeechRecognition`) instant interim preview.
 * - Active when `speakerLang` is `"th"` (`th-TH`) or `"en"` (`en-US`) and the default mic is active.
 * - Shows instant streaming words in the latest turn (`isLocalPreview: true`) before Gemini Live
 *   finishes transcribing, and is immediately replaced as soon as Gemini Live's `input` arrives.
 */
/**
 * Translate text in the browser when running in Browser AI Fallback Mode (no Gemini API key):
 * 1. First tries Chrome's On-Device `window.Translator` / `window.translation` API (offline capable).
 * 2. Falls back to the lightweight browser translation endpoint (`translate.googleapis.com/translate_a/single`).
 */
async function translateWithBrowserAi(text, sourceLang, targetLang) {
  const clean = cleanTranscriptSpacing(text);
  if (!clean) return "";

  const pairKey = `${sourceLang}->${targetLang}`;

  // 1. Try Chrome Built-in On-Device Translator API (`window.Translator` or `self.translation`)
  try {
    const TranslatorClass =
      window.Translator || self.Translator || window.translation?.createTranslator;
    if (TranslatorClass) {
      if (!state.browserTranslators[pairKey]) {
        if (typeof window.Translator?.create === "function") {
          state.browserTranslators[pairKey] = await window.Translator.create({
            sourceLanguage: sourceLang,
            targetLanguage: targetLang,
          });
        } else if (typeof window.translation?.createTranslator === "function") {
          state.browserTranslators[pairKey] = await window.translation.createTranslator({
            sourceLanguage: sourceLang,
            targetLanguage: targetLang,
          });
        }
      }
      const translator = state.browserTranslators[pairKey];
      if (translator && typeof translator.translate === "function") {
        const out = await translator.translate(clean);
        if (out) return cleanTranscriptSpacing(out);
      }
    }
  } catch {
    // Fall through to browser fetch translation
  }

  // 2. Fallback to lightweight browser translation endpoint
  try {
    const url =
      `https://translate.googleapis.com/translate_a/single?client=gtx` +
      `&sl=${encodeURIComponent(sourceLang)}&tl=${encodeURIComponent(targetLang)}` +
      `&dt=t&q=${encodeURIComponent(clean)}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.[0])) {
        const joined = data[0].map((part) => part?.[0] || "").join("");
        return cleanTranscriptSpacing(joined);
      }
    }
  } catch {
    // Ignore offline error
  }

  return "";
}

function stopWebSpeechPreview() {
  if (!state.speechRec) return;
  const rec = state.speechRec;
  state.speechRec = null;
  rec.onresult = null;
  rec.onend = null;
  rec.onerror = null;
  try {
    rec.stop();
  } catch {
    // Ignore
  }
}

function syncWebSpeechPreview() {
  stopWebSpeechPreview();

  if (isDisplayMode || !state.running || state.micMuted) return;
  if (state.settings.audioSource === "__tab__") return;

  // Use the selected Speaker Language (defaults to Thai "th-TH"); never auto-switch on English jargon
  const speakerLang = state.settings.speakerLang || "th";
  const activeRecLang = speakerLang === "en" ? "en" : "th";
  state.speechRecLang = activeRecLang;

  const SpeechRecognitionClass =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionClass) return;

  try {
    const rec = new SpeechRecognitionClass();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = activeRecLang === "en" ? "en-US" : "th-TH";

    rec.onresult = async (event) => {
      if (!state.running || state.micMuted) return;
      // When Gemini Live is active, ONLY show Web Speech API as an instant streaming preview
      // while speaking; the moment Gemini Live's input/output arrives, Gemini overwrites it.
      if (!state.browserAiMode && state.currentTurn.geminiInputStarted) return;

      let interimText = "";
      let hasFinalResult = false;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        interimText += event.results[i][0]?.transcript || "";
        if (event.results[i].isFinal) {
          hasFinalResult = true;
        }
      }
      const cleaned = cleanTranscriptSpacing(interimText);
      if (!cleaned) return;

      // Keep the selected main speaker language throughout the session; never flip on English technical jargon
      const srcLang = activeRecLang;
      const tgtLang = srcLang === "th" ? "en" : "th";

      if (!state.currentTurn.startedAt) {
        state.currentTurn.startedAt = new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        state.currentTurn.epochMs = Date.now();
      }

      state.currentTurn.input = cleaned;
      state.currentTurn.isLocalPreview = !state.browserAiMode;
      state.currentTurn.sourceLang = srcLang;
      state.currentTurn.targetLang = tgtLang;

      renderCurrentTurn();
      renderObsStage();
      broadcastSnapshot();

      // In Browser AI Mode (no Gemini API key), also translate in the browser and commit finalized phrases
      if (state.browserAiMode) {
        const seq = ++state.browserTranslateSeq;
        const translated = await translateWithBrowserAi(cleaned, srcLang, tgtLang);
        if (seq === state.browserTranslateSeq && state.running && state.browserAiMode) {
          state.currentTurn.output = translated;
          renderCurrentTurn();
          renderObsStage();
          broadcastSnapshot();
        }

        clearTimeout(state.turnIdleTimer);
        if (hasFinalResult) {
          state.turnIdleTimer = setTimeout(() => {
            if (state.running && state.browserAiMode && state.currentTurn.input.trim()) {
              finalizeCurrentTurn();
            }
          }, 600);
        } else {
          state.turnIdleTimer = setTimeout(() => {
            if (state.running && state.browserAiMode && state.currentTurn.input.trim()) {
              finalizeCurrentTurn();
            }
          }, 2600);
        }
      }
    };

    rec.onerror = () => {
      // Ignore transient no-speech / aborted errors
    };

    rec.onend = () => {
      if (state.speechRec === rec && state.running && !state.micMuted) {
        try {
          rec.start();
        } catch {
          // Ignore restart race
        }
      }
    };

    state.speechRec = rec;
    rec.start();
  } catch {
    // Ignore if browser blocks SpeechRecognition
  }
}

/**
 * Watch the first 8 seconds of a session to warn if the selected Mic / Line-In
 * device is carrying complete silence (ported from Interpretab).
 */
function watchOpeningMicSilence(stream) {
  clearInterval(state.micWarnTimer);
  state.micEverHeardSound = false;
  const label = stream.getAudioTracks()[0]?.label || "Selected Audio Input";
  const openedAt = performance.now();

  state.micWarnTimer = setInterval(() => {
    if (!state.running || state.micEverHeardSound) {
      clearInterval(state.micWarnTimer);
      state.micWarnTimer = null;
      return;
    }
    if (state.micMuted) return;
    if (performance.now() - openedAt >= MIC_DEAD_WARN_MS) {
      clearInterval(state.micWarnTimer);
      state.micWarnTimer = null;
      showMicWarning(
        `No audio signal detected from "${label}" yet. If using OBS or a Mixer Line-In, check the Audio Input selector above.`
      );
    }
  }, 1000);
}

/**
 * Stop the active session and release all media tracks and sockets.
 */
async function stopSession({ preserveError = false } = {}) {
  stopWebSpeechPreview();
  clearInterval(state.clockTimer);
  state.clockTimer = null;
  clearInterval(state.micWarnTimer);
  state.micWarnTimer = null;
  clearTimeout(state.turnIdleTimer);
  state.turnIdleTimer = null;

  // Commit any unfinished live turn into history before closing
  if (state.currentTurn.input.trim() || state.currentTurn.output.trim()) {
    finalizeCurrentTurn();
  } else if (state.historyTurns.length > 0) {
    persistCurrentSessionToServer();
  }

  state.sessionLoop?.close();
  state.sessionLoop = null;

  if (state.recorderNode) {
    if (state.recorderNode.port) state.recorderNode.port.onmessage = null;
    state.recorderNode.onaudioprocess = null;
    state.recorderNode.disconnect();
    state.recorderNode = null;
  }

  if (state.playerNode) {
    state.playerNode.disconnect();
    state.playerNode = null;
  }

  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((t) => t.stop());
    state.mediaStream = null;
  }

  state.running = false;
  state.browserAiMode = false;
  state.silenceGated = false;
  state.prerollFrames = [];
  updateMeterUI(0);

  if (!preserveError) {
    setStatus("disconnected", "Idle");
  }
  renderControlState();
  renderUsageMetrics();
  renderObsStage();
  broadcastSnapshot();
}

function handleSessionStatus(status, detail) {
  if (status === "connected") {
    setStatus("connected", "Connected");
  } else if (status === "connecting") {
    setStatus("connecting", "Connecting...");
  } else if (status === "disconnected") {
    setStatus("connecting", detail || "Reconnecting...");
  } else if (status === "error") {
    setStatus("error", detail || "Connection error");
  } else if (status === "failed") {
    showError(detail || "Session disconnected.");
    stopSession({ preserveError: true });
    setStatus("error", "Stopped");
  }
}

/**
 * Process incoming events from Gemini Live (`input`, `output`, `audio`, `turnComplete`, `usage`).
 */
function handleLiveEvent(ev) {
  if (ev.type === "usage") {
    noteServerUsage(state.usage, ev.usage);
    renderUsageMetrics();
    return;
  }

  if (ev.type === "audio") {
    const audioSeconds = ev.buffer.byteLength / 2 / DOWNLINK_RATE;
    noteAudioOut(state.usage, audioSeconds);
    if (state.settings.ttsAudio && state.playerNode) {
      state.playerNode.port.postMessage(ev.buffer);
    }
    renderUsageMetrics();
    return;
  }

  if (ev.type === "turnComplete") {
    finalizeCurrentTurn();
    return;
  }

  if (ev.type === "input" || ev.type === "output") {
    if (!state.currentTurn.startedAt) {
      state.currentTurn.startedAt = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      state.currentTurn.epochMs = Date.now();
    }

    const side = ev.type; // "input" or "output"
    if (side === "input") {
      if (!state.currentTurn.geminiInputStarted) {
        // First real Gemini Live input chunk replaces any local Web Speech API preview
        state.currentTurn.input = "";
        state.currentTurn.geminiInputStarted = true;
        state.currentTurn.isLocalPreview = false;
      }
    }

    // Gemini Live sends incremental deltas in `inputTranscription.text` and `outputTranscription.text`
    // (even when `finished: true` on the final chunk), whereas `interimInputTranscription` is a full-turn hypothesis.
    if (ev.interim) {
      state.currentTurn[side] = cleanTranscriptSpacing(ev.text);
    } else {
      state.currentTurn[side] = cleanTranscriptSpacing(
        state.currentTurn[side] + ev.text
      );
    }

    updateDetectedLanguages(state.currentTurn);
    renderCurrentTurn();
    renderObsStage();
    broadcastSnapshot();

    // Safety fallback timer in case a simultaneous chunk stream pauses without turnComplete
    clearTimeout(state.turnIdleTimer);
    state.turnIdleTimer = setTimeout(() => {
      if (state.currentTurn.input.trim() && state.currentTurn.output.trim()) {
        finalizeCurrentTurn();
      }
    }, 4500);
  }
}

function updateDetectedLanguages(turn) {
  const mainLang = state.settings.speakerLang || "th";

  // If the user selected a main Speaker Language (TH or EN), keep it fixed for the session
  // so English technical jargon inside a Thai talk never flips the turn's language tags.
  if (mainLang === "th" || mainLang === "en") {
    turn.sourceLang = mainLang;
    turn.targetLang = mainLang === "th" ? "en" : "th";
    return;
  }

  const src = detectLanguage(turn.input);
  const tgt = detectLanguage(turn.output);

  if (tgt !== "auto") {
    turn.targetLang = tgt;
    turn.sourceLang = tgt === "th" ? "en" : "th";
  } else if (src !== "auto") {
    turn.sourceLang = src;
    turn.targetLang = src === "th" ? "en" : "th";
  }
}

function finalizeCurrentTurn() {
  clearTimeout(state.turnIdleTimer);
  state.turnIdleTimer = null;

  const input = cleanTranscriptSpacing(state.currentTurn.input);
  const output = cleanTranscriptSpacing(state.currentTurn.output);
  if (!input && !output) {
    state.currentTurn = {
      input: "",
      output: "",
      sourceLang: "auto",
      targetLang: "auto",
      startedAt: null,
      epochMs: null,
      geminiInputStarted: false,
      isLocalPreview: false,
    };
    renderCurrentTurn();
    renderObsStage();
    broadcastSnapshot();
    return;
  }

  state.currentTurn.input = input;
  state.currentTurn.output = output;
  updateDetectedLanguages(state.currentTurn);

  const nowEpoch = Date.now();
  const startEpoch = state.currentTurn.epochMs || nowEpoch - 2500;

  if (!state.sessionId) {
    state.sessionId = createNewSessionId();
    state.sessionStartEpochMs = startEpoch;
  }

  const completed = {
    id: `${nowEpoch}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp:
      state.currentTurn.startedAt ||
      new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    epochMs: startEpoch,
    endEpochMs: Math.max(startEpoch + 1200, nowEpoch),
    input,
    output,
    sourceLang: state.currentTurn.sourceLang === "auto" ? "th" : state.currentTurn.sourceLang,
    targetLang: state.currentTurn.targetLang === "auto" ? "en" : state.currentTurn.targetLang,
  };

  state.historyTurns.push(completed);
  if (state.historyTurns.length > HISTORY_LIMIT) {
    state.historyTurns.shift();
  }

  state.currentTurn = {
    input: "",
    output: "",
    sourceLang: "auto",
    targetLang: "auto",
    startedAt: null,
    epochMs: null,
    geminiInputStarted: false,
    isLocalPreview: false,
  };

  // Restart local Web Speech recognition cleanly for the next utterance so buffer doesn't carry over
  if (state.speechRec) {
    syncWebSpeechPreview();
  }

  appendHistoryCard(completed);
  updateTurnCounter();
  renderCurrentTurn();
  renderObsStage();
  if (!state.userScrolledUp) {
    scrollToBottom();
  }
  broadcastSnapshot();
  persistCurrentSessionToServer();
}

/**
 * Render the compact, simple OBS View (`#obsStage`):
 *
 * Thai
 * (ts.) ...
 * (ts.) ...
 * ----------
 * English
 * (ts.) ...
 * (ts.) ...
 *
 * - Latest line in each language block is rendered in **bold** (`.obs-line.latest`).
 * - Supports **Horizontal** mode (2 lines per language for bottom subtitles)
 *   and **Vertical** mode (up to 10 lines per language for side panels).
 */
function resolveObsLayoutMode() {
  if (urlObsLayout === "horizontal" || urlObsLayout === "vertical") {
    return urlObsLayout;
  }
  const settingMode = state.settings.obsMode || "auto";
  if (settingMode === "horizontal" || settingMode === "vertical") {
    return settingMode;
  }
  // Auto-detect: only use compact horizontal subtitle mode when the window is a short subtitle bar (h <= 340)
  // or ultra-wide banner (w / h >= 2.4). Standard desktop/browser windows use expanded history mode.
  const w = window.innerWidth || 1280;
  const h = window.innerHeight || 720;
  if (h <= 340 || w / h >= 2.4) {
    return "horizontal";
  }
  return "vertical";
}

function renderObsStage() {
  const obsStage = el("obsStage");
  const thaiListEl = el("obsThaiList");
  const engListEl = el("obsEnglishList");
  if (!obsStage || !thaiListEl || !engListEl) return;

  const poweredByEl = el("obsPoweredBy");
  if (poweredByEl) {
    const modelName = state.activeModel || state.settings.model || DEFAULT_MODEL;
    poweredByEl.textContent = `powered by ${modelName}`;
  }

  const mode = resolveObsLayoutMode();
  obsStage.classList.toggle("obs-horizontal", mode === "horizontal");
  obsStage.classList.toggle("obs-vertical", mode === "vertical");

  // Allow up to 40 history turns per language; the layout & scroll/clipping will show as many as fit
  const maxLinesPerLang = mode === "horizontal" ? 15 : 50;

  // Combine finalized history turns + current in-progress live turn (if any)
  const allTurns = [...state.historyTurns];
  const curIn = cleanTranscriptSpacing(state.currentTurn?.input || "");
  const curOut = cleanTranscriptSpacing(state.currentTurn?.output || "");
  if (curIn || curOut) {
    allTurns.push({
      timestamp:
        state.currentTurn.startedAt ||
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      input: curIn,
      output: curOut,
      sourceLang: state.currentTurn.sourceLang,
      targetLang: state.currentTurn.targetLang,
    });
  }

  const thaiItems = [];
  const engItems = [];

  for (const turn of allTurns) {
    const ts = turn.timestamp || "00:00:00";
    const { thai, english } = extractThaiAndEnglish(turn);
    const cleanTh = cleanTranscriptSpacing(thai);
    const cleanEn = cleanTranscriptSpacing(english);
    if (cleanTh) {
      thaiItems.push({ ts, text: cleanTh });
    }
    if (cleanEn) {
      engItems.push({ ts, text: cleanEn });
    }
  }

  const visibleThai = thaiItems.slice(-maxLinesPerLang);
  const visibleEng = engItems.slice(-maxLinesPerLang);

  renderObsLanguageLines(thaiListEl, visibleThai);
  renderObsLanguageLines(engListEl, visibleEng);
}

function renderObsLanguageLines(container, items) {
  container.innerHTML = "";
  if (!items.length) {
    const emptyLine = document.createElement("div");
    emptyLine.className = "obs-line obs-empty";
    emptyLine.textContent = "Waiting for speech...";
    container.appendChild(emptyLine);
    return;
  }

  items.forEach((item, idx) => {
    const isLatest = idx === items.length - 1;
    const row = document.createElement("div");
    row.className = isLatest ? "obs-line latest" : "obs-line";

    const tsSpan = document.createElement("span");
    tsSpan.className = "obs-ts";
    tsSpan.textContent = `(${item.ts})`;

    const textNode = document.createElement(isLatest ? "strong" : "span");
    textNode.className = "obs-text";
    textNode.dir = "auto";
    textNode.textContent = ` ${item.text}`;

    row.appendChild(tsSpan);
    row.appendChild(textNode);
    container.appendChild(row);
  });

  // Automatically scroll to the bottom so the latest message in bold is always prioritized and visible,
  // while allowing all fitting history lines above it to be seen (and scrolled if opened in a window).
  container.scrollTop = container.scrollHeight;
}

function loadBrowserSessions() {
  try {
    const raw = localStorage.getItem(LOCAL_SESSIONS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function saveBrowserSession(record) {
  try {
    const map = loadBrowserSessions();
    map[record.sessionId] = record;
    // Keep most recent 30 sessions in browser localStorage
    const sorted = Object.values(map).sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
    );
    const trimmed = {};
    for (const item of sorted.slice(0, 30)) {
      trimmed[item.sessionId] = item;
    }
    localStorage.setItem(LOCAL_SESSIONS_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Persist the active session's turns to browser localStorage (for GitHub Pages / offline use)
 * and to the backend (`POST /api/sessions`), which writes `.srt` files locally and syncs to
 * Firestore and Google Cloud Storage.
 */
async function persistCurrentSessionToServer() {
  if (isDisplayMode || !state.historyTurns.length) return;
  if (!state.sessionId) {
    state.sessionId = createNewSessionId();
    state.sessionStartEpochMs = state.historyTurns[0]?.epochMs || Date.now();
  }

  const startEpochMs = state.sessionStartEpochMs || Date.now();
  const nowIso = new Date().toISOString();
  const payload = {
    sessionId: state.sessionId,
    title: state.settings.eventContext
      ? state.settings.eventContext.slice(0, 80)
      : `Session ${new Date(startEpochMs).toLocaleString()}`,
    startedAtEpochMs: startEpochMs,
    startEpochMs,
    updatedAt: nowIso,
    turnCount: state.historyTurns.length,
    eventContext: state.settings.eventContext || "",
    turns: state.historyTurns,
  };

  // Always save to browser localStorage so static hosting (e.g. GitHub Pages) supports Past Sessions & SRT download
  saveBrowserSession(payload);

  try {
    const query = state.clientToken ? `?token=${encodeURIComponent(state.clientToken)}` : "";
    await fetch(`/api/sessions${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
  } catch {
    // Running on static host (e.g. GitHub Pages) without server.js backend
  }
}

/**
 * Fetch and render the list of Past Sessions & `.SRT` files for this browser session.
 * Uses `/api/sessions` when running with `server.js` / Cloud Run, or falls back to
 * browser `localStorage` when running as a static site (e.g. GitHub Pages).
 */
async function refreshPastSessionsList() {
  const listEl = el("sessionsList");
  if (!listEl) return;

  try {
    const query = state.clientToken ? `?token=${encodeURIComponent(state.clientToken)}` : "";
    const res = await fetch(`/api/sessions${query}`, { credentials: "same-origin" });
    if (res.ok) {
      const data = await res.json();
      state.pastSessions = Array.isArray(data.sessions) ? data.sessions : [];
      renderPastSessionsList();
      return;
    }
  } catch {
    // Fall back to browser localStorage below
  }

  const localMap = loadBrowserSessions();
  state.pastSessions = Object.values(localMap).sort((a, b) =>
    String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
  );
  renderPastSessionsList();
}

function renderPastSessionsList() {
  const listEl = el("sessionsList");
  if (!listEl) return;
  listEl.innerHTML = "";

  if (!state.pastSessions.length) {
    const empty = document.createElement("div");
    empty.className = "session-detail-empty";
    empty.style.padding = "1.5rem 0.5rem";
    empty.textContent = "No saved sessions yet. Start speaking or click '+ Sample Turn' in Settings.";
    listEl.appendChild(empty);
    return;
  }

  for (const sess of state.pastSessions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      state.selectedPastSession?.sessionId === sess.sessionId
        ? "session-item active"
        : "session-item";

    const titleRow = document.createElement("div");
    titleRow.className = "session-item-title";
    const titleSpan = document.createElement("span");
    titleSpan.textContent = sess.title || sess.sessionId;
    const countSpan = document.createElement("span");
    countSpan.textContent = `${sess.turnCount || 0} turns`;
    titleRow.appendChild(titleSpan);
    titleRow.appendChild(countSpan);

    const metaRow = document.createElement("div");
    metaRow.className = "session-item-meta";
    const dateStr = sess.updatedAt ? new Date(sess.updatedAt).toLocaleString() : "";
    metaRow.textContent = `${sess.sessionId} · ${dateStr}`;

    btn.appendChild(titleRow);
    btn.appendChild(metaRow);

    btn.addEventListener("click", () => {
      selectPastSession(sess.sessionId);
    });

    listEl.appendChild(btn);
  }

  if (!state.selectedPastSession && state.pastSessions.length > 0) {
    selectPastSession(state.pastSessions[0].sessionId);
  }
}

async function selectPastSession(sessionId) {
  try {
    const query = state.clientToken ? `?token=${encodeURIComponent(state.clientToken)}` : "";
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}${query}`, {
      credentials: "same-origin",
    });
    if (res.ok) {
      const data = await res.json();
      state.selectedPastSession = data.session || data;
      renderPastSessionsList();
      renderSelectedPastSessionDetail();
      return;
    }
  } catch {
    // Fall back to browser localStorage below
  }

  const localMap = loadBrowserSessions();
  if (localMap[sessionId]) {
    state.selectedPastSession = localMap[sessionId];
    renderPastSessionsList();
    renderSelectedPastSessionDetail();
  }
}

let activeSrtBlobUrl = null;

function renderSelectedPastSessionDetail() {
  const emptyEl = el("sessionDetailEmpty");
  const contentEl = el("sessionDetailContent");
  const titleEl = el("selectedSessionTitle");
  const metaEl = el("selectedSessionMeta");
  const previewEl = el("srtPreviewBox");
  const downloadBtn = el("downloadSrtLink");
  const langSelect = el("srtLangFilterSelect");

  const sess = state.selectedPastSession;
  if (!sess) {
    if (emptyEl) emptyEl.hidden = false;
    if (contentEl) contentEl.hidden = true;
    return;
  }

  if (emptyEl) emptyEl.hidden = true;
  if (contentEl) contentEl.hidden = false;

  const langMode = langSelect?.value || "combined";
  if (titleEl) titleEl.textContent = sess.title || sess.sessionId;
  if (metaEl) {
    metaEl.textContent = `${sess.turnCount || (sess.turns || []).length} turns`;
  }

  const baseEpoch = sess.startEpochMs || sess.startedAtEpochMs;
  const srtText =
    langMode === "th"
      ? sess.srtThai || sess.srtTh || turnsToSrt(sess.turns || [], "th", baseEpoch)
      : langMode === "en"
      ? sess.srtEnglish || sess.srtEn || turnsToSrt(sess.turns || [], "en", baseEpoch)
      : sess.srtCombined || turnsToSrt(sess.turns || [], "combined", baseEpoch);

  if (previewEl) {
    previewEl.textContent = srtText || "(Empty .srt)";
  }

  if (downloadBtn) {
    if (activeSrtBlobUrl) {
      URL.revokeObjectURL(activeSrtBlobUrl);
      activeSrtBlobUrl = null;
    }
    const blob = new Blob([srtText || ""], { type: "text/plain;charset=utf-8" });
    activeSrtBlobUrl = URL.createObjectURL(blob);
    downloadBtn.href = activeSrtBlobUrl;
    const suffix = langMode === "combined" ? "" : `.${langMode}`;
    downloadBtn.download = `${sess.sessionId}${suffix}.srt`;
  }
}

/**
 * Render the Current / Latest Live Transcription section at the bottom of the screen.
 * When live speech is actively streaming, displays `state.currentTurn`.
 * When between utterances, keeps displaying the latest finalized turn at the bottom of the screen.
 */
function renderCurrentTurn() {
  const liveInput = (state.currentTurn?.input || "").trim();
  const liveOutput = (state.currentTurn?.output || "").trim();
  const isLiveStreaming = Boolean(liveInput || liveOutput);

  const lastHistoryTurn =
    state.historyTurns.length > 0
      ? state.historyTurns[state.historyTurns.length - 1]
      : null;

  const displayTurn = isLiveStreaming
    ? state.currentTurn
    : lastHistoryTurn || state.currentTurn;

  const { input = "", output = "", sourceLang = "auto", targetLang = "auto" } =
    displayTurn || {};

  const inputEl = el("currentInputText");
  const outputEl = el("currentOutputText");
  const pulseEl = el("livePulse");
  const statusLabelEl = el("currentStatusLabel");
  const srcTag = el("currentSourceLangTag");
  const tgtTag = el("currentTargetLangTag");
  const hintEl = el("currentHint");

  if (inputEl) {
    inputEl.textContent = input;
    inputEl.classList.toggle("local-preview", Boolean(isLiveStreaming && state.currentTurn?.isLocalPreview));
  }
  if (outputEl) outputEl.textContent = output;
  if (pulseEl) pulseEl.classList.toggle("active", state.running && !state.micMuted);
  if (statusLabelEl) {
    statusLabelEl.textContent = isLiveStreaming ? "Live" : "Latest";
  }

  if (sourceLang === "en" || targetLang === "th") {
    if (srcTag) {
      srcTag.textContent = "EN";
      srcTag.className = "lang-tag en";
    }
    if (tgtTag) {
      tgtTag.textContent = "TH";
      tgtTag.className = "lang-tag th";
    }
  } else {
    if (srcTag) {
      srcTag.textContent = "TH";
      srcTag.className = "lang-tag th";
    }
    if (tgtTag) {
      tgtTag.textContent = "EN";
      tgtTag.className = "lang-tag en";
    }
  }

  if (hintEl) {
    if (!state.running) {
      hintEl.textContent = "Session idle";
    } else if (state.micMuted) {
      hintEl.textContent = "Mic OFF · Paused";
    } else if (state.browserAiMode) {
      hintEl.textContent = "⚠ Using Browser AI (No Gemini API Key)";
    } else if (state.silenceGated && !isLiveStreaming) {
      hintEl.textContent = "Silence Gate · Paused";
    } else if (isLiveStreaming) {
      hintEl.textContent = "Streaming live...";
    } else {
      hintEl.textContent = "Listening...";
    }
  }
}

/**
 * Render the full History list.
 */
function renderHistory() {
  const listEl = el("historyList");
  if (!listEl) return;
  listEl.innerHTML = "";
  for (const turn of state.historyTurns) {
    appendHistoryCard(turn);
  }
  updateTurnCounter();
  if (!state.userScrolledUp) {
    scrollToBottom(false);
  }
}

function appendHistoryCard(turn) {
  const listEl = el("historyList");
  const emptyEl = el("emptyState");
  if (!listEl) return;
  if (emptyEl) emptyEl.hidden = true;

  const card = document.createElement("article");
  card.className = "history-card";

  const isSourceEn = turn.sourceLang === "en";
  const srcShort = isSourceEn ? "EN" : "TH";
  const tgtShort = isSourceEn ? "TH" : "EN";

  const grid = document.createElement("div");
  grid.className = "bilingual-grid";

  // Source Inline Row: [TH/EN] text ... timestamp
  const srcCol = document.createElement("div");
  srcCol.className = "transcript-col source-col inline-turn-row";
  const srcBadge = document.createElement("span");
  srcBadge.className = `lang-tag ${isSourceEn ? "en" : "th"}`;
  srcBadge.textContent = srcShort;
  const srcBody = document.createElement("div");
  srcBody.className = "transcript-text";
  srcBody.dir = "auto";
  srcBody.textContent = turn.input || "—";
  srcCol.appendChild(srcBadge);
  srcCol.appendChild(srcBody);

  if (turn.timestamp) {
    const timeSpan = document.createElement("time");
    timeSpan.className = "turn-time";
    timeSpan.textContent = turn.timestamp;
    srcCol.appendChild(timeSpan);
  }

  // Target Inline Row: [EN/TH] translated text
  const tgtCol = document.createElement("div");
  tgtCol.className = "transcript-col target-col inline-turn-row";
  const tgtBadge = document.createElement("span");
  tgtBadge.className = `lang-tag ${isSourceEn ? "th" : "en"}`;
  tgtBadge.textContent = tgtShort;
  const tgtBody = document.createElement("div");
  tgtBody.className = "transcript-text translated-text";
  tgtBody.dir = "auto";
  tgtBody.textContent = turn.output || "—";
  tgtCol.appendChild(tgtBadge);
  tgtCol.appendChild(tgtBody);

  grid.appendChild(srcCol);
  grid.appendChild(tgtCol);

  card.appendChild(grid);
  listEl.appendChild(card);
}

function updateTurnCounter() {
  const count = state.historyTurns.length;
  const counterEl = el("turnCounter");
  const emptyEl = el("emptyState");
  if (counterEl) {
    counterEl.textContent = `${count} ${count === 1 ? "turn" : "turns"}`;
  }
  if (emptyEl) {
    emptyEl.hidden = count > 0;
  }
}

function scrollToBottom(smooth = false) {
  const scroller = el("historyScroller");
  if (!scroller) return;
  requestAnimationFrame(() => {
    scroller.scrollTo({
      top: scroller.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  });
}

/**
 * Update topbar buttons, Mic ON/OFF indicator, and Stream Status badge.
 */
function renderControlState() {
  const startBtn = el("startStopBtn");
  const startLabel = el("startStopLabel");
  const micBtn = el("micToggleBtn");
  const micLabel = el("micToggleLabel");
  const badge = el("streamStateBadge");

  if (startBtn) {
    startBtn.classList.toggle("running", state.running);
  }
  if (startLabel) {
    startLabel.textContent = state.running ? "Stop Session" : "Start Session";
  }

  if (micBtn) {
    micBtn.classList.toggle("muted", state.micMuted);
    micBtn.setAttribute("aria-pressed", String(state.micMuted));
  }
  if (micLabel) {
    micLabel.textContent = state.micMuted ? "Mic OFF" : "Mic ON";
  }

  if (badge) {
    if (!state.running) {
      badge.className = "stream-badge idle";
      badge.textContent = "Stream Idle";
    } else if (state.micMuted) {
      badge.className = "stream-badge paused";
      badge.textContent = "Mic Off · Stream Paused";
    } else if (state.browserAiMode) {
      badge.className = "stream-badge paused";
      badge.textContent = "⚠ Browser AI (No Gemini Key)";
    } else if (state.silenceGated) {
      badge.className = "stream-badge paused";
      badge.textContent = "Silence Gate · Paused";
    } else {
      badge.className = "stream-badge streaming";
      badge.textContent = "Streaming Audio";
    }
  }

  renderCurrentTurn();
}

/**
 * Update the Main Screen Token Pill (NO price on main screen!) and the
 * Cost Estimation Popover details.
 */
function renderUsageMetrics() {
  const elapsedSeconds =
    state.running && state.startedAt > 0
      ? (performance.now() - state.startedAt) / 1000
      : state.usage.inSeconds + state.usage.savedSeconds;

  const metrics = computeUsageMetrics(state.usage, state.activeModel, {
    elapsedSeconds,
  });

  // Main Screen: ONLY elapsed clock and token count (never price)
  if (el("elapsedClock")) {
    el("elapsedClock").textContent = formatClock(elapsedSeconds);
  }
  if (el("mainTokenCount")) {
    el("mainTokenCount").textContent = formatTokenCount(metrics.totalTokens);
  }

  // Cost Estimation Popover (Operator detail view)
  if (el("popTotalTokens")) {
    el("popTotalTokens").textContent = metrics.totalTokens.toLocaleString("en-US");
  }
  if (el("popTokenSplit")) {
    el("popTokenSplit").textContent = `In: ${metrics.inTokens.toLocaleString("en-US")} · Out: ${metrics.outTokens.toLocaleString("en-US")}`;
  }
  if (el("popSavedTokens")) {
    el("popSavedTokens").textContent = metrics.savedTokens.toLocaleString("en-US");
  }
  if (el("popSavedTime")) {
    el("popSavedTime").textContent = `${Math.round(metrics.savedSeconds)}s stream paused`;
  }
  if (el("popCostUSD")) {
    el("popCostUSD").textContent = formatUSD(metrics.costUSD);
  }
  if (el("popHourlyUSD")) {
    el("popHourlyUSD").textContent = `~${formatUSD(metrics.hourlyRateUSD)} / hr`;
  }
  if (el("popCostTHB")) {
    el("popCostTHB").textContent = formatTHB(metrics.costTHB);
  }
  if (el("popHourlyTHB")) {
    el("popHourlyTHB").textContent = `~${formatTHB(metrics.hourlyRateTHB)} / hr`;
  }
  if (el("popModelName")) {
    el("popModelName").textContent = metrics.model;
  }
  if (el("popActiveAudioTime")) {
    el("popActiveAudioTime").textContent = `${metrics.inSeconds.toFixed(1)}s in / ${metrics.outSeconds.toFixed(1)}s out`;
  }
  if (el("popSavedMoney")) {
    el("popSavedMoney").textContent = `${formatUSD(metrics.savedUSD)} (${formatTHB(metrics.savedTHB)})`;
  }
}

function startClockTimer() {
  clearInterval(state.clockTimer);
  state.clockTimer = setInterval(() => {
    renderUsageMetrics();
  }, 1000);
}

function setStatus(cls, text) {
  state.status = cls;
  state.statusDetail = text;
  const dot = el("statusDot");
  const label = el("statusText");
  if (dot) dot.className = `status-dot ${cls}`;
  if (label) label.textContent = text;
}

function showError(msg) {
  if (msg) {
    setStatus("error", msg);
  }
}

function hideError() {}

function showMicWarning() {}

function hideMicWarning() {}

function measurePeakAndMeter(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  state.smoothedLevel = state.smoothedLevel * 0.7 + peak * 0.3;
  const pct = Math.min(100, Math.round(Math.sqrt(state.smoothedLevel) * 180));
  updateMeterUI(state.micMuted ? 0 : pct);
  return peak;
}

function updateMeterUI(percent) {
  const fill = el("micMeterFill");
  if (fill) fill.style.width = `${percent}%`;
}

function floatToPcm16(input) {
  const pcm16 = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    pcm16[i] = s * 0x7fff;
  }
  return pcm16.buffer;
}

/**
 * Sample turn generator for testing layout and OBS Browser Source sync before an event.
 */
const SAMPLE_TURNS = [
  {
    sourceLang: "th",
    targetLang: "en",
    input: "สวัสดีครับทุกท่าน ยินดีต้อนรับเข้าสู่งานสัมมนาเทคโนโลยีประจำปีของเราในวันนี้",
    output: "Hello everyone, and welcome to our annual technology conference today.",
  },
  {
    sourceLang: "en",
    targetLang: "th",
    input: "Thank you for joining us. In this session, we will explore how real-time AI interpretation bridges language barriers.",
    output: "ขอบคุณที่มาร่วมงานกับเรา ในเซสชันนี้เราจะมาสำรวจว่าล่าม AI แบบเรียลไทม์ช่วยทลายกำแพงด้านภาษาได้อย่างไร",
  },
];
let sampleIdx = 0;

function insertSampleTurn() {
  const sample = SAMPLE_TURNS[sampleIdx % SAMPLE_TURNS.length];
  sampleIdx += 1;

  state.currentTurn = {
    input: sample.input,
    output: sample.output,
    sourceLang: sample.sourceLang,
    targetLang: sample.targetLang,
    startedAt: new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    epochMs: Date.now(),
  };
  renderCurrentTurn();
  renderObsStage();
  broadcastSnapshot();

  setTimeout(() => {
    finalizeCurrentTurn();
  }, 900);
}

function clearHistory() {
  state.historyTurns = [];
  state.sessionId = createNewSessionId();
  state.sessionStartEpochMs = Date.now();
  state.currentTurn = {
    input: "",
    output: "",
    sourceLang: "auto",
    targetLang: "auto",
    startedAt: null,
    epochMs: null,
  };
  renderHistory();
  renderCurrentTurn();
  renderObsStage();
  broadcastSnapshot();
}

function exportTranscriptTxt() {
  if (!state.historyTurns.length) return;
  const lines = state.historyTurns.map((t) => {
    const pair = t.sourceLang === "th" ? "TH -> EN" : "EN -> TH";
    return `[${t.timestamp}] (${pair})\nOriginal:    ${t.input}\nTranslation: ${t.output}\n`;
  });
  const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `livetranscribe-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCurrentSessionSrt() {
  if (!state.historyTurns.length) return;
  const srt = turnsToSrt(
    state.historyTurns,
    "combined",
    state.sessionStartEpochMs || state.historyTurns[0]?.epochMs || Date.now()
  );
  const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const fileBase = state.sessionId || `livetranscribe-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
  a.download = `${fileBase}.srt`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Restore the most recent live snapshot from `localStorage` so that opening OBS View (`?view=display`)
 * mid-session (including on static GitHub Pages) immediately displays all existing turns.
 */
function sanitizeTurnsList(turns) {
  if (!Array.isArray(turns)) return [];
  const cleaned = [];
  for (const t of turns) {
    const input = cleanTranscriptSpacing(t?.input || "");
    const output = cleanTranscriptSpacing(t?.output || "");
    if (!input && !output) continue;
    cleaned.push({ ...t, input, output });
  }
  return cleaned;
}

function restoreLiveSnapshotFromLocal() {
  try {
    const raw = localStorage.getItem(LIVE_SNAPSHOT_KEY);
    if (raw) {
      const snap = JSON.parse(raw);
      if (snap?.activeModel) {
        state.activeModel = snap.activeModel;
      }
      if (snap && Array.isArray(snap.historyTurns)) {
        state.historyTurns = sanitizeTurnsList(snap.historyTurns);
      }
      if (snap && snap.currentTurn && isDisplayMode) {
        state.currentTurn = {
          ...snap.currentTurn,
          input: cleanTranscriptSpacing(snap.currentTurn.input || ""),
          output: cleanTranscriptSpacing(snap.currentTurn.output || ""),
        };
      }
      return;
    }
    // Fallback to most recent saved browser session if any
    const sessions = Object.values(loadBrowserSessions()).sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
    );
    if (sessions.length > 0 && Array.isArray(sessions[0].turns)) {
      state.historyTurns = sanitizeTurnsList(sessions[0].turns);
    }
  } catch {
    // Ignore storage errors
  }
}

/**
 * Real-time sync between Operator View and OBS Browser Source / Stage Display (`?view=display`).
 * Uses:
 * 1. `BroadcastChannel` (`livetranscribe_sync` + token-scoped channel) with `request_snapshot` handshake
 * 2. `localStorage` `storage` event (`livetranscribe_live_snapshot_v1`) for instant cross-tab sync
 * 3. `/ws-relay` WebSocket (for OBS Studio CEF Browser Source on Local / Cloud Run)
 */
function setupSyncChannels() {
  const handleChannelMessage = (ev) => {
    const msg = ev.data;
    if (!msg) return;
    if (msg.type === "snapshot" && isDisplayMode) {
      applyRemoteSnapshot(msg);
    } else if (msg.type === "request_snapshot" && !isDisplayMode) {
      broadcastSnapshot();
    }
  };

  if (typeof BroadcastChannel !== "undefined") {
    state.bcGlobal = new BroadcastChannel("livetranscribe_sync");
    state.bcGlobal.onmessage = handleChannelMessage;

    if (state.clientToken) {
      state.bc = new BroadcastChannel(`livetranscribe_sync_${state.clientToken}`);
      state.bc.onmessage = handleChannelMessage;
    }

    if (isDisplayMode) {
      // Immediately ask any open Operator tab for its latest live snapshot
      try {
        state.bcGlobal.postMessage({ type: "request_snapshot" });
        state.bc?.postMessage({ type: "request_snapshot" });
      } catch {
        // Ignore
      }
    }
  }

  // Cross-tab storage listener (works on GitHub Pages and local browsers)
  window.addEventListener("storage", (ev) => {
    if (ev.key === LIVE_SNAPSHOT_KEY && ev.newValue && isDisplayMode) {
      try {
        const snap = JSON.parse(ev.newValue);
        if (snap?.type === "snapshot") {
          applyRemoteSnapshot(snap);
        }
      } catch {
        // Ignore
      }
    }
  });

  connectRelayWebSocket();
}

function connectRelayWebSocket() {
  if (typeof WebSocket === "undefined") return;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const tokenQuery = state.clientToken ? `?token=${encodeURIComponent(state.clientToken)}` : "";
  const wsUrl = `${proto}//${window.location.host}/ws-relay${tokenQuery}`;

  try {
    const ws = new WebSocket(wsUrl);
    state.relayWs = ws;

    ws.onmessage = (ev) => {
      if (!isDisplayMode) return;
      try {
        const data = JSON.parse(ev.data);
        if (data?.type === "snapshot") {
          applyRemoteSnapshot(data);
        }
      } catch {
        // Ignore malformed message
      }
    };

    ws.onclose = () => {
      state.relayWs = null;
      setTimeout(() => connectRelayWebSocket(), 2500);
    };

    ws.onerror = () => {};
  } catch {
    // Running as static file without server.js relay; BroadcastChannel + localStorage still work
  }
}

function broadcastSnapshot() {
  if (isDisplayMode) return;
  const payload = {
    type: "snapshot",
    updatedAt: Date.now(),
    running: state.running,
    micMuted: state.micMuted,
    silenceGated: state.silenceGated,
    activeModel: state.activeModel || state.settings.model || DEFAULT_MODEL,
    fontScale: state.settings.fontScale,
    layoutMode: state.settings.layoutMode,
    obsMode: state.settings.obsMode,
    historyTurns: state.historyTurns.slice(-50),
    currentTurn: state.currentTurn,
  };

  try {
    localStorage.setItem(LIVE_SNAPSHOT_KEY, JSON.stringify(payload));
  } catch {
    // Ignore quota errors
  }

  try {
    state.bcGlobal?.postMessage(payload);
    state.bc?.postMessage(payload);
  } catch {
    // Ignore
  }

  if (state.relayWs?.readyState === WebSocket.OPEN) {
    try {
      state.relayWs.send(JSON.stringify(payload));
    } catch {
      // Ignore
    }
  }
}

function applyRemoteSnapshot(snapshot) {
  state.running = !!snapshot.running;
  state.micMuted = !!snapshot.micMuted;
  state.silenceGated = !!snapshot.silenceGated;

  if (snapshot.activeModel) {
    state.activeModel = snapshot.activeModel;
  }
  if (snapshot.fontScale) {
    state.settings.fontScale = snapshot.fontScale;
  }
  if (snapshot.layoutMode) {
    state.settings.layoutMode = snapshot.layoutMode;
  }
  if (snapshot.obsMode) {
    state.settings.obsMode = snapshot.obsMode;
  }
  applyVisualSettings();

  if (Array.isArray(snapshot.historyTurns)) {
    state.historyTurns = sanitizeTurnsList(snapshot.historyTurns);
    renderHistory();
  }
  if (snapshot.currentTurn) {
    state.currentTurn = {
      ...snapshot.currentTurn,
      input: cleanTranscriptSpacing(snapshot.currentTurn.input || ""),
      output: cleanTranscriptSpacing(snapshot.currentTurn.output || ""),
    };
    renderCurrentTurn();
  }
  renderObsStage();
  if (!state.userScrolledUp) {
    scrollToBottom();
  }
}

init();
