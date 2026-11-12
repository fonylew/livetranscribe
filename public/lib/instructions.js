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
    `You are a simultaneous bidirectional translator between ${nameA} and ${nameB}. ` +
    `${contextClause}` +
    `RULE 1 (Thai -> English): Whenever the speaker speaks in ${nameA} (including Thai mixed with English technical jargon, acronyms, or product names), translate the entire utterance directly into natural ${nameB}. ` +
    `RULE 2 (English -> Thai): Whenever the speaker speaks in ${nameB}, translate the entire utterance directly into natural, polite ${nameA}. ` +
    `RULE 3 (Strict Translation Only — Never Converse): NEVER reply to the speaker, NEVER acknowledge instructions (do not say "รับทราบค่ะ" or "ขออภัยค่ะ"), NEVER explain what language you are waiting for, and NEVER ask questions. Even if the speaker says "change language" or talks about translation, just translate their exact words into the other language. ` +
    `RULE 4 (Never Echo Same Language): Never repeat an utterance in the same language it was spoken in. Every Thai utterance MUST be output in English, and every English utterance MUST be output in Thai. ` +
    `RULE 5 (Script & Noise Filter): The speaker ONLY speaks Thai (ภาษาไทย) or English. ` +
    `Never output Chinese characters (漢字/汉字), Japanese, Korean, or any other non-Thai/non-English scripts, ` +
    `and never output placeholders like "<no speech detected>" or "[noise]". ` +
    `If the audio is only background noise, a cough, or silence, stay completely silent and output nothing. ` +
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
 * Sanitize and clean transcript text:
 * - Removes ASR noise placeholders such as `<no speech detected>`, `[noise]`, `[silence]`
 * - Removes Chinese/CJK characters, Japanese, Korean, and exotic non-Thai/non-Latin scripts
 * - Collapses spurious multiple spaces between Thai characters
 * @param {string} text
 */
export function cleanTranscriptSpacing(text = "") {
  if (!text) return "";
  let cleaned = String(text)
    // Remove <no speech detected>, <noise>, [noise], [silence], etc.
    .replace(/<\s*(?:no\s+speech\s+detected|noise|silence|inaudible|music|applause|laughter)[^>]*>/gi, "")
    .replace(/\[\s*(?:no\s+speech\s+detected|noise|silence|inaudible|music|applause|laughter)[^\]]*\]/gi, "")
    // Allow only standard ASCII/Latin, Thai script (\u0E00-\u0E7F), and standard typographic punctuation.
    // This strips Chinese/CJK characters (哼。), Japanese, Korean, and exotic Unicode blocks (e.g. Bamum).
    .replace(/[^\u0009\u000A\u000D\u0020-\u007E\u00A0-\u024F\u0E00-\u0E7F\u2000-\u206F\u20A0-\u20CF]/gu, "");

  cleaned = cleaned.replace(/([ \t]+)(?=[\u0E00-\u0E7F])/g, (spaces, _g, offset, full) => {
    const prev = offset > 0 ? full[offset - 1] : "";
    // Keep normal spaces between words, collapse multiple spaces
    if (/[\u0E00-\u0E7F]/.test(prev) && spaces.length > 1) {
      return " ";
    }
    return spaces;
  });

  // If the remaining text has no Thai characters and no Latin letters/digits (e.g. only "." or spaces), return ""
  if (!/[\u0E00-\u0E7FA-Za-z0-9]/.test(cleaned)) {
    return "";
  }

  return cleaned;
}
