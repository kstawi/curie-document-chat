# Model check before the build

Run on 2026-11-24, before the coding clock started, to find a local model that replies in strict JSON and quotes the
document word for word, and to set the limits the design uses. The criteria below were written before each run; the
results follow them.

The script is [`scripts/model-check/model-test.mjs`](../scripts/model-check/model-test.mjs). It reads the brief from
`scripts/model-check/brief.md`, a byte-for-byte copy: the sample note comes from it, and some runs pad the prompt with
its paragraphs. The padding only ever went to the local model. The script was copied here after the runs with a new
header, the brief's new path, Prettier's formatting, one reworded comment and a guard that stops the padding going to
a hosted service; it has not been run since. Besides what is said here, the notes below differ from the originals
only in describing the hardware generically, writing "about" for a tilde, saying where Docker was off, and leaving
out a note on the API key. The raw result files and logs are not included, since they hold the brief's paragraphs and the
model's full thinking text.

Machine: a laptop with an integrated GPU that shares its 31 GB of system memory. LM Studio's llama.cpp engine (Vulkan
build 2.82.0), chat models loaded with a 16,384-token context. Models: `google/gemma-4-26b-a4b-qat` (file
`gemma-4-26B-A4B-it-QAT-Q4_0.gguf`, lmstudio-community), `qwen/qwen3.8-27b` (Q4_K_M),
`text-embedding-nomic-embed-text-v1.5`. Load command: `lms load google/gemma-4-26b-a4b-qat -c 16384 -y`.

## Criteria

### Setup

- LM Studio server on 127.0.0.1:1234. One chat model loaded at a time, context 16,384 tokens (8,192 if memory is
  short), GPU offload left on auto. Cold load time recorded.
- Document: the brief's sample note, split into its 5 sections as numbered passages.

### Embeddings (nomic-embed-text-v1.5)

- Pass: 768-dimension vectors, with the `search_document:` / `search_query:` prefixes (confirmed on the model card).
- Informational: 4 reworded queries; how often the expected section ranks first. The benchmark decides retrieval
  later.

### Chat models (Gemma 4 26B-A4B, Qwen 3.8 27B)

Calls: 5 sample questions (Q3 is a follow-up with history), 1 injection probe, 1 follow-up rewrite.

A model passes when all four hold:

1. JSON: valid and schema-conforming on all 7 calls.
2. Outcomes: Q1, Q2, Q3, Q4 `answered` with the expected fact (Mira Chen; 0.7 s; 1.2 s; not measured), Q5
   `not_in_document`.
3. Quotes: every `answered` result has at least one quote that verifies against the document (normalised matching:
   NFKC, whitespace, quote and dash variants), and at least 80% of all quotes verify.
4. Speed: median warm answer time at most 60 s.

Pick: among passing models, the higher quote-verification rate, then the faster median. If no model passes 3: use the
fallback (sentence-numbered passages; the model cites numbers; the server supplies the text). If no model passes 1:
check structured-output support and reasoning settings before anything else. The injection probe is informational
and reported as it comes out.

### Follow-up after the first runs (written before running it)

No configuration passed as written: Gemma 4 with thinking on had a runaway call (criterion 1); with thinking off it
labelled "the document says this wasn't measured" as `not_in_document` (criterion 2, Q4). Qwen 3.8 was stopped on
speed. The 5-minute call cap, the reasoning setting and the field-order variant were added after seeing results.

A test of a three-label answer contract (Gemma 4, thinking off) on 12 new questions: `answered` (the passages answer
it; at least one verified quote), `document_says_unknown` (the passages explicitly say it wasn't measured,
established or concluded; at least one verified quote) and `not_in_document` (the passages don't address it; no
quote).

Questions (expected label):

- answered: B1 "How many internal research notes were used?" (240); B2 "On what date did the team decide to keep
  keyword search as the default?" (18 March 2026); B3 "How many questions could not be answered because the answers
  were missing from the notes?" (six); B4 "Why wasn't the hybrid prototype rolled out more widely?" (response time).
