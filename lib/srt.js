/**
 * SubRip (.srt) subtitle formatter and language-extractor utilities.
 * Shared between browser UI (`public/app.js`) and Node.js server (`server.js`).
 */

/**
 * Format milliseconds offset into SRT timestamp `HH:MM:SS,mmm`.
 * @param {number} ms
 */
export function formatSrtTimestamp(ms = 0) {
  const clamped = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(clamped / 3600000);
  const minutes = Math.floor((clamped % 3600000) / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const millis = clamped % 1000;

  return (
    `${String(hours).padStart(2, "0")}:` +
    `${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")},` +
    `${String(millis).padStart(3, "0")}`
  );
}

/**
 * Extract Thai (`th`/`thai`), English (`en`/`english`), Chinese (`zh`/`chinese`),
 * and Lao (`lo`/`lao`) texts from a turn regardless of which language the speaker spoke.
 *
 * @param {{input?: string, output?: string, sourceLang?: string, targetLang?: string, texts?: {th?: string, en?: string, zh?: string, lo?: string}}} turn
 * @returns {{thai: string, english: string, chinese: string, lao: string, th: string, en: string, zh: string, lo: string}}
 */
export function extractThaiAndEnglish(turn = {}) {
  const input = String(turn.input || "").trim();
  const output = String(turn.output || "").trim();
  const src = turn.sourceLang || "th";
  const tgt = turn.targetLang || (src === "th" ? "en" : "th");
  const texts = turn.texts || {};

  let thai = String(texts.th || "").trim();
  let english = String(texts.en || "").trim();
  let chinese = String(texts.zh || "").trim();
  let lao = String(texts.lo || "").trim();

  if (src === "th" && !thai) thai = input;
  if (src === "en" && !english) english = input;
  if (src === "zh" && !chinese) chinese = input;
  if (src === "lo" && !lao) lao = input;

  if (tgt === "th" && !thai) thai = output;
  if (tgt === "en" && !english) english = output;
  if (tgt === "zh" && !chinese) chinese = output;
  if (tgt === "lo" && !lao) lao = output;

  // Fallback heuristics for older turns without explicit texts/sourceLang
  if (!thai && !english && !chinese && !lao && (input || output)) {
    const inputHasThai = /[\u0E00-\u0E7F]/.test(input);
    const outputHasThai = /[\u0E00-\u0E7F]/.test(output);
    const inputHasLao = /[\u0E80-\u0EFF]/.test(input);
    const outputHasLao = /[\u0E80-\u0EFF]/.test(output);
    const inputHasZh = /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(input);
    const outputHasZh = /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(output);

    if (inputHasLao && !outputHasLao) {
      lao = input;
      if (outputHasThai) thai = output;
      else if (outputHasZh) chinese = output;
      else english = output;
    } else if (inputHasThai && !outputHasThai) {
      thai = input;
      if (outputHasLao) lao = output;
      else if (outputHasZh) chinese = output;
      else english = output;
    } else if (outputHasThai && !inputHasThai) {
      thai = output;
      if (inputHasLao) lao = input;
      else if (inputHasZh) chinese = input;
      else english = input;
    } else {
      thai = input;
      english = output;
    }
  }

  return {
    thai,
    english,
    chinese,
    lao,
    th: thai,
    en: english,
    zh: chinese,
    lo: lao,
  };
}

/**
 * Convert an array of session turns into valid SubRip (`.srt`) format.
 *
 * @param {Array<object>} turns
 * @param {"combined"|"th"|"en"|"zh"|"lo"|Array<string>} [mode="combined"]
 * @param {number} [sessionStartEpochMs]
 * @returns {string}
 */
export function turnsToSrt(turns = [], mode = "combined", sessionStartEpochMs = 0) {
  if (!Array.isArray(turns) || !turns.length) return "";

  const firstEpoch =
    sessionStartEpochMs ||
    turns[0]?.startEpochMs ||
    turns[0]?.epochMs ||
    Date.now();

  const blocks = [];
  let index = 1;
  let fallbackCursorMs = 0;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const extracted = extractThaiAndEnglish(turn);
    const { thai, english, chinese, lao } = extracted;

    const lines = [];
    if (Array.isArray(mode)) {
      for (const lang of mode) {
        const val = extracted[lang];
        if (val) lines.push(val);
      }
    } else if (mode === "th") {
      if (thai) lines.push(thai);
    } else if (mode === "en") {
      if (english) lines.push(english);
    } else if (mode === "zh") {
      if (chinese) lines.push(chinese);
    } else if (mode === "lo") {
      if (lao) lines.push(lao);
    } else {
      if (thai) lines.push(thai);
      if (english) lines.push(english);
      if (chinese) lines.push(chinese);
      if (lao) lines.push(lao);
    }

    if (!lines.length) continue;

    let startMs;
    let endMs;

    const turnStartEpoch =
      typeof turn.startEpochMs === "number"
        ? turn.startEpochMs
        : typeof turn.epochMs === "number"
        ? turn.epochMs
        : null;

    if (typeof turn.startOffsetMs === "number" && typeof turn.endOffsetMs === "number") {
      startMs = Math.max(0, turn.startOffsetMs);
      endMs = Math.max(startMs + 1000, turn.endOffsetMs);
    } else if (typeof turnStartEpoch === "number" && typeof turn.endEpochMs === "number") {
      startMs = Math.max(0, turnStartEpoch - firstEpoch);
      endMs = Math.max(startMs + 1200, turn.endEpochMs - firstEpoch);
    } else if (typeof turnStartEpoch === "number") {
      endMs = Math.max(1500, turnStartEpoch - firstEpoch);
      startMs = Math.max(fallbackCursorMs, endMs - 3500);
    } else {
      startMs = fallbackCursorMs;
      endMs = startMs + 3500;
    }

    fallbackCursorMs = endMs + 200;

    blocks.push(
      `${index}\n` +
        `${formatSrtTimestamp(startMs)} --> ${formatSrtTimestamp(endMs)}\n` +
        `${lines.join("\n")}`
    );
    index += 1;
  }

  return blocks.join("\n\n") + (blocks.length ? "\n" : "");
}
