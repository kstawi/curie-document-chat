# Time log

Times are CET. The four-hour target counts wall-clock time from the first line of code (step 1), minus breaks;
agent run time, model runs and my reviews all count. Everything before step 1 was preparation and is listed
separately. From step 1 on, times are taken with `date` at both ends; earlier rows marked "about" are estimates.

## Preparation (before the clock)

| Date       | From–to           | Work                                                                                   |
| ---------- | ----------------- | -------------------------------------------------------------------------------------- |
| 2026-11-23 | 16:23–17:05       | Read the brief; planned and agreed decisions with the coding agent                     |
| 2026-11-24 | about 09:35–09:50 | Added PDF, upload security, prompt-injection and failure handling to the plan          |
| 2026-11-24 | about 10:25–11:20 | Local model test: embeddings, Gemma 4, Qwen 3.8; model choice                          |
| 2026-11-24 | about 11:20–11:50 | Local model test with thinking on, 12 questions, Docker running; limits for the design |
| 2026-11-24 | about 11:50–12:10 | Local model test: the thinking-off fallback and the model's recommended sampling       |
| 2026-11-24 | about 12:15–12:45 | House style for the look and the writing                                               |
| 2026-11-24 | about 12:45–12:55 | Gap review of the plan, with an independent reviewer                                   |
| 2026-11-24 | 12:55–13:11       | Hosted model probe on Gemini's free tier                                               |

## Build (the clock)

| Date       | From–to     | Step | Work                                                                                                                                                                                                                                                   |
| ---------- | ----------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-24 | 13:17–14:33 | 1    | Repository skeleton, Compose, health checks, first migration, test command; three fresh-agent code reviews and their fixes; commit, push and checks on GitHub                                                                                          |
| 2026-11-24 | 14:33–14:51 | –    | Break: waiting for my go-ahead to load the local model                                                                                                                                                                                                 |
| 2026-11-24 | 14:51–17:04 | 2    | Upload, preparation, search and answers with verified quotes; real runs on Gemma 4 and Gemini; three fresh-agent code reviews and their fixes; commit, push and checks on GitHub                                                                       |
| 2026-11-24 | 17:04–17:18 | –    | Break: waiting for my go-ahead to load the local model                                                                                                                                                                                                 |
| 2026-11-24 | 17:18–17:27 | 2    | Re-run of the real-model checks on Gemma after the review fixes                                                                                                                                                                                        |
| 2026-11-24 | 17:28–19:22 | 3a   | Failure handling in the worker: failure table, thinking-off retry, follow-up rewrite, job retries, shutdown, time limits, heartbeats, sweeper, start-up model check; three fresh-agent code reviews and their fixes; commit, push and checks on GitHub |
| 2026-11-24 | 19:22–20:43 | 3b   | Failure handling at the API: retry endpoints, idempotency keys, waiting limit; three fresh-agent code reviews and their fixes; commit, push and checks on GitHub                                                                                       |
| 2026-11-24 | 20:43–20:47 | –    | Break: waiting for my go-ahead to load the local model                                                                                                                                                                                                 |
| 2026-11-24 | 20:47–21:04 | 3    | Real-model checks of step 3 on Gemma: follow-up rewrite, thinking-off retry, too-long prompt, stopping the worker mid-answer, start-up check                                                                                                           |
| 2026-11-24 | 21:04–22:37 | 4    | Input security and prompt-injection hardening; a live injection run on Gemma; two fresh-agent code reviews and their fixes; commit, push and checks on GitHub                                                                                          |
| 2026-11-24 | 22:37–23:00 | 5    | Live progress over server-sent events: queue events as a nudge, heartbeat re-reads, reconnect rules; tests, deliberate-break check, docs; a live run on Gemma                                                                                          |
| 2026-11-24 | 23:00–23:07 | 6    | PDF: plan reading, a pdf.js prototype on a generated two-column page, questions to me (step 5's first review running alongside)                                                                                                                        |
| 2026-11-24 | 23:07–08:33 | –    | Break: overnight, until I answered (2026-11-25)                                                                                                                                                                                                        |
| 2026-11-25 | 08:33–08:34 | 5    | Read the first step 5 review; asked me about variation selectors                                                                                                                                                                                       |
| 2026-11-25 | 08:34–08:56 | –    | Break: waiting for my answer                                                                                                                                                                                                                           |
| 2026-11-25 | 08:56–09:05 | 5    | Fixes from the first step 5 review: cleanup before the first read, two queue events with tests, stage reset at shutdown, docs; deliberate-break check                                                                                                  |
| 2026-11-25 | 09:05–09:18 | 6    | PDF: parser service with a process per file, extraction in reading order without running lines, generated fixtures, upload and worker changes, quotes with pages (step 5's second review running alongside)                                            |
| 2026-11-25 | 09:18–09:26 | 5    | Fixes from the second step 5 review: tests for the stream's catch-up reads, next line in two more checks, docs; deliberate-break check                                                                                                                 |
| 2026-11-25 | 09:30–09:51 | 6    | PDF: real paper through the containers, fixes for word gaps, accents and line heights, deliberate-break check, docs                                                                                                                                    |
