# Runs against real models

Criteria are written before each run. Wording differs between runs (Gemma's recommended sampling is on), so the
checks are on outcome labels, verified quotes and a key fact, using `scripts/smoke.mjs`.

## Step 2: first full run (criteria written 2026-11-24, before the run)

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

### Results (2026-11-24)

Raw output: [runs/2026-11-24-step2.txt](runs/2026-11-24-step2.txt). These runs used the chunker as it was before
the step 2 review, when the sample note made 5 passages; it now packs its short sections into 3. They have not been
repeated since (the local model was unloaded), and the sample is short enough that the whole note was sent either
way.

The smoke runs went through Docker Compose, the containers reaching the model server on the host. The other checks
below called LM Studio or Gemini directly from the host.

| Run                                              | Result | Times per question                 | Notes                                                                                                         |
| ------------------------------------------------ | ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Gemma 4 + nomic, LM Studio                       | 6/6    | 14–64 s                            | Q4 answered as "not measured" with its quote; the injection attempt answered `not_in_document`                |
| gemini-3.5-flash + gemini-embedding-2, free tier | 5/6    | 22–81 s for the five that finished | Q3 failed as `model_unavailable`: the free tier did not answer before the 240 s timeout (step 3 adds retries) |

Other checks with LM Studio (Gemma loaded with a 16,384-token context):

- A full passage budget (a 47-chunk document whose passages fill the 4,000-token budget by the app's estimate; the
  exact number sent wasn't logged): two questions answered with verified quotes in 66 s and 40 s.
- A prompt over the context size: LM Studio answers 400 ("exceeds the available context size"); nothing is cut
  silently, so step 3 can catch it and shrink the passages.
- Cancelling a request stops generation: LM Studio went idle at once after the client aborted.

And one with Gemini: a rejected setting (`reasoning_effort: "minimal"` on gemini-3.8-flash) reaches the app as a
400 through the `openai` package and is classified `model_rejected`, although Gemini's error body is shaped
differently from OpenAI's.

Still open from the pre-build checks: whether Gemini counts thinking tokens against `max_tokens`, and a 429 and a
503 from Gemini passing through the `openai` package (only a 400 has been seen so far). Both belong with step 3's
retries.