- document_says_unknown: M1 "Were the quotations in generated answers accurate?"; M2 "Would the hybrid method perform
  similarly on other collections?"; M3 "What did the team conclude about production-scale performance?"; M4 "How
  good were the generated answers?"
- not_in_document: A1 "Which embedding model did the hybrid prototype use?"; A2 "Who funded the study?"; A3 "How many
  users took part in the pilot?"; A4 "What programming language was the prototype written in?"

Adoption rule: adopt the three-label contract only if all hold: valid JSON 12/12; every B labelled `answered` with the
expected fact and a verified quote; every M labelled `document_says_unknown` with a verified quote; every A labelled
`not_in_document` with no quote. Otherwise keep two labels and document the limit (a truthful "not measured" answer
may arrive without a quote).

Also measured: one call with a prompt near the planned passage budget (about 3,000 tokens), for timeouts.

### Prep run with thinking on (written before running it)

I chose Gemma 4 with thinking on. This run measures it under realistic conditions; it has no pass or fail.

- Docker Desktop running with idle Postgres (pgvector) and Redis containers, as in the real stack.
- The 12 held-out questions above, with the agreed two-label contract (M questions count as `answered`).
- Passages: the sample note plus paragraphs of the brief as filler, aiming at about 2,500 prompt tokens.
- `max_tokens` 4,096, 5-minute call cap, full thinking text saved.
- Recorded: labels and quotes, runaways (finish other than stop), median and max time, max thinking tokens, free RAM.
- Rule for the design values: thinking-token cap = 1.5 × the largest non-runaway thinking count; answer timeout =
  1.5 × the slowest non-runaway call. Both rounded up.

### Extra check (written before running it)

Same 12 questions, filler and two-label contract as the prep run; Docker Desktop off this time (my choice), so
timings aren't strictly comparable with the prep run; labels, quotes and runaways are.

1. Backup path: thinking off (`reasoning_effort: "none"`), temperature 0. Informational: how good the thinking-off
   retry is under these conditions.
2. Recommended sampling: thinking on, with the values from LM Studio's `model.yaml` for this model (temperature 1.0,
   top-p 0.95, top-k 64) instead of temperature 0. `max_tokens` 4,096. Adopt these settings only if all hold: fewer
   runaways than the temperature-0 prep run (at most 1 of 12); every finished answer correct with a verified quote
   where one is required; valid JSON on every finished call. Otherwise keep temperature 0. One run of 12 randomly
   sampled answers is a signal, not a rate.

## Results

Docker was stopped during the first runs.

### Embeddings: nomic-embed-text-v1.5 (pass)

- 768 dimensions. LM Studio loads it with a 2,048-token context, so each chunk must stay below that.
- 5 passages in 2.8 s (first call), 4 queries in 0.8 s.
- 4 of 4 reworded queries ranked the expected section first.

### Chat models

| Configuration                                   | Valid JSON | Outcomes right | Quotes verified | Median time | Notes                                                                                   |
| ----------------------------------------------- | ---------- | -------------- | --------------- | ----------- | --------------------------------------------------------------------------------------- |
| Gemma 4 26B-A4B, thinking on                    | 6/7        | 4/5            | 4/4             | 59 s        | Q1 ran away: 4,093 thinking tokens, 283 s, cut off with no answer                       |
| Gemma 4, thinking off                           | 7/7        | 4/5            | 3/3             | 5.3 s       | Q4 ("Did users trust the answers?"): correct text, labelled `not_in_document`, no quote |
| Gemma 4, thinking off, quotes-first field order | 7/7        | 4/5            | 3/3             | 5.4 s       | same Q4 result; field order made no difference                                          |
| Qwen 3.8 27B, default                           | –          | –              | –               | –           | stopped after about 27 min: 1.75 tokens/s (LM Studio log); no per-question results      |

- Three-label test on 12 new questions (Gemma 4, thinking off): 10/12. All answerable and all absent questions right;
  "not established" and "no conclusion" right; both "did not measure" questions labelled `not_in_document` with
  correct text and no quote. That fails the adoption rule, so the answer contract keeps two labels.
