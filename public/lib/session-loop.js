/**
 * Seamless session succession for long-running live events
 * (adapted from `lib/session-loop.js` in `kazunori279/interpretab`).
 *
 * Handles:
 * - ~10 minute WebSocket session expiry (`goAway` warning -> pre-open next session -> swap cleanly)
 * - Automatic model fallback (`gemini-3.8-live` -> `gemini-3.1-flash-live-preview`)
 * - Unanswered pre-roll audio replay across session handovers
 * - Forwarding `sendAudioStreamEnd()` when the mic is turned off or silent
 */

import {
  CANDIDATE_MODELS,
  isModelUnavailableClose,
  isQuotaClose,
  LiveSession,
} from "./live-session.js";

export const GOAWAY_IDLE_GRACE_MS = 5000;
export const GOAWAY_DEFAULT_MS = 30000;
export const GOAWAY_DEADLINE_MARGIN_MS = 1000;

export const RETRY_BACKOFF_INIT_MS = 200;
export const RETRY_BACKOFF_MAX_MS = 4000;
export const RETRY_MAX_ATTEMPTS = 10;
export const RETRY_HEALTHY_MS = 60000;

const DRAIN_TICK_MS = 250;
export const RECENT_AUDIO_MAX_FRAMES = 1250; // ~10s of 8ms worklet frames

