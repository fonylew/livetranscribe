/**
 * Real-time Token Counter & API Cost Estimator for Gemini Live API
 * (inspired by `lib/usage.js` in kazunori279/interpretab).
 *
 * Design Rule:
 * - The MAIN screen displays ONLY the token counts (`formatTokenPill`), never the price.
 * - The detailed API cost estimation (in USD and THB, plus savings from Mic Off / Silence Gate)
 *   is computed here for the expandable Token & Cost Estimator popover.
 *
 * Billing Basis:
 * - Google Gemini Live API bills audio at 25 tokens per second of audio in either direction.
 */

export const AUDIO_TOKENS_PER_SECOND = 25;
export const DEFAULT_USD_TO_THB = 34.5;

export const DEFAULT_MODEL = "gemini-3.8-live";
export const FALLBACK_MODEL = "gemini-3.1-flash-live-preview";
export const SIMUL_MODEL = "gemini-3.5-live-translate-preview";

/**
 * USD per 1,000,000 audio tokens (from ai.google.dev/gemini-api/docs/pricing).
 */
export const RATES = {
  [DEFAULT_MODEL]: { audioIn: 3.0, audioOut: 12.0 },
  [FALLBACK_MODEL]: { audioIn: 3.0, audioOut: 12.0 },
  [SIMUL_MODEL]: { audioIn: 3.5, audioOut: 21.0 },
};

/**
 * Create a fresh usage accumulator for a session.
 */
export function emptyUsage() {
  return {
    inSeconds: 0,
    outSeconds: 0,
    savedSeconds: 0,
    serverInputTokens: 0,
    serverOutputTokens: 0,
  };
}

/**
 * Record active audio sent over the WebSocket to Gemini Live API, in seconds.
 */
export function noteAudioIn(totals, seconds) {
  totals.inSeconds += Math.max(0, Number(seconds) || 0);
  return totals;
}

/**
 * Record active audio returned by Gemini Live API, in seconds.
 */
export function noteAudioOut(totals, seconds) {
  totals.outSeconds += Math.max(0, Number(seconds) || 0);
  return totals;
}

/**
 * Record audio duration that was NOT sent because Mic was Off or gated by Silence Gate.
 */
export function noteAudioSaved(totals, seconds) {
  totals.savedSeconds += Math.max(0, Number(seconds) || 0);
  return totals;
}

/**
 * Record optional server-reported `usageMetadata` increments if present.
 */
export function noteServerUsage(totals, usageMetadata) {
  if (!usageMetadata) return totals;
  if (typeof usageMetadata.promptTokenCount === "number") {
    totals.serverInputTokens = Math.max(totals.serverInputTokens, usageMetadata.promptTokenCount);
  }
  if (typeof usageMetadata.responseTokenCount === "number") {
    totals.serverOutputTokens = Math.max(
      totals.serverOutputTokens,
      usageMetadata.responseTokenCount
    );
  }
  return totals;
}

/**
 * Compute full token and cost metrics from the usage accumulator.
 *
 * @param {ReturnType<typeof emptyUsage>} totals
 * @param {string} [model=DEFAULT_MODEL]
 * @param {object} [opts]
 * @param {number} [opts.elapsedSeconds=0]
 * @param {number} [opts.usdToThb=DEFAULT_USD_TO_THB]
 */
export function computeUsageMetrics(
  totals = emptyUsage(),
  model = DEFAULT_MODEL,
  { elapsedSeconds = 0, usdToThb = DEFAULT_USD_TO_THB } = {}
) {
  const rate = RATES[model] || RATES[DEFAULT_MODEL];

  const inTokens = Math.round((totals.inSeconds || 0) * AUDIO_TOKENS_PER_SECOND);
  const outTokens = Math.round((totals.outSeconds || 0) * AUDIO_TOKENS_PER_SECOND);
  const totalTokens = inTokens + outTokens;
  const savedTokens = Math.round((totals.savedSeconds || 0) * AUDIO_TOKENS_PER_SECOND);

  const costInUSD = (inTokens * rate.audioIn) / 1e6;
  const costOutUSD = (outTokens * rate.audioOut) / 1e6;
  const costUSD = costInUSD + costOutUSD;
  const costTHB = costUSD * usdToThb;

  // Saved cost: when Mic is off, we save both the uplink audio tokens and the
  // potential downlink interpretation overhead. Conservatively priced on audioIn.
  const savedUSD = (savedTokens * rate.audioIn) / 1e6;
  const savedTHB = savedUSD * usdToThb;

  const activeWindow = Math.max(elapsedSeconds, totals.inSeconds || 0);
  const hourlyRateUSD = activeWindow >= 5 ? (costUSD / activeWindow) * 3600 : 0;
  const hourlyRateTHB = hourlyRateUSD * usdToThb;

  return {
    model,
    rate,
    inSeconds: totals.inSeconds || 0,
    outSeconds: totals.outSeconds || 0,
    savedSeconds: totals.savedSeconds || 0,
    elapsedSeconds,
    inTokens,
    outTokens,
    totalTokens,
    savedTokens,
    costInUSD,
    costOutUSD,
    costUSD,
    costTHB,
    savedUSD,
    savedTHB,
    hourlyRateUSD,
    hourlyRateTHB,
  };
}

/**
 * Format token count for the MAIN screen pill (NO price shown on main screen).
 * @param {number} tokens
 */
export function formatTokenCount(tokens = 0) {
  const count = Math.max(0, Math.round(Number(tokens) || 0));
  return `${count.toLocaleString("en-US")} ${count === 1 ? "token" : "tokens"}`;
}

/**
 * Format duration as `MM:SS` or `HH:MM:SS` for the main bar and estimator.
 * @param {number} seconds
 */
export function formatClock(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  if (hrs > 0) {
    return `${hrs}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Format USD cost for the Estimator popover only.
 * @param {number} dollars
 */
export function formatUSD(dollars = 0) {
  if (dollars <= 0) return "$0.0000";
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(3)}`;
}

/**
 * Format THB cost for the Estimator popover only.
 * @param {number} baht
 */
export function formatTHB(baht = 0) {
  if (baht <= 0) return "฿0.00";
  if (baht < 1) return `฿${baht.toFixed(3)}`;
  return `฿${baht.toFixed(2)}`;
}
