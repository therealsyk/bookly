// Prompt 7 tests: sentence splitting, voice selection, auto-advance and
// progress with mode="tts" sharing current_page with read mode.
// Run with: npm test (vitest + fake-indexeddb)

import { describe, it, expect } from "vitest";
import "fake-indexeddb/auto";

import { splitSentences } from "../pages/sentences.js";
import { pickVoice, resolveVoice, createTtsState } from "../pages/tts.js";
import { openDb, addBook, savePages, saveProgress, getProgress } from "../db.js";

describe("sentence splitting", () => {
  it("splits on . ! ?", () => {
    const s = splitSentences("Olá mundo. Isto é uma frase! E outra? Sim.");
    expect(s.length).toBe(4);
  });

  it("does not break common abbreviations (Sr., Dr., etc.)", () => {
    const s = splitSentences("O Sr. João foi ao Dr. Pedro, etc. e voltou.");
    // "etc." is an abbreviation -> the sentence continues until "voltou."
    expect(s.length).toBe(1);
    expect(s[0]).toContain("Sr. João");
  });

  it("does not break single-letter initials (J. R. R. Tolkien)", () => {
    const s = splitSentences("J. R. R. Tolkien escreveu o Senhor dos Anéis.");
    expect(s.length).toBe(1);
  });

  it("does not break decimal numbers", () => {
    const s = splitSentences("O preço era 1.50 euros e subiu a 2.75 euros.");
    expect(s.length).toBe(1);
  });

  it("text without punctuation is one sentence", () => {
    const s = splitSentences("texto sem pontuação alguma aqui");
    expect(s.length).toBe(1);
  });

  it("empty text yields no sentences", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   ")).toEqual([]);
  });
});

describe("voice selection", () => {
  const voices = [
    { name: "Google UK English", lang: "en-GB", remote: true },
    { name: "Microsoft Ana", lang: "pt-PT", remote: false },
    { name: "Siri pt", lang: "pt-PT", remote: true },
  ];

  it("prefers local pt-PT voice over remote", () => {
    const v = pickVoice(voices, "pt-PT");
    expect(v.name).toBe("Microsoft Ana");
  });

  it("falls back to a pt prefix when no exact match", () => {
    const v = pickVoice([{ name: "pt-BR", lang: "pt-BR", remote: false }], "pt-PT");
    expect(v.lang).toBe("pt-BR");
  });

  it("reports no native voice when none exists", () => {
    const r = resolveVoice([{ name: "English", lang: "en-US", remote: true }], "pt-PT");
    expect(r.hasNativeVoice).toBe(false);
  });
});

describe("auto-advance and progress (tts)", () => {
  it("advances sentences then pages automatically", () => {
    const pages = ["Um. Dois. Três.", "Quatro."];
    const st = createTtsState(pages);
    st.loadPage(0);
    expect(st.sentences.length).toBe(3);
    expect(st.sentenceIdx).toBe(0);
    expect(st.nextSentence()).toBe(true); // -> sentence 1
    expect(st.nextSentence()).toBe(true); // -> sentence 2 (last)
    expect(st.nextSentence()).toBe("page"); // end of page 0 -> page 1, sentence 0
    expect(st.pageIdx).toBe(1);
    expect(st.sentenceIdx).toBe(0);
    expect(st.nextSentence()).toBe(false); // end of book
  });

  it("prevSentence goes back across pages", () => {
    const pages = ["Um. Dois.", "Três."];
    const st = createTtsState(pages);
    st.loadPage(1);
    st.setSentenceIdx(0);
    expect(st.prevSentence()).toBe("page"); // back to page 0, last sentence
    expect(st.pageIdx).toBe(0);
    expect(st.sentenceIdx).toBe(1); // last of ["Um.","Dois."]
  });

  it("round-trip: tts progress shares current_page with read mode", async () => {
    await openDb();
    const book = await addBook({ source: "test", source_id: "tts-1", title: "TTS Book", kind: "text" });
    const id = book.id;
    await savePages(id, ["A. B.", "C. D."]);

    // Read mode saves page 7 -> tts reads the same page when reopening.
    await saveProgress(id, "read", { position: 7, percent: 0.5 });
    const rows = await getProgress(id);
    const readRow = rows.find((r) => r.mode === "read");
    expect(readRow.position).toBe(7);

    // TTS on the same page writes mode="tts" with the same position.
    await saveProgress(id, "tts", { position: 7, percent: 0.5 });
    const all = await getProgress(id);
    const ttsRow = all.find((r) => r.mode === "tts");
    expect(ttsRow.position).toBe(7);
    expect(all.filter((r) => r.position === 7).length).toBe(2); // read + tts agree
  });
});
