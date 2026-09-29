# Exam Bandhu Academy — RSSB LDC Grade-II 2026 Rank Predictor

This project is a complete self-hosted web app using Node.js 22's built-in SQLite (`node:sqlite`). It contains the 31,798 candidates parsed from the uploaded RSSB LDC 2026 typing-shortlist PDF (NTSP 28,792 + TSP 3,006), a verified roll-number lookup, score submission/update, live overall/category/area ranking, and Exam Bandhu Academy App/Telegram buttons.

## Run locally

```bash
node server.js
```
Then open `http://localhost:3000`.

No npm install is required.

## Important scoring logic used in the UI

- Paper I: 150 questions, 100 marks, 1 deleted => 149 valid
- Paper II: 150 questions, 100 marks, 6 deleted => 144 valid
- Key Factor (KF) follows the RSSB result-notice expression, equivalent to `100 / valid_questions` for these papers.
- Right marks = right × KF.
- Wrong penalty = `100 × wrong / (150 × 3)`.
- There is NO separate Not Attempted input/penalty in this predictor; any penalized unanswered/non-filled item the student chooses to count is entered under Wrong, per the intended calculator workflow.

## Deployment

Use any Node 22 hosting that can keep a writable persistent disk for `data/ldc.db` (or attach a persistent volume). Because the live ranking is stored in SQLite, ephemeral-only hosting will lose submissions on restart.

## Data source

Candidate data was extracted from the uploaded PDF `LDC टाइपिंग Result.pdf`. The source document states that about three times the advertised posts were shortlisted for Phase-II typing test and contains Annexure-3 (NTSP) and Annexure-4 (TSP) candidate lists.
