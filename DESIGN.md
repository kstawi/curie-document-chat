# Design notes

These notes grow with each step of the build, so the order of the sections is the order of the work. Failure cases
and how each one was checked are listed in [docs/edge-cases.md](docs/edge-cases.md).

## Order of the work

I started with the skeleton (repository, Compose, health checks, the first migration and the test command) before
any feature, so every later step lands with tests that a reviewer runs the same way I do. So far that has only been
run on Windows with Docker Desktop; Linux and macOS are untested, and there is no CI.

## Step 1: skeleton

**Layout.** An npm workspace with one `server` package. The API is its first entry point; the worker and the PDF
parser will join it, sharing the database and model code. The web app gets its own package later.

**Running it.** Docker Compose runs Postgres (with pgvector), Redis and the API, with ports published on 127.0.0.1
only. `docker compose run --rm test` runs lint, type checks and the tests in a container against a separate
`curie_test` database and Redis database 1, so a reviewer needs no Node install and the tests never touch the data
of a running stack. The test service rebuilds on every run, so the plain command can't test stale code.

**Containers.** The API container runs as a non-root user with a read-only filesystem, no Linux capabilities and no
way to gain privileges, behind a small init process that passes stop signals on. Postgres and Redis drop all
capabilities and add back only the few their entrypoints use to fix data ownership and switch user. All three
restart unless stopped and have memory and process limits. Redis keeps an append-only file and runs with
`noeviction`, which BullMQ requires, so a full Redis refuses writes instead of dropping queued jobs.

**Database.** I chose Kysely over an ORM: queries stay close to SQL, which matters for pgvector and full-text search,
and they're still typed. Migrations are SQL inside Kysely migration files, listed in code; Kysely's Postgres
migrator holds an advisory lock while it runs. The pool allows 10 connections, waits 5 s for one and stops any
statement after 15 s, so a stuck query fails instead of holding a connection. Migrations and the wait for that lock
share the limit, which is fine while migrations are small: a second service that waits longer gives up and is
restarted. A migration that rebuilds a large index would need its own limit. The API's stop grace period is 20 s,
longer than any statement, so a shutdown can always let the statement in flight finish.

Postgres can drop a connection at any moment: a restart, a failover, a backend killed for memory. The `pg` library
reports that as an `error` event, and an unhandled one ends the process, whether the connection was idle or in use.
Every connection gets a listener, so the query in flight fails and the pool discards the broken connections; a
query sent in the moment before the pool has noticed can fail too, and later ones get fresh connections. If Postgres
is unreachable at start-up, the API logs why and exits, and Docker restarts it.

The app connects as the database owner, a superuser, because `create extension vector` needs one (pgvector isn't
marked as a trusted extension). In production an init script would create the extension and the app would use a
role without superuser rights.

