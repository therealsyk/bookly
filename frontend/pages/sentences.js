// Sentence splitter for TTS. Pure function (no browser APIs) so it is easy to
// test with Vitest. Splits on ., !, ? without breaking common abbreviations
// such as "Sr.", "Dr.", "etc.", "e.g.", initials (J. R. R.) or decimals (1.50).

const ABBREVIATIONS = new Set([
  "sr", "srta", "dr", "dra", "prof", "profa", "etc", "ex", "eg", "vs",
  "inc", "ltd", "jr", "mr", "mrs", "ms", "st", "no", "nr", "fig", "vol",
  "cap", "p", "pp", "ed", "eds", "approx", "gov", "univ", "dept", "phd",
  "usa", "uk", "am", "pm", "al", "etc.",
]);

// Decide whether the dot at position i (inclusive) ends a sentence.
function dotEndsSentence(text, i) {
  // Look at the token immediately before the dot.
  const before = text.slice(0, i);
  const m = /(\S+)\.$/.exec(before + ".");
  if (!m) return true;
  // Group 1 already excludes the dot (the \. is outside the group).
  const token = m[1].toLowerCase();

  // Decimal number: digit.digit -> not a sentence end (e.g. 1.50).
  const prevChar = text[i - 1];
  const nextChar = text[i + 1];
  if (/[0-9]/.test(prevChar) && /[0-9]/.test(nextChar)) return false;

  // Abbreviation or single initial -> not a sentence end.
  if (ABBREVIATIONS.has(token)) return false;
  if (token.length === 1 && /[a-z]/i.test(token)) {
    // A single letter followed by another word is an initial (J. R. Tolkien),
    // so do not break here.
    const rest = text.slice(i + 1);
    if (/^\s*[A-Za-z]/.test(rest)) return false;
    return true;
  }
  return true;
}

function splitSentences(text) {
  if (!text || !text.trim()) return [];
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentences = [];
  let start = 0;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;

    // Must be followed by whitespace or end of string to be a boundary.
    const nextChar = normalized[i + 1];
    if (nextChar && !/\s/.test(nextChar)) continue;

    if (ch === "." && !dotEndsSentence(normalized, i)) continue;

    const sentence = normalized.slice(start, i + 1).trim();
    if (sentence) sentences.push(sentence);
    start = i + 1;
  }

  const tail = normalized.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences.filter((s) => s.length > 0);
}

export { splitSentences, ABBREVIATIONS };
