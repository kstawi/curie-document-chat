# Search benchmark

Does hybrid search (keyword and meaning together) find the right passage more often than either alone, with the
local embedding model and with the hosted one a reviewer would use?

## Method

- Document: `samples/benchmark/saltmarsh-field-report.md`, a made-up field report about a network of coastal
  measuring stations, written by Claude for this test (about 5,100 words, 37 passages, about 1.8 times the passage
  budget).
- Questions: `samples/benchmark/questions.json`, 24 in three kinds: 8 asking for an exact name, number or date; 10
  paraphrases that avoid the document's own words; 6 follow-ups that only make sense after an earlier question. Each
  lists text that the right passage contains; a ranked passage counts as found if it overlaps that text.
- Follow-ups are searched as the app searches them: rewritten into a standalone question by the configured chat
  model, using the earlier question and answer. They are also measured as asked, to show what the rewrite adds.
- The real code runs: the preparation job chunks and embeds the document into its own database (`curie_bench`), and
  `rankPassages` ranks the passages for each question, giving the keyword order, the meaning order and the fused
  order at once.
- Measures: hit@1 (the right passage ranked first) and hit@3 (in the top three) for keyword, meaning and hybrid; and
  for hybrid, whether the right passage is among those actually sent to the model within the 4,000-token budget.
- Runs: `npm run bench -w server` for the local models in `.env`, and `npm run bench -w server -- --gemini` for
  Gemini (chat `gemini-3.5-flash`, embeddings `gemini-embedding-2`), which reads `GEMINI_API_KEY` from `.env`. Each
  run writes its results to `docs/runs/`.

## Decision rule

Written on 2026-11-25, before the first run. The measure is hit@3 over all 24 questions, follow-ups after the rewrite,
counted separately for each embedding model.

- Hybrid stays the default if, with both embedding models, its hit@3 is no more than one question below the better
  of keyword and meaning.
- If one method alone beats hybrid's hit@3 by two questions or more with both embedding models, that method becomes
  the default.
- If the two embedding models point different ways, hybrid stays and the gap is reported.

Hit@1, the follow-ups as asked and the in-budget share are reported but do not decide. No question or expected text
is changed after the first run without saying so here.

## Results

Not run yet.