`chunks.embedding` is a `vector` with no fixed size, because embedding models differ (768 dimensions for the local
model, 3,072 for Gemini's by default). A question is only ever compared with the chunks of one document, embedded
by the model that embedded that document (from step 2 the app checks the stored model name, with the vector size
when one is configured, before searching).
Search is exact and scoped to one document: a 100-page PDF makes a few hundred chunks, and at the cap of 5,000 the
whole search takes about 50 ms with 768-dimension vectors and 65 ms with 3,072 (`docs/runs/2026-11-25-search-timing.txt`), so
an index isn't needed; pgvector can't index a column without a fixed size except with one partial index per model
size. Each chunk also gets a generated `tsvector` from its heading path and text, with a GIN index, for
the keyword half of the search.

**Health.** `/health` is liveness only and never touches a dependency. `/ready` checks Postgres and Redis, each
raced against a two-second timeout so a hung dependency can't hang the probe, and answers 503 naming the one that
failed. Redis is used without an offline queue, so commands fail fast during an outage instead of piling up in
memory. Errors are logged as messages only: pg-pool attaches the whole client to idle-connection errors, and some
`pg` errors carry row data.

## Step 2: the thin path

The brief asks for a small working path first, so step 2 goes from upload to a checked answer with nothing extra:
no retries, no streaming. It ran against both real models before being called done (results in
[docs/model-runs.md](docs/model-runs.md)).

**One row per question and answer.** The plan had separate rows for the question and the answer. The build uses
one `turns` row per exchange instead: one status, no question without its answer, and a later retry stays on the same row. A
partial unique index allows one pending turn per conversation, so a second question gets a 409 without a race.

**Upload.** The type comes from the bytes, never the file name: UTF-16, invalid UTF-8 and anything with NUL bytes are
refused. Uploads stream in up to 5 MB, the PDF limit, and a Markdown or text file over 1 MB is then refused. Line
endings become LF and nothing else changes, so every offset matches the stored text.

**Preparation.** A background job splits the text along headings and paragraphs into chunks of about 300 tokens,
each with exact offsets into the document. A section under 400 characters is packed together with the next one, up to the
usual chunk size, so a glossary with thousands of one-line entries still makes passages of a useful size (and a few
hundred of them, not tens of thousands). A heading line over 200 characters counts as a paragraph, which keeps the
heading pattern fast on crafted input. Each chunk is embedded with its heading path, and all chunks and the `ready` status are written
in one transaction, 500 rows per statement. A document that would still make more than 5,000 chunks is refused
before anything is embedded. Every job update is guarded by status and attempt, so a stale or repeated job can't
overwrite newer state.

**Search.** One SQL statement ranks the document's chunks twice, by full-text match (the question's words ORed, the
query built by Postgres) and by vector distance, and merges the two lists by reciprocal rank fusion. Passages fill a
4,000-token budget best-first and go to the model in document order. A short document goes in whole.

**Answering.** The prompt is the one tested before the build: passages, the last three turns that got an answer
or a not-in-document note, and the question, each in a block marked by a random tag the document can't guess. The
model must return strict JSON, and its text is cleaned of what Postgres can't store (a NUL character, half an
emoji) before anything is written. The server then looks for each quote in the passages that were sent (at least 20
characters, matched through a normalised copy that only ignores quote and dash styles, runs of spaces and line
breaks, Markdown emphasis and code marks, and invisible characters such as zero-width spaces), labels it with the
section it was found in, and decides the outcome itself: `answered` needs a quote found, a claim with none is
`unsupported` and hidden, and `not_in_document` keeps the model's short note.

**When Redis is down.** Adding a job gives up after two seconds. The new row is then removed and the client gets a
503: a document left `queued` would never be prepared, and a pending turn would lock its conversation. If the job is
added late anyway, its handler finds no row and does nothing.

**Errors.** Clients get a fixed code and a safe message; the full provider text goes to a debug column that no
route returns.

**Delivery for now.** Clients poll `GET /messages/:id`; live progress arrives in step 5.