- Injection probe (a planted "SYSTEM NOTE" in the document): resisted in every Gemma configuration.
- Follow-up rewrite: correct in every Gemma configuration ("What was the median response time for hybrid search?"),
  1.7–2.6 s with thinking off.
- Longer prompt: 1,799 prompt tokens answered in 8.5 s (the target was about 3,000; the filler came out shorter).
- Load: Gemma 4 cold load 15–16 s, 14.6 GiB, leaving about 5 GB of RAM free. Qwen 3.8: 51 s, 16.5 GiB, 0.6 GB free.
- Thinking controls: only `reasoning_effort: "none"` changed anything. `"low"`, `reasoning: "off"` and
  `chat_template_kwargs.enable_thinking: false` had no effect.

### Prep run: Gemma 4, thinking on, realistic conditions

Docker Desktop running with idle Postgres and Redis; about 2,300-token prompts (the sample note plus 26 paragraphs of
the brief as filler); two-label contract; `max_tokens` 4,096; temperature 0.

- 10/12 correct. Every answer that finished was right, including all four "not measured / not established" questions
  (labelled `answered`, with verified quotes). All quotes verified.
- Runaways: 2 in 12 (B3, A4), each hitting 4,093 thinking tokens at about 292 s with no answer; one of them (A4) was
  provoked by the filler.
  - B3: a real repetition loop: it re-checked the same quote over and over.
  - A4: second-guessing provoked by filler from a different document (the brief mentions Node.js and TypeScript, so it
    kept asking whether "the prototype" meant something there). Real passages come from one document, so this one is
    partly an artefact of the setup.
  - Twelve questions give a signal, not a rate.
- Finished calls: 23–71 s, median about 31 s; largest thinking count 845 tokens (M4).
- RAM: 3.2 GB free with Gemma loaded beside Docker, Postgres and Redis.
- An 8,192-token context would save only about 0.65 GiB (estimate 15.65 vs 16.30 GiB), so it isn't worth it.
- The pre-written rule gave a thinking cap of 1,300 tokens (1.5 × 845) and a timeout of 110 s (1.5 × 71 s). These
  collide: at about 14 tokens/s, 1,300 thinking tokens plus the JSON take about 100–110 s, so the timeout fires at the
  same moment as the cap, and first under load. Corrected design: `max_tokens` (1,300 thinking + room for the answer)
  is the primary stop; the timeout is a generous backstop set after timing the full stack. Still to check in step 2:
  that aborting a request stops generation in LM Studio (Gemma loads with one slot, so otherwise the retry would queue
  behind the runaway).
- The thinking-off retry path and the model's recommended sampling were measured afterwards, in the extra check below.

### Extra check (Docker Desktop off)

Same 12 questions, filler and two-label contract.

| Run                                                                       | Correct | Runaways | Finished calls             | Notes                                                                                                   |
| ------------------------------------------------------------------------- | ------- | -------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| Backup path: thinking off, temperature 0                                  | 8/12    | 0        | 8–11 s                     | all 4 "not measured" questions labelled `not_in_document`, each with a correct explanation and no quote |
| Thinking on, recommended sampling (temperature 1.0, top-p 0.95, top-k 64) | 11/12   | 1        | 20–58 s, median about 29 s | every finished answer correct with verified quotes; largest thinking count 688                          |
| (prep run, for reference) thinking on, temperature 0, Docker on           | 10/12   | 2        | 23–71 s                    |                                                                                                         |

- The adoption rule holds (at most 1 runaway; every finished answer right; valid JSON), so recommended sampling is
  adopted for the thinking-on call. But the rule was met on one question's difference: A4 ran away in both runs, so
  the change is B3 alone, and the two runs also differ in Docker state and in the random boundary tags. Answers are no
  longer identical from run to run. The sampling values were sent in the request; whether LM Studio applied `top_k` is
  unverified.
- Runaways so far: 4 in 31 thinking-on calls across three runs. A4's repeat suggests they follow ambiguous passages
  rather than chance; the real rate is unknown until the benchmark runs on a real document.
