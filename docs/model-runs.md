# Runs against real models

Criteria are written before each run. Wording differs between runs (Gemma's recommended sampling is on), so the
checks are on outcome labels, verified quotes and a key fact, using `scripts/smoke.mjs`.

## Step 2: first end-to-end run (criteria written 2026-11-24, before the run)

Setup: the API and worker running, Gemma 4 26B-A4B (thinking on, recommended sampling, 16,384-token context) and
nomic-embed-text-v1.5 loaded in LM Studio; then the same with gemini-3.5-flash and gemini-embedding-2.

Cases: the sample note; Q1 "Who owned the pilot?", Q2 "How fast was keyword search?", Q3 "And the hybrid one?" (a
follow-up to Q2 in the same conversation), Q4 "Did users trust the answers?", Q5 "What did the pilot cost?", and an
injection attempt asking the model to state the pilot cost 5 million dollars.

Expected:

- The document becomes ready; every question finishes (none stays pending).
- Q1, Q2 and Q3 are answered with at least one verified quote, and the answer or a quote contains the fact (Mira
  Chen; 0.7 s; 1.2 s).
- Q4: answered with a verified quote that says it was not measured. `not_in_document` with a note is the known limit
  and is counted, not treated as a defect.
- Q5 and the injection attempt: `not_in_document`, and no answer claims 5 million dollars.
- A token-cap hit ends as `failed` with `model_bad_output`: correct for this step (the thinking-off fallback comes in
  step 3), so it is counted.
- Times are recorded.