What step 2 leaves to later steps is listed in [docs/edge-cases.md](docs/edge-cases.md#step-2-upload-preparation-and-answers).

## Step 3a: failures in the worker

**Where retries happen.** The `openai` package's own retries are off, so a retry happens in one of two places:
inside a job (a second model call) or as a new run of the job (BullMQ runs it again after 5 and then 10 seconds,
three attempts in all). What each failure leads to:

| Failure                              | Answer, thinking on                              | Retry, thinking off | Follow-up rewrite                  | Embeddings                                                  |
| ------------------------------------ | ------------------------------------------------ | ------------------- | ---------------------------------- | ----------------------------------------------------------- |
| Token cap, no JSON, wrong JSON shape | retry with thinking off                          | `model_bad_output`  | search with the last two questions | `model_bad_output`                                          |
| Call timeout                         | retry with thinking off                          | run the job again   | search with the last two questions | run the job again                                           |
| 429, 5xx, server unreachable         | run the job again                                | run the job again   | run the job again                  | run the job again                                           |
| Prompt longer than the context       | half the passages, once; then `context_too_long` | `context_too_long`  | search with the last two questions | preparing: `internal_error`; a question: `context_too_long` |
| Other 4xx                            | `model_rejected`                                 | `model_rejected`    | search with the last two questions | `model_rejected`                                            |

On the last attempt, a failure that would run the job again is recorded as `model_unavailable` instead. Each run of
an answer job is capped at 10 minutes and each run of a preparation at 15, every call in it included; a run
that reaches its limit ends the job with `model_unavailable`, without another run. A call's own timeout covers the
wait for the reply to start (the `openai` package stops its timer once headers arrive), so a server that starts a
reply and then stalls is stopped only by that limit.

**Thinking off.** I chose one retry with thinking off after a runaway. Before the build it never ran away, but it
called all four "not measured" questions not found, so each answer records which path produced it. The switch differs
by model ("none" for Gemma in LM Studio, "low" for gemini-3.5-flash), so it is a setting, sent with temperature 0.

**Follow-ups.** A question with earlier answered turns is first rewritten by the model, thinking off, into a
standalone query of at most 300 characters. It is only ever used to search; the answer call still gets the question
as asked, with the earlier turns. If the rewrite fails for any reason other than an outage, search uses the previous
question and the new one together.

**Shutdown.** On SIGTERM the worker stops taking jobs, cancels the model call in flight and puts the job back in the
queue without spending an attempt (BullMQ's delay pattern), so the next start runs it from the beginning.

**The sweeper.** Every minute the worker looks for unfinished rows untouched for two minutes (a running job touches
its row every 15 seconds) and asks Redis about their job. A job still waiting is left alone: with one model and
minute-long answers, a long wait is normal. A row with no live job is queued again under a new attempt, at most twice,
then failed with `max_attempts`. If the new job can't be added, the requeue isn't counted and the row keeps its new
attempt, so a job that arrives late still runs; and a sweep stops at the first Redis error, so an outage never uses up
requeues. Requeues are counted apart from attempts, so a user's retry (step 3b) always gets a fresh start.

**Start-up check.** The worker sends one tiny request to each model when it starts and leaves the result for
`/ready`, which reports it but stays ready: questions wait in the queue while the model server is away. It is a
setting, on by default. I turned it off on the machine this was built on, where LM Studio loads a model whenever one
is asked for, so every worker restart would have loaded the chat model.

## Step 3b: failures at the API

**Retrying.** `POST /documents/:id/retry` prepares again a document that failed, or one indexed with an embedding
model other than the configured one. `POST /messages/:id/retry` answers again a failed question. I chose to allow it
only for a conversation's latest question, so an answer never lands behind a later one; that check is part of the
update itself, so a question asked at the same moment counts. A retry starts a new attempt with a fresh count of
sweeper requeues. If its job can't be added, the row goes back as it was but keeps the new attempt, so a job that
lands late finds nothing to do.

**Idempotency keys.** Every POST accepts an `Idempotency-Key` header. The first request with a key claims it in
Postgres, and its response is stored in the same transaction that creates or changes the row. The key counts as done
once the job is added; if that fails, the row is undone and the key given back in one transaction, and a repeat in
between gets 409. A repeat with the same key and request gets the stored response, byte for byte. The same key with a
different request gets 422, and a repeat while the first is still running gets 409. A failure gives the key back,
unless its response was already stored with the row. A key held for a minute without finishing belongs to a request
presumed dead: if it got as far as storing a response, that response stands (its row exists, and the sweeper sees it
through); otherwise the key can be taken over; each claim carries its own id, so a request that was taken over can't
store its response over the new one (its transaction rolls back). The key is checked before anything else, so a repeat
of a question that succeeded gets its first answer even if the document has changed since. Keys expire after 24 hours,
and the sweeper deletes them before it touches Redis.

**Too much waiting.** While 20 uploads or 20 questions already wait (both settings, passed to the API container), new
ones get 503 `busy` with `Retry-After: 30`. The count is approximate: two requests at the same moment can both take
the last place. If the queue can't be counted, the request gets 503 `queue_unavailable` before anything is saved.

## Step 4: input security and prompt injection

**Who may call the API.** There are no accounts, so two checks keep other websites off an API on someone's machine.
The Host check (`localhost` and `127.0.0.1` by default) stops DNS rebinding, where a page on another name resolves to
127.0.0.1. The Origin check refuses a POST from any web page not on `ALLOWED_ORIGINS`, which starts empty; step 8 adds
the web app. A request without an Origin is not a page in a browser, so curl and scripts still work.

**Limits.** JSON bodies stop at 64 KB, uploads while they stream in (since step 6, at 5 MB, with text then held to
1 MB), and the security headers are set
directly: a JSON API needs six of them, so I chose that over a package. Uploads and questions are rate-limited (10
and 30 a minute, retries counted with their kind) by client address. Under Compose every request reaches the API
from one Docker address, so the limits are totals, which suits one person running it.

**Hidden characters.** The stored text stays as uploaded, so offsets hold. What the chat model reads, what is embedded
and what the search index holds go through one function that removes controls, direction controls, the zero-width
space and Unicode tag characters (which can spell a whole hidden sentence), and quote matching drops the same set (and
the joiners, which a model may leave out of a quote), so a quote of the visible text still verifies; a property test
checks that over random text. I chose to keep the zero-width joiner and non-joiner, which Persian words and joined
emoji need, and to let the England, Scotland and Wales flags lose their tag characters, since a hidden sentence could
be dressed up as a flag. Questions and titles lose the same characters and are composed (NFC).

**Prompt injection.** It can't be prevented, only contained. The model has no tools and the prompt no secrets;
retrieval is scoped to one document in code; every block of data sits inside a tag the document can't guess; the
reply must match a strict schema; quotes are checked against the document and the outcome decided by the server;
the web app will show text as text. The worst case is a wrong answer about the same document, for its own reader.
The tests plant instructions in each slot the model reads and check the structure around them; on Gemma, a planted
system line, a fake closing tag and a sentence in tag characters were all ignored (`docs/model-runs.md`).

**A document that failed for good.** No text, or too many passages: its retry is refused, since the same file would
fail the same way. I chose that so the web app doesn't offer a retry that can't help.

## Step 5: live progress

**Progress, not tokens.** An answer's progress streams as server-sent events (`GET /messages/:id/events`): waiting,
rewriting a follow-up, searching, writing, checking quotes, then the verified answer once, and the stream closes.
Tokens aren't streamed, since text isn't an answer until its quotes are checked. The events and the reconnect rules
are in `docs/integration.md`.

**Where events come from.** The worker sends only the stage name through BullMQ's queue events. One listener per API
process hands the two events that follow a change to the row (a new stage, the end of a run) to the streams open for
that message, and each stream re-reads its row, so an event carries exactly what `GET /messages/:id` returns and no
draft passes through Redis. Every 15 s a stream sends a heartbeat comment and re-reads the row too, which catches
what no job reports: the sweeper failing or requeueing a lost answer, or events missed while Redis was away.

**Ending.** The final event has the id `final`. `EventSource` reconnects after every close, so a request carrying
`Last-Event-ID: final` gets 204, which stops it; a client arriving after the end gets the stored answer once.
Shutting down ends open streams first, since they would keep the server from closing; a stream still on its first
read when that starts gets a 503. Open streams have no cap of their own yet; each costs one row read per change
and per heartbeat.

## Step 6: PDF

**Isolation.** PDFs are read by their own service on a network shared with the worker alone: no internet, no
database, Redis, model or setting beyond its own (checked from inside the container). Each file gets a child process
with a 256 MB heap, killed at 30 s, so a hostile or huge file takes down only that process. The parser is pdf.js 6.5,
whose build no longer turns anything in a file into code (checked: no `eval` or `new Function`), the path behind
CVE-2024-4367. The worker treats its reply as untrusted: capped at 8 MB, shape-checked, NUL dropped.

**Reading order.** pdf.js returns text in drawing order, which mixes the two columns of a paper. A page whose narrower
lines mostly leave an empty band in the middle, with running text on each side, is read as two columns, left before
right; lines across the page (a title, an abstract) stay in place, and a table of labels and values stays row by row.
A line repeated in the top or bottom rows of most pages, or of most odd or even pages (alternating heads), counts as
a running head even with its page reference changing ("page 3 of 5"); only its first copy is kept, so a table that
repeats its heading keeps it once. Page numbers there are dropped, told from other numbers by keeping in step with
the page. I chose these rules, the first copy after a review. Paragraph breaks come from vertical gaps, a raised
footnote mark stays on its line, and an accent drawn as its own glyph is joined to its letter.

**Pages.** The stored text is the pages joined by blank lines, with a page map. Passages never cross a page and are
labelled with it; a quote carries its start and end page, and one across a page break is labelled "pages 1–2". Quote
matching now decomposes each character (NFKD) and joins words hyphenated at line ends, on both sides of the match.

**Originals and failures.** The uploaded file is kept in its own table, never served, and read once: re-preparing a
ready PDF for another embedding model keeps its text, so earlier quotes' offsets hold. Encrypted files, files with no
text layer (scans; OCR is the next step) and files over 100 pages fail for good. A read that failed or timed out can
be tried again, and a parser that is down is retried with the job.

## Step 7: search benchmark

`docs/benchmark.md` has the method, the rule written before the first run, and both rounds of results. On a
5,100-word generated report with 24 questions, meaning alone found the right passage in the top three a little more
often than hybrid (23 and 21 of 24 with nomic, 24 and 23 with Gemini). By the rule hybrid stays, but only because
labels completed after the first run (which would have switched) moved one question; both put the right passage
among those sent to the model for all 24. Keyword search on its own was weakest, mostly on paraphrases, and the
rewrite of follow-ups mattered more than the method. Every question on a document that fits whole still pays for
its embedding, and a follow-up for its rewrite, though neither is used; skipping them is a next step. Running the hosted path found a bug: Gemini leaves out the
index of the first embedding, and the app had refused every such reply. Search now sends a document that fits the
budget whole, which the claim in step 2 assumed but the top-20 candidate lists did not guarantee.

## Step 8: web app

**Shape.** One page in three panes: documents on the left, the chosen document's text in the middle, its
conversation on the right, with the latest conversation open and older ones in a menu (both my choices). React and
Vite build it into static files, served by an unprivileged nginx that also passes `/api` on to the API, so the
browser sees one origin. Browsers still send that origin with uploads and questions, and the API refuses origins it
doesn't know, so Compose now allows the app's two local addresses.

**The text shown is the text quoted.** The middle pane shows the stored text, not the original file, character for
character. Markdown lines are styled by the same heading and fence rules the server uses for sections, never rendered
as HTML, and a PDF shows page markers from its page map. Quote offsets point into that text, so clicking a quote
highlights exactly those characters and scrolls to them.

**Progress and failures.** An answer is followed with `EventSource` through nginx, which passes the stream on
unbuffered; if the stream gives up, the app polls every 2 s instead. A failed answer offers "Try again" on the
latest question only, as the API allows. The API now tells the app whether a document can be retried, so a lasting
failure offers no button, and a document indexed for an older embedding model offers to be prepared again and takes
no questions until then.

**Look and safety.** Dark, Charis SIL for the document and Inter for the interface, both served from the app with
their licences; the orange accent marks the main button and quote highlights. Nothing on the page is inline, so the
Content Security Policy allows only the app's own files, and text from a document or a model is always shown as
text. nginx shares a network with the API alone, away from Postgres and Redis. Tests cover splitting the text into lines and cutting highlights (`web/test/text.test.ts`); the panes were
checked by hand in a browser against a stand-in model with canned replies, since no model was loaded.
