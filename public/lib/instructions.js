/**
 * Bidirectional Thai (th) ⇄ English (en) system instruction, language detection,
 * and glossary helpers (inspired by kazunori279/interpretab).
 */

export const SUPPORTED_LANGUAGES = {
  th: "Thai (ภาษาไทย)",
  en: "English",
};

const ECHO_GUARD =
  "Your own interpreted speech may be played through speakers, so the microphone " +
  "might pick it up again. Because your output is in Thai or English, interpreting " +
  "your own echo would create an endless loop. If an utterance is your own output " +
  "coming back, ignore it and stay silent. Only interpret the human speaker.";

/**
 * Format custom event glossary entries for the system instruction.
 * @param {Array<{source: string, target: string}>} entries
 */
export function formatGlossarySection(entries = []) {
  const valid = (entries || []).filter(
    (e) => e && String(e.source || "").trim() && String(e.target || "").trim()
  );
  if (!valid.length) return "";
  const lines = valid
    .map(({ source, target }) => `- ${source.trim()} → ${target.trim()}`)
    .join("\n");
  return (
    `\n\nUse the following event glossary for specific terms, names, and acronyms. ` +
    `Match the source term case-insensitively and always use the paired translation:\n${lines}`
  );
}

/**
 * Build the bidirectional Thai ⇄ English interpreter system instruction for
 * Gemini Live (`gemini-3.8-live` / `gemini-3.1-flash-live-preview`).
 *
 * Adapted from `buildConversationInstruction` in `kazunori279/interpretab`.
 *
 * @param {object} [opts]
 * @param {string} [opts.langA="th"]
 * @param {string} [opts.langB="en"]
 * @param {Array<{source: string, target: string}>} [opts.glossary=[]]
 * @param {string} [opts.eventContext=""]
 */
export function buildBidirectionalInstruction({
  langA = "th",
  langB = "en",
  glossary = [],
  eventContext = "",
} = {}) {
  const nameA = SUPPORTED_LANGUAGES[langA] || "Thai (ภาษาไทย)";
  const nameB = SUPPORTED_LANGUAGES[langB] || "English";
  const contextClause = eventContext?.trim()
    ? `Event context: ${eventContext.trim()}. `
    : "";

  return (
    `You are a professional real-time live event interpreter translating bidirectionally ` +
    `between ${nameA} and ${nameB}. ` +
    `${contextClause}` +
    `When the speaker speaks in ${nameA}, interpret it directly into ${nameB}. ` +
    `When the speaker speaks in ${nameB}, interpret it directly into ${nameA}. ` +
    `Never restate an utterance in the language it was already spoken in. ` +
    `If a Thai sentence contains English loanwords, product names, or technical terms, ` +
    `judge by the primary language of the sentence as a whole (Thai) and translate the ` +
    `entire sentence into natural ${nameB}. Conversely, if an English sentence contains ` +
    `Thai names or terms, translate the sentence into natural, polite ${nameA}. ` +
    `Speak only the interpretation itself in the speaker's register and tone — ` +
    `no "the speaker says", no speaker labels, no commentary, and never answer a question ` +
    `yourself. You are an interpreter, not a participant in the conversation. ` +
    `Interpret only the current utterance. Do not repeat, summarize, or prepend ` +
    `interpretations from previous turns. Each spoken segment must produce exactly ` +
    `one faithful translation in the opposite language and nothing else. ` +
    `If an utterance is in a third language other than ${nameA} or ${nameB}, ` +
    `translate it into ${nameB}. ` +
    ECHO_GUARD +
    formatGlossarySection(glossary)
  );
}

/**
 * Parse a multiline `source = target` or `source -> target` glossary string.
 * @param {string} raw
 * @returns {Array<{source: string, target: string}>}
 */
export function parseGlossaryText(raw = "") {
  if (!raw || typeof raw !== "string") return [];
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(.+?)\s*(?:->|→|=|:|,|\t)\s*(.+)$/);
    if (match) {
      const source = match[1].trim();
      const target = match[2].trim();
      if (source && target) entries.push({ source, target });
    }
  }
  return entries;
}

const THAI_CHAR_RE = /[\u0E00-\u0E7F]/g;
const LATIN_CHAR_RE = /[A-Za-z]/g;

/**
 * Detect whether a transcript snippet is primarily Thai (`"th"`) or English (`"en"`).
 * @param {string} text
 * @returns {"th"|"en"|"auto"}
 */
export function detectLanguage(text = "") {
  if (!text) return "auto";
  const thaiCount = (text.match(THAI_CHAR_RE) || []).length;
  const latinCount = (text.match(LATIN_CHAR_RE) || []).length;
  if (thaiCount === 0 && latinCount === 0) return "auto";
  // If Thai script is present and represents at least 20% of alphabetic chars, classify as Thai
  if (thaiCount > 0 && thaiCount >= latinCount * 0.25) {
    return "th";
  }
  return "en";
}

/**
 * Clean up spurious spaces that streaming speech-to-text tokenizers sometimes
 * insert between adjacent Thai characters while preserving legitimate spaces.
 * @param {string} text
 */
export function cleanTranscriptSpacing(text = "") {
  if (!text) return "";
  return text.replace(/([ \t]+)(?=[\u0E00-\u0E7F])/g, (spaces, _g, offset, full) => {
    const prev = offset > 0 ? full[offset - 1] : "";
    // Keep normal spaces between words, collapse multiple spaces
    if (/[\u0E00-\u0E7F]/.test(prev) && spaces.length > 1) {
      return " ";
    }
    return spaces;
  });
}
