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
 * Extract the Thai text and English text from a bilingual turn regardless of
 * whether the speaker spoke Thai (`sourceLang === "th"`) or English (`sourceLang === "en"`).
 *
 * @param {{input?: string, output?: string, sourceLang?: string, targetLang?: string}} turn
 * @returns {{thai: string, english: string}}
 */
export function extractThaiAndEnglish(turn = {}) {
  const input = String(turn.input || "").trim();
  const output = String(turn.output || "").trim();
  const src = turn.sourceLang || "th";

  // If sourceLang is explicitly "th" or "en", respect it directly so Thai sentences
  // containing English technical jargon always stay on the Thai side.
  if (src === "th") {
    return {
      thai: input,
      english: output,
    };
  }
  if (src === "en") {
    return {
      english: input,
      thai: output,
    };
  }

  const inputHasThai = /[\u0E00-\u0E7F]/.test(input);
  const outputHasThai = /[\u0E00-\u0E7F]/.test(output);

  if (inputHasThai && !outputHasThai) {
    return { thai: input, english: output };
  }
  if (outputHasThai && !inputHasThai) {
    return { thai: output, english: input };
  }

  return {
    thai: input,
    english: output,
  };
}

/**
 * Convert an array of session turns into valid SubRip (`.srt`) format.
 *
 * @param {Array<object>} turns
 * @param {"combined"|"th"|"en"} [mode="combined"]
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
    const { thai, english } = extractThaiAndEnglish(turn);

    let lines = [];
    if (mode === "th") {
      if (thai) lines.push(thai);
    } else if (mode === "en") {
      if (english) lines.push(english);
    } else {
      if (thai) lines.push(thai);
      if (english) lines.push(english);
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
