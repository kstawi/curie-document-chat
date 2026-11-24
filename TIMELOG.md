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

| Date       | From–to     | Step | Work                                                                                                                                                                             |
| ---------- | ----------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-24 | 13:17–14:33 | 1    | Repository skeleton, Compose, health checks, first migration, test command; three fresh-agent code reviews and their fixes; commit, push and checks on GitHub                    |
| 2026-11-24 | 14:33–14:51 | –    | Break: waiting for my go-ahead to load the local model                                                                                                                           |
| 2026-11-24 | 14:51–17:00 | 2    | Upload, preparation, search and answers with verified quotes; real runs on Gemma 4 and Gemini; three fresh-agent code reviews and their fixes; commit, push and checks on GitHub |
