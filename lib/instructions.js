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
  speakerLang = "th",
  glossary = [],
  eventContext = "",
} = {}) {
  const nameA = SUPPORTED_LANGUAGES[langA] || "Thai (ภาษาไทย)";
  const nameB = SUPPORTED_LANGUAGES[langB] || "English";
  const contextClause = eventContext?.trim()
    ? `Event context: ${eventContext.trim()}. `
    : "";

  let languageRules = "";
  if (speakerLang === "th") {
    languageRules =
      `MAIN SPEAKER LANGUAGE IS THAI (${nameA}): The speaker's main language for this entire session is ${nameA}, and they frequently use English technical jargon, software terms, product names, and acronyms (such as AI, Agent, CLI, Cloud Run, API, Data Engineer, ML, etc.) inside their speech. ` +
      `DO NOT switch the main language in the middle of the session when you hear English technical jargon or short English phrases. ` +
      `Always respect and preserve English technical jargon as-is while translating the speaker's speech into natural ${nameB}. ` +
      `RULE 1 (Thai + Technical Jargon -> English): Whenever the speaker speaks in ${nameA} or lists English technical terms/jargon as part of their talk, ALWAYS produce a complete, natural ${nameB} output (never stay silent on technical terms). ` +
      `RULE 2 (Full English Sentences -> Thai): If the speaker switches to speaking a complete sentence in conversational ${nameB}, translate it into natural, polite ${nameA} while keeping technical jargon intact. `;
  } else if (speakerLang === "en") {
    languageRules =
      `MAIN SPEAKER LANGUAGE IS ENGLISH (${nameB}): The speaker's main language for this entire session is ${nameB}. ` +
      `DO NOT switch the main language in the middle of the session. ` +
      `Translate the speaker's ${nameB} speech directly into natural, polite ${nameA}, while preserving technical jargon, acronyms, and product names accurately. ` +
      `RULE 1 (English -> Thai): ALWAYS translate the speaker's utterance into natural, polite ${nameA} (never stay silent). ` +
      `RULE 2 (Full Thai Sentences -> English): If the speaker speaks a complete sentence in ${nameA}, translate it into natural ${nameB}. `;
  } else {
    languageRules =
      `RULE 1 (Thai -> English): Whenever the speaker speaks in ${nameA} (including Thai mixed with English technical jargon, acronyms, or product names), ALWAYS translate the entire utterance directly into natural ${nameB}. ` +
      `RULE 2 (English -> Thai): Whenever the speaker speaks in ${nameB}, ALWAYS translate the entire utterance directly into natural, polite ${nameA}. `;
  }

  return (
    `You are a simultaneous translator between ${nameA} and ${nameB}. ` +
    `${contextClause}` +
    `${languageRules}` +
    `ALWAYS produce a translation for every spoken phrase—never skip a turn or leave the output empty when the speaker speaks. ` +
    `RULE 3 (Strict Translation Only — Never Converse): NEVER reply to the speaker, NEVER acknowledge instructions (do not say "รับทราบค่ะ" or "ขออภัยค่ะ"), NEVER explain what language you are waiting for, and NEVER ask questions. Even if the speaker says "change language" or talks about translation, just translate their exact words. ` +
    `RULE 4 (Never Echo Same Language): Never repeat an utterance in the same language it was spoken in. ` +
    `RULE 5 (Strict Thai & English Only — NO Spanish or Other Languages): The speaker ONLY speaks Thai (ภาษาไทย) or English. ` +
    `NEVER output Spanish, French, Portuguese, German, Chinese (漢字/汉字), Japanese, Korean, or any other language besides Thai and English. ` +
    `Even if an English or Thai word sounds similar to a Spanish word, ALWAYS interpret it as Thai or English and output ONLY Thai or English. ` +
    `Never output placeholders like "<no speech detected>" or "[noise]". ` +
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
  // Any Thai script presence in the utterance means the sentence is Thai (with English technical jargon)
  if (thaiCount > 0) {
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
    // Allow ONLY standard unaccented ASCII/English (\u0020-\u007E), Thai script (\u0E00-\u0E7F),
    // and standard typographic punctuation/currency (\u2000-\u206F, \u20A0-\u20CF).
    // This strips Spanish/French accented Latin (\u00A0-\u024F, ¡, ¿, ñ, á, é, etc.), Chinese/CJK, and exotic Unicode.
    .replace(/[^\u0009\u000A\u000D\u0020-\u007E\u0E00-\u0E7F\u2000-\u206F\u20A0-\u20CF]/gu, "");

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