- "Not measured" questions: thinking on labelled all 5 distinct ones correctly, over 9 calls (the 4 held-out ones in
  two runs, plus Q4); thinking off missed 4 of 4. So the known limit belongs to the retry path: after a runaway, such a
  question comes back as not found, with a note.
- The remaining runaway (A4) is the filler-provoked one again: the filler describes building "a small version" in
  Node.js and TypeScript, and the model kept weighing whether "the prototype" meant that. No repetition loop like B3
  appeared.
- The backup path never ran away and stayed truthful; its weakness is the label on "not measured" questions, which
  the agreed display covers (the explanation is shown, marked as not backed by a quote).

### Hosted probe: Gemini free tier

OpenAI-compatible endpoint `https://generativelanguage.googleapis.com/v1beta/openai`, key sent as a Bearer token,
through this script with `KEY_FILE` and a short probe script (not included). Only the sample note was sent.

- Availability is unreliable on the free tier. Many calls returned 503 ("high demand") or 429 ("quota exceeded", on
  gemini-3.8-flash). gemini-2.5-flash is "no longer available to new users". gemini-flash-latest returned 403 for one
  setting.
- Chat: gemini-3.5-flash passes the original criteria (the 5 sample questions with default thinking): 5/5 correct,
  every quote verified, Q4 "not measured" labelled `answered` with its quote, the planted note ignored, the follow-up
  rewritten ("How fast was hybrid search?"). Times 7–108 s, median 39 s; one call needed a retry after a 503. Strict
  `json_schema` structured output works.
- Hidden thinking (total minus prompt minus visible tokens in `usage`): 161–377 tokens per call. The 108 s call (Q5)
  thought for 314 tokens, so its time was mostly queueing on the free tier, not thinking. The 1,300-token cap fits;
  whether Gemini counts thinking against `max_tokens` is untested, so the cap is a per-model setting checked in step 2.
- Thinking settings are model-specific, and the docs and the API disagree. Google's docs say thinking can't be turned
  off on Gemini 3 and 4 models. Observed, one call each: gemini-3.8-flash rejected `"minimal"` with a 400;
  gemini-3.5-flash accepted `"low"` (no hidden tokens) and also accepted `"none"` (no hidden tokens, 35 s). So the
  "thinking off" setting is configured per model, not per provider.
- These calls used raw `fetch`. The app uses the `openai` package, and Gemini's error body is an array, not OpenAI's
  error object; step 2 puts a 400, a 429 and a 503 through the package to check the failure table's classification.
- Embeddings: gemini-embedding-2 returns 3,072 dimensions by default and accepts `dimensions: 768`; its query and
  document markers are text prefixes (`task: search result | query: ` / `title: none | text: `). On the 4 reworded
  sanity queries it ranked the right section first 2/4 times (with or without the prefixes, at 768 or 3,072
  dimensions); gemini-embedding-001 got 3/4; local nomic got 4/4. Four queries are only a hint; the benchmark measures
  it properly.
- Google's pricing page says the free tier's content is "used to improve our products", which is why only the
  fictional sample note went to it.

## Honesty notes

- No configuration passed the criteria as written.
- Added after seeing results: the 5-minute call cap, the reasoning setting, the field-order variant, the held-out
  three-label test, the thinking-on prep run and the extra check (each one's questions and rule were written before it
  ran).
- The pre-written rule for design values produced a token cap and timeout that collide; corrected above.

## Outcome

- Qwen 3.8 is too slow on this machine. Gemma 4 26B-A4B is the model.
- I chose thinking on (2026-11-24). The prep run backs it: every thinking-on answer that finished was correct,
  including all four "not measured" questions. The cost is 20–71 s per answer and runaways (2 in 12 at temperature 0,
  1 in 12 with recommended sampling), handled by a token cap and one retry with thinking off (my choice, 2026-11-24).
- Known limit, mainly with thinking off: when the document says something "was not measured", the model may answer
  truthfully but label it `not_in_document` without a quote. The app shows such explanations marked as not backed by a
  quote.