export class SessionLoop {
  constructor({
    apiKey,
    setup,
    onEvent,
    onStatus,
    closeHint = "",
    models = CANDIDATE_MODELS,
    onModel,
    SessionClass = LiveSession,
    now,
  }) {
    this._apiKey = apiKey;
    this._setup = setup;
    this._closeHint = closeHint;
    this._onEvent = onEvent || (() => {});
    this._onStatus = onStatus || (() => {});
    this._onModel = onModel || (() => {});
    this._Session = SessionClass;
    this._now = now || (() => performance.now());

    this._models = models?.length
      ? [...models]
      : [String(setup?.setup?.model || "").replace(/^models\//, "")];
    this._model = 0;

    this._current = null;
    this._next = null;
    this._closed = false;
    this._backoff = RETRY_BACKOFF_INIT_MS;
    this._attempts = 0;
    this._adoptedAt = 0;
    this._retryTimer = null;
    this._drainTimer = null;

    this._recent = [];
    this._preroll = null;
    this._lastRelayAt = 0;
    this._draining = false;
    this._drainDeadline = 0;
  }

  get activeModel() {
    return this._models[this._model];
  }

  start() {
    this._closed = false;
    this._attempts = 0;
    this._connect();
  }

  send(pcmBuffer) {
    this._recent.push({ t: this._now(), bytes: new Uint8Array(pcmBuffer) });
    if (this._recent.length > RECENT_AUDIO_MAX_FRAMES) this._recent.shift();
    this._current?.send(pcmBuffer);
  }

  /**
   * Notify the active Gemini Live session that the audio stream has paused
   * (Mic Off or Silence Gate triggered), flushing buffered audio and ending the turn.
   */
  sendAudioStreamEnd() {
    this._current?.sendAudioStreamEnd?.();
  }

  close() {
    this._closed = true;
    clearTimeout(this._retryTimer);
    clearInterval(this._drainTimer);
    this._retryTimer = null;
    this._drainTimer = null;
    this._current?.close();
    this._next?.close();
    this._current = null;
    this._next = null;
    this._recent = [];
  }

  async _connect() {
    if (this._closed) return;
    const session = this._makeSession();
    try {
      await session.open();
    } catch (err) {
      if (this._closed) return session.close();
      if (isModelUnavailableClose(err.message)) {
        this._onModelGone();
        return;
      }
      this._onStatus("error", err.message);
      this._retryOrGiveUp(err.message);
      return;
    }
    if (this._closed) return session.close();
    this._adopt(session);
  }

  _setupNow() {
    return {
      ...this._setup,
      setup: {
        ...this._setup.setup,
        model: `models/${this._models[this._model]}`,
      },
    };
  }

  _makeSession() {
    return new this._Session({
      apiKey: this._apiKey,
      setup: this._setupNow(),
      closeHint: this._closeHint,
      onStatus: (status, detail) => {
        if (this._current === null || status === "connected") {
          this._onStatus(status, detail);
        }
      },
      onEvent: (ev) => this._onSessionEvent(ev),
    });
  }

  _adopt(session) {
    if (this._preroll) {
      session.send(this._preroll);
      session.flush();
      this._preroll = null;
    }
    this._current = session;
    this._backoff = RETRY_BACKOFF_INIT_MS;
    this._adoptedAt = this._now();
    this._lastRelayAt = this._now();
    this._draining = false;
    this._onModel(this._models[this._model]);
  }

  _onSessionEvent(ev) {
    if (this._closed) return;

    if (ev.type === "goAway") {
      this._beginDrain(ev.timeLeft);
      return;
    }

    if (ev.type === "closed") {
      if (isQuotaClose(ev.reason)) {
        this.close();
        this._onStatus(
          "failed",
          "Gemini API quota exceeded. Check your plan and billing details in Google AI Studio."
        );
        return;
      }
      if (isModelUnavailableClose(ev.reason)) {
        this._onModelGone();
        return;
      }
      if (this._draining) this._swap(true);
      else this._reconnect();
      return;
    }

    if (ev.type === "usage") {
      this._onEvent(ev);
      return;
    }

    this._lastRelayAt = this._now();
    this._attempts = 0;
    this._onEvent(ev);

    if (ev.type === "turnComplete" && this._draining) {
      this._swap(false);
    }
  }

  _beginDrain(timeLeftMs) {
    if (this._draining) return;
    this._draining = true;
    this._drainDeadline =
      this._now() + Math.max(0, (timeLeftMs || GOAWAY_DEFAULT_MS) - GOAWAY_DEADLINE_MARGIN_MS);
    this._openNext();
    clearInterval(this._drainTimer);
    this._drainTimer = setInterval(() => this._checkDrain(), DRAIN_TICK_MS);
  }

  async _openNext() {
    const session = this._makeSession();
    try {
      await session.open();
    } catch {
      return;
    }
    if (this._closed || !this._draining) return session.close();
    this._next = session;
  }

  _checkDrain() {
    if (!this._draining) return;
    const now = this._now();
    const silent = now - this._lastRelayAt >= GOAWAY_IDLE_GRACE_MS;
    if (silent || now >= this._drainDeadline) {
      this._swap(true);
    }
  }

  _swap(abandoned) {
    clearInterval(this._drainTimer);
    this._drainTimer = null;
    this._draining = false;

    const dying = this._current;
    this._current = null;
    dying?.close();

    if (abandoned) {
      this._preroll = this._audioSince(this._lastRelayAt);
      this._onEvent({ type: "turnComplete" });
    }

    const next = this._next;
    this._next = null;
    if (next) this._adopt(next);
    else this._connect();
  }

  _onModelGone() {
    clearTimeout(this._retryTimer);
    clearInterval(this._drainTimer);
    this._retryTimer = null;
    this._drainTimer = null;
    this._draining = false;
    this._current?.close();
    this._next?.close();
    this._current = null;
    this._next = null;

    if (this._model + 1 < this._models.length) {
      this._model += 1;
      this._onModel(this._models[this._model]);
      this._attempts = 0;
      this._backoff = RETRY_BACKOFF_INIT_MS;
      this._connect();
      return;
    }

    this.close();
    this._onStatus("failed", "No compatible Gemini Live model is currently available.");
  }

  _reconnect() {
    const lasted = this._now() - this._adoptedAt;
    this._current?.close();
    this._current = null;
    if (lasted >= RETRY_HEALTHY_MS) this._attempts = 0;
    this._onStatus("disconnected", "Reconnecting...");
    this._retryOrGiveUp("Connection dropped.");
  }

  _retryOrGiveUp(detail) {
    this._attempts += 1;
    if (this._attempts >= RETRY_MAX_ATTEMPTS) {
      this.close();
      this._onStatus(
        "failed",
        `${detail} Gave up after ${RETRY_MAX_ATTEMPTS} reconnect attempts.`
      );
      return;
    }
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._connect(), this._backoff);
    this._backoff = Math.min(this._backoff * 2, RETRY_BACKOFF_MAX_MS);
  }

  _audioSince(since) {
    const frames = this._recent.filter((f) => f.t >= since);
    if (!frames.length) return null;
    const total = frames.reduce((n, f) => n + f.bytes.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const f of frames) {
      merged.set(f.bytes, offset);
      offset += f.bytes.length;
    }
    return merged.buffer;
  }
}
