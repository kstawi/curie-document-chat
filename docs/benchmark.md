# Search benchmark

Does hybrid search (keyword and meaning together) find the right passage more often than either alone, with the
local embedding model and with the hosted one a reviewer would use?

## Method

- Document: `samples/benchmark/saltmarsh-field-report.md`, a made-up field report about a network of coastal
  measuring stations, written by Claude for this test (about 5,100 words, 37 passages, about 1.8 times the passage
  budget).
- Questions: `samples/benchmark/questions.json`, 24 in three kinds: 8 asking for an exact name, number or date; 10
  paraphrases written to avoid the document's wording (five still share a word or two with their passage, see the
  caveats below); 6 follow-ups that only make sense after an earlier question. Each lists text from the passages that
  answer it; a ranked passage counts as found if it overlaps that text.
- Follow-ups are searched as the app searches them: rewritten into a standalone question by the configured chat
  model, using the earlier question and answer. They are also measured as asked, to show what the rewrite adds.
- The real code runs: the preparation job chunks and embeds the document into its own database (`curie_bench`), and
  `rankPassages` ranks the passages for each question, giving the keyword order, the meaning order and the fused
  order at once.
- Measures: hit@1 (the right passage ranked first) and hit@3 (in the top three) for keyword, meaning and hybrid; and
  whether the right passage is among those actually sent to the model within the 4,000-token budget.
- The 2026-11-25 result files store only whether each method found the passage; later runs also store the passage
  numbers each method ranked first to third, so labels can be checked again without the models.
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

Run on 2026-11-25. Raw results, one file per run, are in `docs/runs/` (`2026-11-25-benchmark-*.json`).

The first Gemini attempt failed before any ranking: Gemini's endpoint leaves out the index of the first embedding in
a reply, and the app refused every such reply. That was a bug in the app's hosted path, fixed in the same step (see
`docs/ai-log.md`), and the run was repeated.

### First runs, labels as written before the run

All 24 deciding questions (follow-ups after the rewrite):

| Embeddings                                        | Keyword hit@1 | Keyword hit@3 | Meaning hit@1 | Meaning hit@3 | Hybrid hit@1 | Hybrid hit@3 | Hybrid in budget |
| ------------------------------------------------- | ------------- | ------------- | ------------- | ------------- | ------------ | ------------ | ---------------- |
| nomic-embed-text-v1.5 (rewrites by Gemma 4)       | 11            | 16            | 17            | 22            | 14           | 20           | 23               |
| gemini-embedding-2 (rewrites by gemini-3.5-flash) | 12            | 17            | 20            | 24            | 17           | 22           | 24               |

On these numbers the rule would switch the default to meaning alone (two questions ahead of hybrid with both models).

### Labels completed after the first run

The questions were labelled against a shorter first draft of the document, and the sections added afterwards were
only checked for each expected text occurring once, not for holding a second right answer. Before deciding, every
question was labelled again from the document alone, with one test for every passage: could a reader given only that
passage answer the question correctly. Five questions gained right passages; none lost any:

- the 2025 uptime is also stated in the summary;
- who relies on the readings: also the publishing section (the harbour office and two sailing apps) and the note on
  the two Harrow Quay stations;
- the risk to the church gateway: also sections 10 and 11 and the station notes;
- how the Gull Point turbine worked out: also its station note;
- whether satellite spending has a limit: also three later mentions of the monthly cap.

The follow-ups were searched again with the same rewrites as in the first runs, so only the labels changed. The
"meaning in budget" column was added at the same time.

### Results with the completed labels

| Embeddings            | Keyword hit@1 | Keyword hit@3 | Meaning hit@1 | Meaning hit@3 | Hybrid hit@1 | Hybrid hit@3 | Hybrid in budget | Meaning in budget |
| --------------------- | ------------- | ------------- | ------------- | ------------- | ------------ | ------------ | ---------------- | ----------------- |
| nomic-embed-text-v1.5 | 12            | 17            | 19            | 23            | 15           | 21           | 24               | 24                |
| gemini-embedding-2    | 13            | 18            | 20            | 24            | 18           | 23           | 24               | 24                |

By kind, with nomic: exact 7 of 8 at hit@3 for every method; paraphrases 5, 10 and 9 of 10 for keyword, meaning and
hybrid; rewritten follow-ups 5, 6 and 5 of 6. Searched as asked, without the rewrite, the follow-ups found the right
passage in the top three only 1, 4 and 2 times out of 6.

### Decision

Meaning alone leads hybrid at hit@3 by two questions with nomic and by one with Gemini. The two models point
different ways, so by the rule hybrid stays the default. On what the model actually receives, the passages that fit
the 4,000-token budget, hybrid and meaning alone both include the right passage for all 24 questions with both
models.

That outcome is weak evidence, and it should be read that way:

- It turns on one question. With the first labels the rule would have switched to meaning alone. Of the five
  questions given more right passages, only `para-who-uses-it` changed the gap: with Gemini, hybrid now finds it in
  its top three. Gemini's meaning ranking was already at 24 of 24, so the completed labels could only help hybrid.
- The completed labels are not perfectly even. Two borderline passages were not added: the summary's mention of the
  November 2025 surge warning (for `exact-surge-date`), and the opening line about the people living behind the dunes
  and the harbour master's warning (for `para-who-uses-it`). No third round of labels was made after seeing results;
  either addition helps keyword most and cannot move the Gemini gap of one.
- Five paraphrases still share a word or two with their passage (`para-injury`: rock; `para-rusted-parts`: metal,
  parts, took; `para-false-alarms`: jumps, water; `para-turbine-removed`: wind, taken, away; `para-no-heating`:
  winter, sensors), which flatters keyword search and, through it, hybrid.
- One rewrite changed its question: Gemma turned "Is there a limit on that spending?" into a question about the cost
  of one message, which still counts as found. Hit@k does not judge rewrites.

What the numbers do say: on this document keyword search adds little and loses on paraphrases, meaning alone is at
least as good as hybrid, and the rewrite of follow-ups matters more than the choice of method.
