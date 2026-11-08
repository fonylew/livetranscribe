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
const HISTORY_LIMIT = 300;

/** Noise floor & Smart Silence Gate constants */
const SILENCE_FLOOR = 0.0025;
const SILENCE_HOLD_MS = 1500; // Pause stream after 1.5s of silence
const PREROLL_MAX_FRAMES = 44; // ~350ms of 8ms worklet frames kept when silence-gated
const MIC_DEAD_WARN_MS = 8000; // Warn if selected input has zero signal for first 8s

const DEFAULT_SETTINGS = {
  apiKey: "",
  model: DEFAULT_MODEL,
  fontScale: 100,
  layoutMode: "side-by-side", // "side-by-side" | "stacked"
  lineInMode: false,
  silenceGate: true,
  ttsAudio: false,
  audioSource: "",
  eventContext: "",
  glossaryText: "",
};

const params = new URLSearchParams(window.location.search);
const isDisplayMode = params.get("view") === "display" || params.get("obs") === "1";

const state = {
  settings: loadSettings(),
  running: false,
  micMuted: false,
  silenceGated: false,
  activeModel: DEFAULT_MODEL,
  status: "disconnected",
  statusDetail: "Idle",

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
  },
  turnIdleTimer: null,
  userScrolledUp: false,

  // Cross-window / OBS sync channels
  bc: typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("livetranscribe_sync") : null,
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

