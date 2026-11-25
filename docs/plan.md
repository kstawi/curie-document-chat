<!-- A copy of the planning document the coding agent worked from, as it stood on 2026-11-25 during step 9. -->

> Cleaned for the repo. "The user" and "you" are the author; "I" is the agent. Left out: the last section (notes for
> the interview discussion), account, machine and personal details, and the hiring page's address. `CHALLENGE.md` is
> `scripts/model-check/brief.md` here, and `step0/` is written up in `docs/model-check.md`. The status paragraph is a
> running log, written as the work went.

# Curie take-home: plan

Source: Curie's hiring page (read 2026-11-23). Brief saved as `CHALLENGE.md`.
**Status: approved by the user on 2026-11-23; PDF and hardening additions approved on 2026-11-24; step 0 done on
2026-11-24 (results in `step0/RESULTS.md`); gap review folded in on 2026-11-24.** The coding clock started at 13:17
on 2026-11-24 with step 1; the time log now lives in the repo's `TIMELOG.md`. **Step 1 done** 13:17–14:29 (three
fresh-agent reviews), committed `aa6d41b`, pushed to private `kstawi/curie-document-chat`, signature verified.
**Step 2 done** 14:51–17:04 (real runs on Gemma 4 and Gemini, three fresh-agent reviews), then a Gemma re-run on
the final code 17:18–17:27 (6/6, full budget answered), pushed up to `ed65300`, all commits verified. The Gemini run
was not repeated. **Step 3a done** 17:28–19:22 (worker failure handling, three fresh-agent reviews), pushed up to
`da4cacd`, all commits verified; run only against the fake model so far. **Step 3b done** 19:22–20:43 (retry
endpoints, idempotency keys, waiting limit, request-to-job log lines; three fresh-agent reviews), pushed up to
`d0d0f44`. Real-model session for step 3 on Gemma done 20:47–21:04 (all five criteria met; pushed `9ebb0ec`);
Gemini not run (its `max_tokens` and 429/503 questions stay open; needs the user's word and the key in `.env`).
Next: step 4, after the user's go-ahead. **Changed by the user on 2026-11-24 at 22:15:** at most two fresh reviews per
step, each running alongside the next step instead of being waited for (each review in its own worktree at the
reviewed commit, with its own Compose project name, since `compose.yaml` fixes the project name); a standing OK to
load the local model unless the user says to stop. **Step 4 done** 21:04–22:37 (two fresh-agent reviews; live injection
run on Gemma 3/3, twice), pushed up to `f71f891`. Next: step 5 (SSE). Workflow from step 5: commit a step locally, start
its review in a worktree with its own Compose project (container-only test runs, `down -v` at the end), and build the
next step on a branch in its own worktree, so `main` only ever holds reviewed steps. **Step 5 done** 2026-11-24 22:37 to 2026-11-25 09:30 (overnight break excluded in TIMELOG): SSE progress, two fresh
reviews and their fixes, live run on Gemma; pushed up to `1cfed56`. Decided with the user 2026-11-25: two-column PDFs
are reordered by position; running headers and footers are removed from the stored text; one real paper (Sentence-BERT,
arXiv 1908.10084, CC BY-SA 4.0) may be downloaded for a hand test, outside the repo, read only through the parser;
only variation selectors U+FE0E and U+FE0F are kept for the model. Commit before switching branches (no stashing). Later on 2026-11-25 the user said to load no AI models until asked (both unloaded), and, after seeing the benchmark's two rounds and caveats, chose to keep hybrid search. After step 6's second review the user chose that a running head or repeated line keeps its first copy (a table that repeats its heading on every page keeps it once); page numbers are all dropped. **Steps 6 and 7 done**, two fresh reviews each and their fixes, pushed up to `eee8d58` (2026-11-25 11:3x); the last fix commits had no fresh reviewer (two-review cap). **Step 8 done**: two fresh reviews and their fixes, pushed up to `0583f99` (2026-11-25 12:3x); the last fix commit had no fresh reviewer (two-review cap). Left from review 2, not fixed: Enter during Safari IME conversion still sends; a question of only invisible characters shows the API's raw validation text; nginx buffers uploads in memory-backed `/tmp` under its 64 MB limit; the dev server's origin is documented in `.env.example`, not fixed. Open with the user: the server applies Markdown heading rules to plain-text documents too (review 2, out of scope). Step 9 on `step-9` (rebased on main, 254 server tests pass): `docs/openapi.json` from the route schemas with a test (`@fastify/swagger` 9.9.5, already in the lockfile as a peer). Fixed in step 9: the step 8 edge-cases intro now says the Enter row ran without a worker, in a smaller window (the only row checked that way). The dev database holds stand-in vectors and "stand-in answer" conversations, and one copy of the Sentence-BERT paper is indexed as `fake-embed`: wipe or re-prepare before any real-model pass and before the recording. Found by the run: the search sends at most 40 passages, so
`PASSAGE_TOKEN_BUDGET` far above the default does nothing (document in step 9); check "a short document goes in
whole" against a document of more than 20 small chunks (step 7). Settled in step 4 (user, 2026-11-24; the line that listed them as open was stale): the 20/20 waiting limits, the 24 h
key window, and no retry for a document that failed for a lasting reason. Decided with the user on 2026-11-25 for the
permissions note: team spaces (members read and ask; the uploader or a space admin re-prepares or deletes); whether
members see each other's conversations is left open. Step 9 so far: the step notes moved to `docs/build-notes.md`,
DESIGN.md rewritten by the brief's topics (about 1,900 words), `docs/model-check.md` with the script and a byte copy of
the brief in `scripts/model-check/`, `docs/ai-use.md` and a cleaned copy of this plan in `docs/plan.md`.

**Still needed from the user:** the free-tier limits for gemini-3.5-flash and gemini-embedding-2 from the usage page
(the probe used about 40 requests; step 2's hosted check runs on the clock); the reviewers' GitHub logins and the
submission channel (before step 11). There is no
fixed deadline (user, 2026-11-24), so the drop order in §11 only applies if that changes.

## 1. Context

- The brief is the task to build (user, 2026-11-23). This page is an older version: Curie dropped the live-coding
  interview. Everything else in the brief still applies (user, 2026-11-23).
- **Time:** aim for the brief's ~4 hours, counted from the moment we start writing code (step 1). Going over is fine;
  code quality matters most (user, 2026-11-23). The extras (UI, streaming, PDF, hardening, benchmark) will push well
  past 4 hours; the time log reports that honestly, and the planning before step 1 is reported as separate prep.
- Still expected: a private GitHub repo shared with the reviewers, README.md, DESIGN.md, tests, a 3–5 min recording,
  AI-use disclosure, and a technical discussion (trace a request, explain a failure, reason about a change).
- How they judge (role expectations, 1–4): backend architecture & data 4, reliability & failure handling 4, product
  judgment & ownership 4, async processing 3, AI integration 3, frontend 3 (integration spec + past work), permissions
  3 (design note). Their words: "A smaller, well-reasoned system is better than a larger one you cannot explain."
  Every mechanism below must be explainable by the user; the README lists the failure modes as tested automatically,
  checked by hand, or not verified, and never calls the system "failure-proof".

## 2. Decisions (agreed with the user on 2026-11-23 and 2026-11-24)

| Topic | Decision |
|---|---|
| Scope | Required core + **PDF upload** + **React/Vite web UI** + **live progress streaming**. Permissions: design note only. Short "a million documents" section in DESIGN.md. |
| Hardening | **Build and test everything in §4–§6 except virus scanning** (ClamAV: described in DESIGN.md only; no external systems for this assignment). Includes queue back-pressure, idempotency keys and a separate no-network PDF-parsing container. |
| PDF | Text extracted in the isolated parser container. The UI shows the **extracted text** with page markers. **Scanned PDFs are rejected** with a clear reason (OCR is a next step). **Originals are kept** in their own table (the retry endpoint re-extracts from them) and are **never served back**. |
| Limits | PDF: **5 MB, 100 pages**. Markdown/plain text: **1 MB**, UTF-8 only. Question: 2,000 characters. Title: 200 characters. Quote: at least 20 characters. |
| Stack | TypeScript 6.0 (strict, ES modules; typescript-eslint doesn't support 7 yet); Node 22 LTS here and in Docker; Fastify with zod schemas on every route (zod also validates model output), OpenAPI generated and committed; PostgreSQL 17 + pgvector via `pg` and Kysely (raw SQL where pgvector and full-text need it), Kysely migrations under an advisory lock; BullMQ on Redis 7, worker progress to the API through BullMQ queue events; the official `openai` package with its own retries off and explicit timeouts; Vitest; React + Vite + TypeScript served by an unprivileged nginx that also proxies `/api`; npm workspaces, Prettier, ESLint, tsx in dev (user, 2026-11-24). |
| Model | **LM Studio on the host**, called through the OpenAI-compatible API (base URL, model names, reasoning and sampling settings from env, per provider). Chat: **Gemma 4 26B-A4B with thinking on** (user, 2026-11-24; Qwen 3.8 was too slow at 1.75 tokens/s). Embeddings: nomic-embed-text-v1.5, 768-d, loaded with a 2,048-token context. Automated tests use a fake model and need no key or model. |
| Thinking | Thinking-on answers take 20–70 s. In step 0 they ran away (4,093 tokens, about 5 min) 4 times in 31 calls, apparently on ambiguous passages. So the answer call has a token cap, then **one retry with thinking off** (`reasoning_effort: "none"`, about 5–9 s) (user, 2026-11-24). The follow-up rewrite runs with thinking off (correct in every test, about 2 s) (user, 2026-11-24). The thinking-on call uses the model's recommended sampling (temperature 1.0, top-p 0.95, top-k 64, from LM Studio's `model.yaml`), adopted by step 0's pre-written rule on a one-question difference; whether LM Studio applies `top_k` is unverified. Answers therefore vary slightly between runs, including in the recording; the smoke script checks labels and verified quotes, not wording. Thinking-off calls stay at temperature 0. |
| Run paths | **Two tested ways to run**, both in the README: a hosted key on any OpenAI-compatible service, and LM Studio (with the hardware it needs). The hosted path is tested **early, in step 2**, on Google Gemini's free tier (user, 2026-11-24). Pre-clock probe with raw HTTP calls (`step0/RESULTS.md`): **gemini-3.5-flash** passed all step 0 criteria with strict structured output; the free tier often returns 503/429 and takes 7–108 s per answer (mostly queueing), so the README recommends a paid key for a smooth run. Thinking settings, the token cap and embedding prefixes are **per-model settings** (gemini-3.5-flash accepted `"low"` and `"none"`; 3.8 rejected `"minimal"`; the docs say thinking can't be disabled on Gemini 3+). Embeddings: gemini-embedding-2 at its default size with its own prefixes. Free-tier content may be used by Google, so only the fictional sample and our own generated text go to it, never the brief's text. The key lives in a file outside the repo; the conversation export removes it. |
| Search | **Hybrid**: Postgres full-text (OR-matched, `ts_rank_cd`, English) + exact vector search within the one document, merged by reciprocal rank fusion. Follow-ups rewritten into standalone questions first. Chunks added best-first up to a configurable passage budget (default about 4,000 tokens; §3). |
| Search evidence | **Benchmark** on a generated, paper-length fictional document (labelled as generated): 20–30 questions (paraphrases, exact names/numbers, rewritten follow-ups), expected passages labelled by character span; hit@1 and hit@3 for keyword, meaning and hybrid, run with **both embedding models** (local nomic and Gemini's), since hosted-path reviewers get different embeddings. Decision rule written before the first run. Results committed with model name and date. Runs separately from the automated tests. |
| Answer delivery | **Server-sent events with progress only** (queued → understanding the follow-up → searching → writing → checking quotes), then the complete verified answer. Unverified text is never shown as an answer. One exception: a `not_in_document` result carries the model's short note (its own field, at most 300 characters, plain text, marked "not backed by a quote"), because it claims absence rather than a fact. An `unsupported` draft stays hidden because it claims a fact that failed verification. The note can still carry text planted by a document, hence the cap and an injection test on it. A plain GET returns the stored result. |
| Way of working | **Step by step in this session. Each step ends with a full code review by a fresh reviewer agent, fixes and a re-run of every check (at most three reviews); only when it's polished do I commit and push** (user, 2026-11-24, replacing "the user reviews each step"). Ask the user before loading any local model (user, 2026-11-24). Fable (advisor) checks approach choices and each step before it's called done. Each step ships with its own tests and writes its own DESIGN.md section while the reasons are fresh. No git tag at the 4-hour mark. |
| Repo | **Private GitHub repo `kstawi/curie-document-chat`, created in step 1 and pushed as we go**, so the history shows the real order of the work (user, 2026-11-24); shared with the reviewers at the end. Before sharing: one scan of the full history for secrets and personal data. Every staged diff is also scanned before each commit and push (emails other than the commit identity, tokens and keys, local paths, notes about the build machine, employer details, chat-style wording). Commits are signed, with a repo-local identity and credentials. **No CI** (user, 2026-11-24). **No licence** (all rights reserved), and the README says it's an unaffiliated take-home for Curie (user, 2026-11-24). |
| AI-use disclosure | Commit **excerpts of the global rules that applied** (personal and work details removed) plus **a list of the plugins, hooks, advisor and skills used** (user, 2026-11-24); the project's own `CLAUDE.md` from the first commit; a running log of mistakes caught in AI output from step 1; a redacted export of the conversations (this one and its helper agents), which the user reads before it's committed. Step 0 is disclosed as pre-clock work; anything from it carried into the repo (prompt, schema, quote matching) is disclosed as pre-clock code. |
| Step 0 evidence | A **cleaned step 0 summary and its test script** go in the repo, with the hardware described generically and the brief's text kept as filler, so the numbers reproduce exactly (user, 2026-11-24; the repo is private and its readers wrote the brief). A cleaned copy of this plan goes in the AI-use docs (user, 2026-11-24). |
| Time log | `TIMELOG.md` records work, breaks and prep, with `date` taken at both ends of each row. The ~4 h clock is wall-clock time from step 1 minus breaks, so it includes agent run time, model runs and the user's reviews (user, 2026-11-24); total and overrun reported in the README. |
| Recording | Hosted on **Google Drive** (user, 2026-11-24); link in the README and the submission. Spoken from an outline (§11 step 10). |
| Web UI scope | Upload, document status, chat with live progress steps, quotes under each answer; clicking a quote highlights it in a full-document view. Desktop-first; current Chrome, Firefox and Edge. |
| House style | Look and writing follow §12 (user, 2026-11-24): the same visual family as curie.is without its logo or pixel motif; Markdown shown as styled lines with dimmed marks; commits keep the `Co-Authored-By` line; DESIGN.md in first person for decisions the user made; test hardware described generically. |

## 3. Architecture

```
browser ──> web (nginx: static app + /api proxy) ──HTTP + SSE──> api (Fastify) ──> PostgreSQL + pgvector
                                                                    │                   ▲
                                                                    └─ enqueue ─> BullMQ (Redis) ─> worker ──> model
                                                                                                      │
                                                                      internal-only network (no internet, no DB)
                                                                                                      │
                                                                                                 pdf-parser
```

- One `server` package with three entry points (`api`, `worker`, `pdf-parser`) sharing db, model client, text and
  retrieval code; one `web` package. npm workspaces.
- Docker Compose services: `postgres` (pgvector image), `redis` (AOF on; `maxmemory` below its container limit with
  `noeviction`, which BullMQ needs), `api`, `worker`, `pdf-parser`, `web`, and a `test` service used only by the test
  command. Named Compose project. Every published port is bound to **127.0.0.1** and avoids ports
  already in use on the build machine. Postgres and Redis are not published in the full stack.
- `web` is an unprivileged nginx serving the built app and proxying `/api` to the API, so the browser sees one origin
  (no CORS). The SSE route has proxy buffering and compression off. The API's Host check compares the hostname without
  the port, and nginx forwards the original Host.
- Networks: `backend` (web, api, worker, postgres, redis); `parser` with `internal: true` (worker, pdf-parser only).
- Hardening per image: our own images (api, worker, pdf-parser, web) run as non-root with `no-new-privileges`, all
  capabilities dropped and read-only root filesystems where possible. The official postgres and redis images keep
  the capabilities their entrypoints need on first start (recalled: they change file ownership and switch user;
  checked when implementing) but get `no-new-privileges`, no published ports and memory limits. Memory and process limits everywhere, strictest on
  `pdf-parser`, sized after measuring the full stack. Healthchecks, and `depends_on: condition: service_healthy`.
- `extra_hosts: host.docker.internal:host-gateway` on worker so Linux reviewers can reach a host model too (README
  notes the model must listen beyond 127.0.0.1 there). Unverified: the build machine only has Docker Desktop and there is no CI.
  No bind mounts; `.dockerignore` excludes `node_modules`.
- Development loop: api and worker run on Windows against the Compose services; a dev-only override publishes
  Postgres, Redis and the parser on 127.0.0.1. The full stack is what reviewers run and what the final checks use.
- **Test command**: `docker compose run --rm test` runs lint, type checks and all automated tests against its own
  database and queue prefix, so it needs no Node on the host and never touches dev data.
- Configuration: `.env.example` documents every setting (model base URL, model names, per-provider reasoning and
  sampling, embedding prefixes, passage budget, limits, allowed origins and hosts) with no credentials; `.env` is
  git-ignored and holds the hosted key.
- Migrations run once at start-up under a Postgres advisory lock; the API sets a `statement_timeout` and a bounded
  connection pool.
- LM Studio: the README loads both models explicitly, with no idle timer, so a request never triggers a 15 s load
  (step 0 had both loaded together; whether a just-in-time request can evict the other model is checked when
  implementing). Both queues share one LM Studio and one GPU, so separate queues keep a big PDF from blocking
  answers only at the queue level; DESIGN.md says so.

**Data model**
- `documents`: id, title (display only, cleaned), format `markdown | text | pdf`, content (stored text; §5), page map
  for PDFs (page → start/end offset), status `queued | processing | ready | failed`, error code + safe message,
  attempt, heartbeat_at, embedding model, created_at, updated_at.
- `document_files`: document_id, original bytes, size, SHA-256, detected type. Never returned by any endpoint, never
  put in job payloads (jobs carry ids only).
- `chunks`: document_id, ordinal, start/end offsets, heading path (or "page N"), text, full-text vector, embedding
  (`vector` with no fixed size, so 768-d, 1536-d and 3,072-d models all fit; exact search needs no index).
- `conversations`: id, document_id, created_at.
- `messages` (built in step 2 as `turns`, one row per question and answer, agreed with the advisor 2026-11-24): conversation_id, sequence, created_at, role, content, status `pending | completed | failed`, current
  progress stage, attempt, heartbeat_at, outcome `answered | not_in_document | unsupported`, note (≤ 300 characters,
  `not_in_document` only), quotes (text, start, end, line, section, start and end page for PDFs), standalone question
  used for search, answer path (`thinking` or `thinking_off_retry`), chat model name, error code. Debug columns (raw
  model draft, unverified quotes, raw provider error) are never returned by the API or written to logs. A **partial
  unique index** allows only one pending answer per conversation.
- `idempotency_keys`: key, route, request hash, status (in flight or done), stored response, expiry; expired keys are
  purged by the sweeper.

**API** (the integration spec: `openapi.json` exported from the Fastify schemas and committed, with a test that fails
when it's out of date, plus `docs/integration.md` for the SSE events and offsets)
- `POST /documents` (multipart: one file + optional title) → 202 `{id, status}`; `GET /documents` (list, newest
  first, paginated); `GET /documents/:id` → status and failure code/reason; `GET /documents/:id/content` → stored text
  and page map for the UI (never the original file); `POST /documents/:id/retry` re-runs preparation (re-extracting
  PDFs from the kept original) for a failed document or one whose embedding model no longer matches the configured one.
- `POST /documents/:id/conversations` → 201; `GET /documents/:id/conversations` (list).
- `POST /conversations/:id/messages {question}` → 202 with the answer's id. 409 if the document isn't ready, its
  embeddings came from a different model than the configured one (`embedding_model_changed`; compared by stored model
  name, not vector size), or an answer is still pending in that conversation. `GET /conversations/:id/messages` (full
  history, ordered by sequence). `POST /messages/:id/retry` for a failed answer.
- `GET /messages/:id` → stored state. `GET /messages/:id/events` → SSE: subscribe to live events **first**, then send
  the current state from the database (including the stored progress stage), then live progress and the final answer
  (event id `final`), then **close**. A reconnect carrying `Last-Event-ID: final` gets 204, which stops `EventSource`
  replaying forever; a new client arriving after the end still receives the stored final answer once. Heartbeat
  comments keep idle connections open.
- POSTs accept an `Idempotency-Key` header: same key and body returns the first response; same key with a different
  body returns 422; same key while the first request is still in flight returns 409. For uploads the request hash is
  computed while streaming.
- Offsets everywhere are **UTF-16 code units** (JavaScript string indices).
- Errors use fixed codes (`file_too_large`, `unsupported_type`, `invalid_encoding`, `empty_document`, `pdf_encrypted`,
  `pdf_no_text`, `pdf_too_many_pages`, `pdf_parse_failed`, `pdf_parse_timeout`, `model_unavailable`,
  `model_rejected`, `model_bad_output`, `context_too_long`, `embedding_model_changed`, `max_attempts`, `busy`,
  `internal_error`, …) and safe messages. Raw provider or parser errors never reach clients.

**Preparation job**: Markdown/text: heading- and paragraph-aware chunks; PDF: paragraph chunks within pages (heading
path "page N"); a few hundred tokens each with exact offsets; a paragraph or page with no breaks is hard-split (by
sentence, then by length) well below the embedding model's 2,048-token context; token counts are estimates
(tokenizers differ), so budgets keep a safety margin; heading path prepended to the indexed text; embedded in batches
(nomic's `search_document:` / `search_query:` prefixes from config, confirmed on its model card); all chunks written
in one transaction, so a re-run replaces them.

**Answer job**
1. Follow-up → the model rewrites it into a standalone question from the last 3 turns (questions and verified answers),
   thinking off. The rewrite is only a search query (length-capped), never instructions. If the rewrite fails (timeout,
   invalid JSON, empty), search uses the original question plus the previous one.
2. Hybrid search over that document's chunks; fill the passage budget best-first. A question with only stop words or
   punctuation gives an empty keyword query and falls back to the vector ranking.
3. Model call (§6; budget in §8); returns the JSON shape tested in step 0: `outcome` (`answered | not_in_document`),
   `answer`, `quotes`. For `not_in_document` the server moves `answer` into the note (capped at 300 characters).
4. Server verifies each quote through the matching copy (§5), **only inside the document ranges sent to the model
   that turn** (adjacent ranges merged, so a quote may cross a chunk boundary), with a **minimum length of 20
   characters**. If the text repeats, the first match in the sent ranges, in the order they were sent, wins. It records
   offsets, line, section and pages. Unverified quotes are dropped and kept in the debug columns.

Context arithmetic (in DESIGN.md as the "model-context limits" answer): 16,384-token context = passages (default
about 4,000) + system rules and last 3 turns (up to about 1,500) + thinking cap (1,300) + answer room (about 400) +
a safety margin. Step 2 times one call at the full default budget, and checks what LM Studio does with an over-long
prompt (error or silent truncation).

What the client sees:
- `answered`: answer plus at least one verified quote. This includes "the document says this wasn't measured": in
  step 0, thinking on labelled all 5 such questions correctly over 9 calls. Documented limit: the thinking-off retry
  missed 4 of 4, so after a runaway such a question comes back as `not_in_document` with a note.
- `not_in_document`: "Not found in the document" plus the model's note, marked as not backed by a quote
  (user, 2026-11-24).
- `unsupported`: the model claimed an answer but none of its quotes verified, so it isn't shown ("an answer was
  produced but no supporting passage could be verified").
- Every answer records its path (thinking or the thinking-off retry), since the two can label a question differently.
- Limit named in DESIGN.md: a verified quote proves the passage exists in the document, not that the answer follows
  from it.

**Web UI**: upload a document, watch its status (with retry for failures), chat with live progress steps, and see each
answer's quotes; clicking a quote highlights it in the document view (uses the stored offsets). PDFs show their
extracted text with page markers. Everything is rendered as **plain text**: no raw HTML, no Markdown links or images
(blocks phishing links and image-URL data exfiltration planted through a document), no `dangerouslySetInnerHTML`;
document text is shown in bidi-isolated elements. Markdown is shown as **styled lines**: a line's leading marker
(`#`, `>`, `-`) picks its style, and the marker characters stay visible but dimmed. No character is removed or
rewritten, so quote offsets stay exact (user, 2026-11-24).

## 4. Upload security

- Limits enforced **while receiving**, not after: multipart `fileSize`, exactly one file, few fields/parts/headers;
  JSON `bodyLimit`; 413 early. Nothing buffered beyond the limit.
- The file type comes from the **content**, never the client's name or Content-Type: `%PDF-` magic bytes for PDF;
  otherwise the bytes must decode as strict UTF-8 (BOM stripped). UTF-16 and other encodings → `invalid_encoding`.
  NUL bytes → rejected as binary. Allowlist: Markdown, plain text, PDF.
- The client's filename is never used for storage or paths (bytes live in Postgres); it's kept only as a cleaned,
  length-capped display title.
- Browser writes are accepted only from the configured web origin: a request whose `Origin` header is present and not
  on the list is rejected; a missing `Origin` (curl, scripts, the README flow) is allowed. A `Host` allowlist
  (`localhost` and `127.0.0.1` by default, from config, compared without the port) blocks DNS-rebinding tricks.
  Without auth, this is what stops any website from uploading to the local API.
- `@fastify/helmet` security headers on the API, matching headers (CSP, nosniff, frame-ancestors) from nginx for the
  app; `@fastify/rate-limit` on uploads and questions (in-memory; one API instance).
- Every route schema-validated with `additionalProperties: false`, UUID path params, length caps → 400, never 500.
- Back-pressure: when a queue's waiting jobs pass a threshold, new uploads/questions get 503 + `Retry-After` (`busy`).
- SQL is parameterised only; the OR keyword query is built by Postgres from the raw question
  (`replace(plainto_tsquery('english', $1)::text, '&', '|')::tsquery`), never as tsquery syntax in JavaScript.
- Logs carry ids, sizes, lengths and codes, never document text, questions, quotes or raw provider errors (those live
  in the database's debug columns); secrets are redacted.
- Dependencies pinned with a lockfile; `npm audit` checked before submitting.
- PDF parsing (§7) is isolated in its own container.
- Virus scanning (ClamAV) is described in DESIGN.md as the production next step, not built.

## 5. Text handling

- **Stored text is cleaned minimally**: decoded, BOM removed, line endings unified to LF. For PDFs, the extracted text
  joined page by page with a page map. All offsets refer to this stored text.
- **Quote matching uses a normalised copy with an offset map** back to the stored text: Unicode NFKC, whitespace
  collapsed, line-end hyphenation joined, quote and dash variants unified, invisible characters removed.
- Text sent to the model has control characters, Unicode tag characters (U+E0000–E007F) and bidi overrides removed,
  so hidden instructions don't reach it. Titles and questions get the same cleaning plus NFC and length caps.
- Full-text search assumes English (documented).

## 6. Prompt-injection hardening

Assumption stated in DESIGN.md: injection can't be fully prevented, only contained. Layers:
1. **Nothing to steal or trigger**: the model has no tools, the prompt has no secrets, and retrieval is scoped to one
   document by code, not by the model. Worst case is a wrong answer about the same document for its own reader.
2. **Separation**: system rules first; passages, earlier turns and the question each in labelled blocks wrapped in a
   random per-request boundary tag the document can't guess; the rules say block contents are data.
3. **Strict output**: JSON schema in the request, then parsed and validated (zod); off-schema output goes through the
   per-answer budget (§8). Thinking text is stripped if a model emits it. Answer and note lengths capped.
4. **Decisions in code**: quotes verified against the document; the outcome is decided by the server.
5. **Safe rendering**: plain text only in the UI (§3).
6. **Tests**: injection fixtures (fake system lines, fake closing tags, "ignore previous instructions", tag-character
   payloads, a payload aimed at the note) check the structural defences with the fake model; the live smoke script
   runs a few against the real model, and DESIGN.md reports the results honestly.

## 7. PDF

- `pdf-parser` service: a small HTTP endpoint on the internal network. Each extraction runs in a **child process**,
  which gives crash isolation and a clean kill on timeout. Its `--max-old-space-size` caps only the JS heap; real
  memory is capped by the container limit. An out-of-memory kill can take the parser's server down too, so Compose
  restarts it; a crashed extraction process is `pdf_parse_failed`, and a parser server that is down is retried with the job, then `pdf_parser_unavailable` (as built, 2026-11-25). Parser library: pdf.js (`pdfjs-dist`, ES
  modules only, or the `unpdf` wrapper), current release pinned, with JavaScript evaluation disabled
  (`isEvalSupported: false`). Its known font-evaluation CVE and fixed version are from memory and are checked against
  the advisory when implementing.
- Rejected with readable codes: encrypted PDFs, no text layer (scanned), over 100 pages or 5 MB, empty or mostly
  non-text output, timeouts and crashes.
- The worker treats the parser's reply as untrusted: size-capped and shape-validated (zod) before anything is stored.
- pdf.js returns text in drawing order, so **two-column papers can interleave**. Before PDF is called done: a
  generated two-column PDF fixture (our own text printed with CSS columns, licence-clean) and one real open-licence
  paper tested by hand (not committed). Running headers and footers, and quotes that cross a page break (reported with
  start and end page), are handled in this step.

## 8. Reliability

- **Model calls**: the `openai` package's own retries are off (`maxRetries: 0`) and every call has an explicit
  timeout, so all retrying happens in the one place below. (Its defaults, recalled as 2 retries and a 10-minute
  timeout, are checked when implementing.) zod objects for model output and requests are strict, so unknown keys are
  rejected rather than silently stripped.
- **Token cap first, timeouts as backstops**: `max_tokens` = 1,300 thinking tokens + room for the JSON answer. The
  1,300 came from the temperature-0 run's largest count (845 × 1.5) and still clears the adopted sampling's 688.
  Step 0 timings (about 2,300-token prompts): finished thinking answers 20–71 s, runaways about 290 s at 4,093 tokens,
  cold load 14–16 s, 3.2 GB RAM free beside Docker, Postgres and Redis. Timeouts are generous backstops, set after
  timing the full stack in step 2. Step 2 also checks that aborting a request stops generation in LM Studio (one
  slot, so a retry would otherwise queue behind the runaway).
- **What each failure does** (one table, so no retries hide anywhere else):

  | Failure | Thinking-on answer call | Thinking-off retry | Follow-up rewrite | Embeddings |
  |---|---|---|---|---|
  | Token cap hit | thinking-off retry | `model_bad_output` | fallback query | – |
  | Invalid JSON or schema | thinking-off retry | `model_bad_output` | fallback query | – |
  | Call timeout | thinking-off retry | job retry (a 5–9 s call timing out means the server is stuck) | fallback query | job retry |
  | 429, 5xx, connection refused | job retry | job retry | job retry | job retry |
  | Context too long | shrink the passages once, then `context_too_long` | `context_too_long` | fallback query | `internal_error` (a chunk is too big: a bug) |
  | Other 4xx (incl. a rejected thinking setting) | `model_rejected` | `model_rejected` | fallback query | `model_rejected` |

  "Job retry" = BullMQ attempt with backoff, at most 3 per job, each rerunning the whole sequence; after the last one
  the row is `failed` with `model_unavailable`. A job-level timeout caps the whole answer. The "thinking off" call
  uses the model's configured setting for it (LM Studio Gemma: `"none"`; gemini-3.5-flash: `"low"`); for a model with
  no thinking switch, it is the same call at temperature 0.
- **Configuration check at start**: the worker makes one tiny call per configured model (thinking off) at start-up.
  A 400 or 404 (wrong model name, rejected thinking setting; the probe saw one) is reported as a configuration error
  in the logs and on `/ready`. A 429, 503 or refused connection reads as "model unavailable", never as a configuration
  error. The check never blocks start-up.
- **Two counters, kept apart**:
  - BullMQ's per-job attempts count job retries for infrastructure errors (the table above).
  - The row's `attempt` changes only on a sweeper re-enqueue or a retry-endpoint call; each starts a new job id
    (`<row id>-<attempt>`), and the guarded update compares this one. Sweeper re-enqueues are capped
    (`max_attempts`); a retry from the user always starts a fresh attempt.
  - A shutdown abort puts the job back without spending an attempt (BullMQ's delay-and-`DelayedError` pattern), so
    restarts never exhaust a healthy job. A stalled job uses BullMQ's separate stalled count.
  - All of this is checked against the BullMQ docs when implementing.
- **Separate queues** for preparation and answers; concurrency 1 on the model-bound queue (LM Studio is effectively
  serial).
- **Guarded state changes**: `UPDATE … WHERE status IN (…) AND attempt = $n`, so a stale retry can't overwrite newer
  state.
- **Job ids include the attempt number**: BullMQ ignores an add whose id already exists (failed jobs included).
  Completed and failed jobs are kept for a set time and count (`removeOnComplete` / `removeOnFail`), long enough for
  the sweeper to read their state, and then removed so Redis doesn't grow. (Checked against the BullMQ docs when
  implementing.)
- **Sweeper** (worker start + interval): for a row stuck in `queued`, first checks whether its job exists and is
  simply waiting (with concurrency 1 and minute-long answers that's normal) and re-enqueues only if it's missing; marks
  rows stuck in `processing` / `pending` (stale heartbeat) as failed or re-enqueued based on job state, which also
  covers stalled-limit failures and an OOM-killed worker. Every re-enqueue counts against the row's attempt cap; past it
  the row becomes `failed` (`max_attempts`). It also purges expired idempotency keys. Rejected alternative: a
  Postgres-backed queue (pg-boss), which removes the insert/enqueue dual write but drops the preferred BullMQ.
- **Heartbeats**: the worker touches `heartbeat_at` during long jobs.
- **Retry endpoints** for failed documents and answers; **idempotency keys**; **back-pressure** (503) on long queues.
- **Shutdown**: answers take up to about 2 minutes, longer than Docker's stop grace period (about 3 s on the build machine,
  measured in step 1's review; the API sets 20 s). On SIGTERM the worker
  stops taking jobs, aborts its in-flight model call and puts the job back without spending an attempt, so it reruns
  on the next start; `stop_grace_period` is set to 30 s for that. `/health` (liveness) and
  `/ready` (DB + Redis; model reported as degraded, not down).
- Redis AOF on; Postgres is the source of truth; the sweeper is the backstop.
- SSE: closes on the final event, heartbeats, cleanup on disconnect; checked that nothing between UI and API buffers
  or compresses it.
- Structured logs (pino) with request id, job id and document id, so one request can be traced end to end.

## 9. Edge cases

The full list goes in `docs/edge-cases.md`, each marked **automated test**, **checked by hand** or **not verified**.
Uploads: empty file; over the limit; wrong type renamed to `.md`; binary with NUL bytes; UTF-8 with BOM; CRLF;
UTF-16; emoji (offsets in UTF-16 units); control, tag and bidi characters; cross-origin upload attempt; DNS-rebinding
Host; duplicate request with the same idempotency key (done, in flight, different body).
PDFs: empty; encrypted; scanned (no text); over 100 pages; parser timeout; parser crash or memory kill (by hand);
two-column layout; quote across a page break; running headers.
Questions: before the document is ready (409); two at once in one conversation (409 via the unique index); only stop
words or punctuation; too long; follow-up depending on earlier turns; rewrite failing; answer not in the document;
answer that is "not measured"; invented quote; quote shorter than 20 characters; quote found only outside the
passages sent; repeated text; quote crossing a chunk boundary; no quote verifies (`unsupported`); injected
instructions in the document, the question or aimed at the note.
Model: down at start; down mid-job; rate-limited; slow (heartbeat); malformed JSON; thinking text before JSON; token
cap hit; context too long; embedding model changed (`embedding_model_changed`, then retry to re-embed); oversized or
malformed parser reply; a paragraph or page with no breaks.
System: worker crash mid-job (by hand); OOM-killed worker (by hand); Redis restart (by hand); insert done but enqueue
lost; job waiting legitimately in the queue; stale retry finishing after a newer attempt; a job that crashes every
time (attempt cap); SSE client late, reconnecting, or connecting after the end; shutdown during an answer; queue too
long; reloading a conversation.
Built: per-document re-preparation through the retry endpoint (re-embeds, and re-extracts PDFs from the kept
original). Documented as next: bulk or automatic re-indexing, OCR, rendered-PDF view, virus scanning, deleting
documents, long histories (summarise older turns), per-user cost limits, a reranker, non-English full-text.

## 10. Verification

- Unit: chunk offsets (`content.slice(start, end) === chunk.text`), quote matcher (exact, whitespace, hyphenation,
  ligatures, absent, too short, outside the sent ranges, repeated text, across a chunk boundary) and its offset map,
  text cleaning, fusion (a question sharing no words with the document returns the vector-only ranking), prompt
  builder (boundary tag, cleaned text, data blocks), the failure table.
- Web unit tests (Vitest): offsets → highlight mapping, styled Markdown lines (no character lost), PDF page markers.
- Integration with real Postgres and Redis and a **fault-injecting fake model that is an OpenAI-compatible HTTP
  server** (timeouts, 429, 500, malformed JSON, cap hits, slow responses), so the real client, abort and timeout code
  is exercised: every automated edge case in §9.
- Fixtures: CRLF, BOM, UTF-16 and NUL upload fixtures are generated in code (or the fixtures folder is marked `-text`
  in `.gitattributes`), since `eol=lf` would silently turn the CRLF fixture into LF. PDF fixtures: empty, encrypted,
  image-only, over the page limit, two-column (generated).
- First migration check: the un-sized `vector` column accepts 768-d, 1536-d and 3,072-d rows and the per-document
  query works.
- Search benchmark (§2) with the real embeddings model.
- Live smoke script, real model, checking labels and verified quotes (not wording):
  - sample document: "Who owned the pilot?", "How fast was keyword search?", "And the hybrid one?", "Did users trust
    the answers?" (answered "not measured", with quote; after a retry it may be `not_in_document` with a note), "What
    did the pilot cost?" (not in document), plus a few injection attempts;
  - the generated paper-length document: a few questions where search must pick passages from a long text, so
    retrieval and answering run end to end with mixed passages. It reports the share of answers that came from the
    thinking-off retry, which shows whether the 1,300-token cap holds at the full passage budget.
- Hosted path: the same smoke script against Gemini's free tier in step 2 (structured output, thinking switch,
  embedding size, 429s during batch embedding). README notes that the free tier may use submitted content to improve
  Google's products.
- Manual checks, written up: kill the worker mid-answer, OOM-kill it, restart Redis, stop LM Studio mid-answer, kill
  the parser mid-PDF.
- **Fresh-clone check**: a new clone under a different Compose project name, `docker compose build --no-cache`, empty
  volumes, then the README flow and the test command. Here a reused project name would keep old volumes and
  hide first-run problems (Postgres initialisation, migrations on an empty database).
- README lists which model setups were actually run, and that the Linux path is untested (no CI).

## 11. Steps (each ends with your review, then a commit; each ships with its tests and its DESIGN.md section)

0. **Local model test** — done 2026-11-24; criteria in `step0/CRITERIA.md`, results in `step0/RESULTS.md`. Chosen:
   Gemma 4 26B-A4B, thinking on. The quote fallback wasn't needed (every quote verified).
1. **Repo setup**: local git repo and the private GitHub repo (first push here), git identity, `.gitattributes` (`* text=auto eol=lf`, fixtures rule), `.gitignore`
   (`.env`), `.dockerignore`, `.env.example`, workspaces, TypeScript config, Prettier and ESLint, Compose (postgres,
   redis, networks, hardening per image, `test` service), Fastify health check, first migration, project `CLAUDE.md`
   (with the §12 house style and phrase list), `TIMELOG.md`, the mistakes log.
2. **Thin path** (the brief asks for this first): Markdown/text upload → prepare → ready → question → answer with
   verified quotes → GET. Real end-to-end run on the sample document with LM Studio, then the **hosted check** on
   Gemini's free tier. Time one full-budget call; check LM Studio's over-long-prompt behaviour and abort. A **minimal
   README** (run both ways, test command, example flow), kept current from here on. Owed by DESIGN.md: a Fastify
   error handler so request errors are logged as messages only (the default logs the whole error on a 5xx), and the
   stored-model-name check before searching. Learned in step 1, to check before the first review: the worker
   container gets `init: true`, a stop grace period and a restart policy; drop Postgres and Redis connections
   mid-job and stop the worker mid-job; decide what an upload returns while Redis is down (the API's Redis client
   fails fast). Commit locally, ask the advisor, then push.
3. **Failure handling** (§8) with the fault-injecting fake model. Split in two halves, each with up to three fresh
   reviews and its own push: 3a the worker (failure table, thinking-off retry, follow-up rewrite, job retries,
   shutdown, heartbeats, sweeper, start-up model check), 3b the API (retry endpoints, idempotency keys,
   back-pressure). Retry works only on a conversation's latest question; the table stays `turns`; the start-up model
   check is a setting, on by default and off in the build machine's `.env`, since LM Studio here loads models on demand (user,
   2026-11-24). Defaults, as settings: 20 waiting questions and 20 waiting documents before `busy`; idempotency keys
   kept 24 h.
4. **Input security and prompt-injection hardening** (§4–§6) with the fixtures. Decided with the user on
   2026-11-24: security headers set directly (no @fastify/helmet); @fastify/rate-limit 11.2.2 with 10 uploads and 30
   questions a minute (retries counted with their kind), which act as totals since every request reaches the API from
   one Docker address; the step 3 defaults stay (20 waiting, 24 h keys); a document that failed for a lasting reason
   (`empty_document`, `too_many_passages`) can't be retried. The allowed browser origins start empty and step 8 adds
   the web app's. NFKC and joining line-end hyphenation in quote matching move to step 6, with the PDF fixtures.
5. **Streaming**: SSE progress via BullMQ queue events, close-on-final, reconnect behaviour.
6. **PDF** (§7): parser container, extraction, page map, fixtures, two-column check.
7. **Search benchmark**: generated document, questions, decision rule, run, results; long-document smoke questions.
8. **Web UI**: React/Vite app served by nginx, built to the §12 look (fonts, palette, styled Markdown lines, contrast),
   with its unit tests.
9. **Docs**: README and DESIGN.md polished to the §12 budgets; linked files `docs/integration.md` (+ `openapi.json`),
   `docs/edge-cases.md`, `docs/benchmark.md`, `docs/model-check.md` (cleaned step 0 summary; script in
   `scripts/model-check`), `docs/ai-use.md` (rule excerpts, list of plugins, hooks, advisor and skills, the planning
   documents that steered the work (this plan and `step0/CRITERIA.md`, cleaned), mistakes log, phrase scan, redacted
   conversation export after the user reads it). The phrase scan runs over all of it.
10. **Recording** (you record with OBS; video on Google Drive): measure RAM with the full stack and OBS running first;
    load both models and pre-upload the document so nothing cold-starts on camera; narrate the decision while an
    answer generates; disclose any cuts; check the screen for personal details (desktop, tabs, usernames). Spoken from
    an outline: flow, one decision, one limitation or test result.
11. **Final check**: test command inside containers; `npm audit`; fresh-clone check; a review agent reads the whole
    diff; fixes; full-history scan for secrets and personal data; final push; add the reviewers to the private repo;
    send the repo and recording links through the submission channel.

There is no fixed deadline. If one appears, drop in this order: benchmark, then PDF, then UI polish. Never dropped:
the README, DESIGN.md, tests, the recording.

## 12. House style: look and writing

The aim is a product that looks like it belongs next to Curie's and documents written by someone who cares, not
generic AI output (user, 2026-11-24). This is a house style, not a disguise: the brief welcomes coding agents and
grades how they're directed, so the AI-use section stays complete and names this style and its checks.

**Look** (from curie.is, measured 2026-11-24; principles and fonts borrowed, brand marks not)
- Dark only. Warm near-black page (about `#2a2826`), slightly darker panels (about `#201e1d`) with thin warm-grey
  borders and small radii, off-white text (about `#f2efed`), muted text at 70% white.
- Charis SIL (serif, regular weight, never bold) for the document text and headings; Inter for the interface. Both
  OFL-1.1, self-hosted from `@fontsource/charis-sil` and `@fontsource-variable/inter`, with their licence notices kept
  in the built app; no third-party font requests.
- One orange accent (about `#f67222`), used sparingly: focus ring, active quote, primary action. Measured contrast:
  text 12.8:1, muted text 8.0:1, orange text 5.1:1; light text on solid orange fails (2.5:1), so a quote highlight is
  a faint orange tint with an orange underline (9.2:1) and an orange button carries dark text (5.1:1).
- App-scale cues come from the product fragments on curie.is (search box, reader, share dialog), not its hero: compact
  panels, small labelled selectors, real content instead of illustrations.
- A reading layout, not a dashboard: the document on one side in serif at a comfortable line length, the conversation
  on the other.
- Not used: the Curie logo or pixel-square motif, gradients, glows, frosted glass, purple or blue "AI" colours, sparkle
  icons, emoji, robot avatars, icon-card grids, numbered-circle steps, typing or shimmer animations, "Ask AI" labels,
  exclamation marks, stock illustrations, placeholder text.
- Copy is short and concrete: states say what is happening ("Reading the document", "Checking quotes against the
  text"); errors say what to do next.
- Accessibility stays: the contrast above, visible focus, keyboard use, reduced motion respected.

**Writing** (README, DESIGN.md, code comments, commit messages, UI text)
- Plain and specific, like explaining to a colleague. DESIGN.md uses first person only for decisions the user made and
  has read ("I chose Postgres full-text because…"); the rest is neutral. No chat-style "I'll do X for you" phrasing.
- Real numbers (step 0, the benchmark) and real limits. Mistakes come only from the running log of caught mistakes.
  Nothing manufactured: no invented dead ends, staged typos or reshaped commit history. Test hardware described
  generically ("a laptop with an integrated GPU and 32 GB RAM").
- Tells to avoid (from the user's own writing rules and common AI patterns): tildes on numbers (write "about 30"); every
  bullet the same shape and length; abstract phrases ("production-grade", "end to end", "pioneered", "gated by",
  "robust", "seamless", "leverage", "comprehensive", "delve", "empower", "unlock"); summaries that repeat the content;
  emoji or title case in headings; bold everywhere; "Key features" lists; "it's not just X, it's Y"; chains of em
  dashes; tables where a sentence would do.
- Length budgets: README about 150 lines at most; DESIGN.md about 2,000 words at most, with detail in the linked
  `docs/` files (step 9).
- Code: comments only for the why; no narrating comments, no doc comment on every function, no banner comments;
  Prettier and ESLint for consistent formatting. Commit messages short, imperative, at natural checkpoints, ending
  with the `Co-Authored-By` line (user, 2026-11-24), matching the AI-use section.

**How it's enforced**
- The repo's `CLAUDE.md` carries these rules and the phrase list (committed, since the brief asks for the rules
  actually used). This session's working folder is outside the repo, so it may not load that file on its own: each
  step starts by reading it, and the AI-use section says so. The phrase scan runs on docs and UI text before each
  commit, and the AI-use section names it.
- The user reads every user-facing text during each step's review.
- The recording is spoken from an outline, not read from a script.
- Nothing here is written as code before the clock starts: colours and fonts become CSS in step 8.
