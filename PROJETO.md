# Bookly - Projeto

## Regras

1\. Stack fixa: backend Python 3.11 + FastAPI + SQLite; frontend PWA em HTML/CSS/JavaScript puro (sem frameworks, sem build step).

2\. Só fontes legais: LibriVox, Project Gutenberg (Gutendex), Internet Archive (domínio público) e ficheiros importados pelo utilizador. Nunca scraping de sites com DRM/pagos.

3\. Nenhum texto visível hardcoded: usa sempre t("chave") com ficheiros em locales/<idioma>.json (pt-PT e en no mínimo).

4\. Nenhuma chave de API ou caminho absoluto no código: tudo em config.json/.env.

5\. Código modular, comentários em inglês, respostas em português. Mostra sempre o ficheiro completo, nunca "resto igual".

6\. Mobile-first (iPhone, 390px), botões ≥44px, suporta modo claro/escuro.

7\. Só podes usar as bibliotecas listadas em requirements.txt; se precisares de outra, pergunta primeiro.

8\. Não alteres ficheiros que não foram pedidos no prompt atual.

## Fases

* \[x\] Fase 1: Backend (Prompts 1, 2, 3) — done, now legacy/backend (39 pytest passed)
* \[x\] Fase 2: Interface base (4, 4B) — bottom nav, search debounce 400 ms, library rows, detail overlay
* \[x\] Fase 3: Ler (5) — reader.js paginated, resume page, themes/fonts, progress debounce 1 s
* \[x\] Fase 4: Ouvir (6, 6b port) — player.js ±15s/speed/sleep/Media Session; Range 206 verified; port to IndexedDB (Prompt 6b): db/search/paginate/progress/audio/pdf/migrate + sources; Vitest 23 passed; npm build OK
* \[x\] Fase 5: Voz IA (7) — speechSynthesis sentence queue, highlight, auto page advance, tts progress shared with read; 12 tests passed. 7B not yet specified
* \[ ] Fase 6: Acabamentos (8 definitions UI, 9 manifest/sw.js offline, 10 final tests) — prompts not sent yet

## Estado atual

App 100% client-side (Vite + IndexedDB). Backend FastAPI moved to legacy/backend/ kept for parity. Open: Prompts 7B, 8, 9, 10.