function init() {
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
  setupSyncChannels();

  if (!isDisplayMode) {
    populateAudioDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", () => populateAudioDevices());
  }

  renderControlState();
  renderUsageMetrics();
  renderCurrentTurn();
  renderHistory();
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
  if (el("apiKeyInput")) el("apiKeyInput").value = state.settings.apiKey || "";
  if (el("modelSelect")) el("modelSelect").value = state.settings.model || DEFAULT_MODEL;
  if (el("lineInModeCheck")) el("lineInModeCheck").checked = !!state.settings.lineInMode;
  if (el("silenceGateCheck")) el("silenceGateCheck").checked = state.settings.silenceGate !== false;
  if (el("ttsAudioCheck")) el("ttsAudioCheck").checked = !!state.settings.ttsAudio;
  if (el("eventContextInput")) el("eventContextInput").value = state.settings.eventContext || "";
  if (el("glossaryInput")) el("glossaryInput").value = state.settings.glossaryText || "";
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
    }
  });

  el("layoutToggleBtn")?.addEventListener("click", () => {
    const next = state.settings.layoutMode === "stacked" ? "side-by-side" : "stacked";
    saveSettings({ layoutMode: next });
    applyVisualSettings();
    broadcastSnapshot();
  });

  el("closeErrorBtn")?.addEventListener("click", () => hideError());

  // Settings inputs
  el("apiKeyInput")?.addEventListener("input", (ev) => {
    saveSettings({ apiKey: ev.target.value.trim() });
    if (state.settings.apiKey) hideError();
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
  });

  el("fontScaleRange")?.addEventListener("input", (ev) => {
    saveSettings({ fontScale: Number(ev.target.value) });
    applyVisualSettings();
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
        await state.ctxUp.audioWorklet.addModule("/audio/pcm-recorder-processor.js");
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
        await state.ctxDown.audioWorklet.addModule("/audio/pcm-player-processor.js");
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

  const apiKey = (state.settings.apiKey || "").trim();
  if (!apiKey) {
    showError("Please enter your Gemini API Key in Settings before starting.");
    el("settingsPopover")?.showPopover?.();
    el("apiKeyInput")?.focus();
    return;
  }

  const startBtn = el("startStopBtn");
  if (startBtn) startBtn.disabled = true;
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
    state.silenceGated = false;
    state.lastSoundAt = performance.now();
    state.prerollFrames = [];

    const setup = buildSetup({
      model: state.activeModel,
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
    startClockTimer();
    renderControlState();
    renderUsageMetrics();
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
    state.sessionLoop?.send(pcmBuffer);
    noteAudioIn(state.usage, frameSeconds);
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

  // If usershared a browser tab and clicks "Stop sharing" in Chrome's bar, handle cleanly
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

  renderControlState();
  broadcastSnapshot();
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
  clearInterval(state.clockTimer);
  state.clockTimer = null;
  clearInterval(state.micWarnTimer);
  state.micWarnTimer = null;
  clearTimeout(state.turnIdleTimer);
  state.turnIdleTimer = null;

  // Commit any unfinished live turn into history before closing
  if (state.currentTurn.input.trim() || state.currentTurn.output.trim()) {
    finalizeCurrentTurn();
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
  state.silenceGated = false;
  state.prerollFrames = [];
  updateMeterUI(0);

  if (!preserveError) {
    setStatus("disconnected", "Idle");
  }
  renderControlState();
  renderUsageMetrics();
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
    }

    const side = ev.type; // "input" or "output"
    if (ev.interim) {
      // Interim hypothesis replaces only when no finalized increment exists yet
      state.currentTurn[side] = cleanTranscriptSpacing(ev.text);
    } else if (ev.finished) {
      state.currentTurn[side] = cleanTranscriptSpacing(ev.text);
    } else {
      state.currentTurn[side] = cleanTranscriptSpacing(
        state.currentTurn[side] + ev.text
      );
    }

    updateDetectedLanguages(state.currentTurn);
    renderCurrentTurn();
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
  const src = detectLanguage(turn.input);
  const tgt = detectLanguage(turn.output);

  if (src !== "auto") {
    turn.sourceLang = src;
    turn.targetLang = tgt !== "auto" ? tgt : src === "th" ? "en" : "th";
  } else if (tgt !== "auto") {
    turn.targetLang = tgt;
    turn.sourceLang = tgt === "th" ? "en" : "th";
  }
}

function finalizeCurrentTurn() {
  clearTimeout(state.turnIdleTimer);
  state.turnIdleTimer = null;

  const input = state.currentTurn.input.trim();
  const output = state.currentTurn.output.trim();
  if (!input && !output) return;

  updateDetectedLanguages(state.currentTurn);

  const completed = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp:
      state.currentTurn.startedAt ||
      new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
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
  };

  appendHistoryCard(completed);
  updateTurnCounter();
  renderCurrentTurn();
  if (!state.userScrolledUp) {
    scrollToBottom();
  }
  broadcastSnapshot();
}

/**
 * Render the Current Live Transcription section at the bottom of the screen.
 */
function renderCurrentTurn() {
  const { input, output, sourceLang, targetLang } = state.currentTurn;
  const hasContent = Boolean(input.trim() || output.trim());

  const inputEl = el("currentInputText");
  const outputEl = el("currentOutputText");
  const pulseEl = el("livePulse");
  const dirPill = el("currentDirectionPill");
  const srcTag = el("currentSourceLangTag");
  const tgtTag = el("currentTargetLangTag");
  const hintEl = el("currentHint");

  if (inputEl) inputEl.textContent = input;
  if (outputEl) outputEl.textContent = output;
  if (pulseEl) pulseEl.classList.toggle("active", state.running && !state.micMuted);

  if (sourceLang === "th" || targetLang === "en") {
    if (dirPill) dirPill.textContent = "TH → EN";
    if (srcTag) {
      srcTag.textContent = "TH (ไทย)";
      srcTag.className = "lang-tag th";
    }
    if (tgtTag) {
      tgtTag.textContent = "EN (English)";
      tgtTag.className = "lang-tag en";
    }
  } else if (sourceLang === "en" || targetLang === "th") {
    if (dirPill) dirPill.textContent = "EN → TH";
    if (srcTag) {
      srcTag.textContent = "EN (English)";
      srcTag.className = "lang-tag en";
    }
    if (tgtTag) {
      tgtTag.textContent = "TH (ไทย)";
      tgtTag.className = "lang-tag th";
    }
  } else {
    if (dirPill) dirPill.textContent = "TH ⇄ EN";
    if (srcTag) {
      srcTag.textContent = "SPEAKER (TH / EN)";
      srcTag.className = "lang-tag";
    }
    if (tgtTag) {
      tgtTag.textContent = "TRANSLATION (EN / TH)";
      tgtTag.className = "lang-tag translated";
    }
  }

  if (hintEl) {
    if (!state.running) {
      hintEl.textContent = "Session idle";
    } else if (state.micMuted) {
      hintEl.textContent = "Mic is OFF — Stream paused (0 tokens/sec)";
    } else if (state.silenceGated && !hasContent) {
      hintEl.textContent = "Silence Gate active — Waiting for speech (0 tokens/sec)";
    } else if (hasContent) {
      hintEl.textContent = "Streaming live transcription & translation...";
    } else {
      hintEl.textContent = "Listening for Thai or English speech...";
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
}

function appendHistoryCard(turn) {
  const listEl = el("historyList");
  const emptyEl = el("emptyState");
  if (!listEl) return;
  if (emptyEl) emptyEl.hidden = true;

  const card = document.createElement("article");
  card.className = "history-card";

  const srcUpper = turn.sourceLang === "th" ? "TH (ไทย)" : "EN (English)";
  const tgtUpper = turn.targetLang === "th" ? "TH (ไทย)" : "EN (English)";
  const dirLabel = turn.sourceLang === "th" ? "Thai → English" : "English → Thai";

  const meta = document.createElement("div");
  meta.className = "history-meta";

  const dirSpan = document.createElement("span");
  dirSpan.className = "history-direction";
  dirSpan.textContent = dirLabel;

  const timeSpan = document.createElement("time");
  timeSpan.textContent = turn.timestamp || "";

  meta.appendChild(dirSpan);
  meta.appendChild(timeSpan);

  const grid = document.createElement("div");
  grid.className = "bilingual-grid";

  // Source Column
  const srcCol = document.createElement("div");
  srcCol.className = "transcript-col source-col";
  const srcHeader = document.createElement("div");
  srcHeader.className = "col-label";
  const srcBadge = document.createElement("span");
  srcBadge.className = `lang-tag ${turn.sourceLang === "th" ? "th" : "en"}`;
  srcBadge.textContent = srcUpper;
  srcHeader.appendChild(srcBadge);
  const srcBody = document.createElement("div");
  srcBody.className = "transcript-text";
  srcBody.dir = "auto";
  srcBody.textContent = turn.input || "—";
  srcCol.appendChild(srcHeader);
  srcCol.appendChild(srcBody);

  // Target Column
  const tgtCol = document.createElement("div");
  tgtCol.className = "transcript-col target-col";
  const tgtHeader = document.createElement("div");
  tgtHeader.className = "col-label";
  const tgtBadge = document.createElement("span");
  tgtBadge.className = `lang-tag ${turn.targetLang === "th" ? "th" : "en"}`;
  tgtBadge.textContent = tgtUpper;
  tgtHeader.appendChild(tgtBadge);
  const tgtBody = document.createElement("div");
  tgtBody.className = "transcript-text translated-text";
  tgtBody.dir = "auto";
  tgtBody.textContent = turn.output || "—";
  tgtCol.appendChild(tgtHeader);
  tgtCol.appendChild(tgtBody);

  grid.appendChild(srcCol);
  grid.appendChild(tgtCol);

  card.appendChild(meta);
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

function scrollToBottom(smooth = true) {
  const scroller = el("historyScroller");
  if (!scroller) return;
  scroller.scrollTo({
    top: scroller.scrollHeight,
    behavior: smooth ? "smooth" : "auto",
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
  const banner = el("errorBanner");
  const text = el("errorBannerText");
  if (text) text.textContent = msg;
  if (banner) banner.hidden = false;
}

function hideError() {
  const banner = el("errorBanner");
  if (banner) banner.hidden = true;
}

function showMicWarning(msg) {
  const banner = el("micWarningBanner");
  const text = el("micWarningText");
  if (text) text.textContent = msg;
  if (banner) banner.hidden = false;
}

function hideMicWarning() {
  const banner = el("micWarningBanner");
  if (banner) banner.hidden = true;
}

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
  };
  renderCurrentTurn();
  broadcastSnapshot();

  setTimeout(() => {
    finalizeCurrentTurn();
  }, 900);
}

function clearHistory() {
  state.historyTurns = [];
  state.currentTurn = {
    input: "",
    output: "",
    sourceLang: "auto",
    targetLang: "auto",
    startedAt: null,
  };
  renderHistory();
  renderCurrentTurn();
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

/**
 * Real-time sync between Operator View and OBS Browser Source / Stage Display (`?view=display`).
 * Uses both `BroadcastChannel` (same browser) and `/ws-relay` (cross-browser / OBS CEF).
 */
function setupSyncChannels() {
  if (state.bc) {
    state.bc.onmessage = (ev) => {
      if (ev.data?.type === "snapshot" && isDisplayMode) {
        applyRemoteSnapshot(ev.data);
      }
    };
  }

  connectRelayWebSocket();
}

function connectRelayWebSocket() {
  if (typeof WebSocket === "undefined") return;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${window.location.host}/ws-relay`;

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
    // Running as static file without server.js relay; BroadcastChannel still works
  }
}

function broadcastSnapshot() {
  if (isDisplayMode) return;
  const payload = {
    type: "snapshot",
    running: state.running,
    micMuted: state.micMuted,
    silenceGated: state.silenceGated,
    fontScale: state.settings.fontScale,
    layoutMode: state.settings.layoutMode,
    historyTurns: state.historyTurns.slice(-50),
    currentTurn: state.currentTurn,
  };

  try {
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

  if (snapshot.fontScale) {
    state.settings.fontScale = snapshot.fontScale;
  }
  if (snapshot.layoutMode) {
    state.settings.layoutMode = snapshot.layoutMode;
  }
  applyVisualSettings();

  if (Array.isArray(snapshot.historyTurns)) {
    state.historyTurns = snapshot.historyTurns;
    renderHistory();
  }
  if (snapshot.currentTurn) {
    state.currentTurn = snapshot.currentTurn;
    renderCurrentTurn();
  }
  if (!state.userScrolledUp) {
    scrollToBottom();
  }
}

init();
