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
Search is exact and scoped to one document: a 100-page PDF makes a few hundred chunks, few enough to compare all of them (to
be timed with the benchmark), and pgvector can't index a column without a fixed size except with one partial index
per model size. Each chunk also gets a generated `tsvector` from its heading path and text, with a GIN index, for
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

**Upload.** The type comes from the bytes, never the file name: PDFs, UTF-16, invalid UTF-8 and anything with NUL
bytes are refused; the size limit (1 MB) applies while the upload streams in. Line endings become LF and nothing
else changes, so every offset matches the stored text.

**Preparation.** A background job splits the text along headings and paragraphs into chunks of about 300 tokens,
each an exact slice of the document. A section under 400 characters is packed together with the next one, up to the
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

| Failure                              | Answer, thinking on                              | Retry, thinking off | Follow-up rewrite                  | Embeddings         |
| ------------------------------------ | ------------------------------------------------ | ------------------- | ---------------------------------- | ------------------ |
| Token cap, no JSON, wrong JSON shape | retry with thinking off                          | `model_bad_output`  | search with the last two questions | `model_bad_output` |
| Call timeout                         | retry with thinking off                          | run the job again   | search with the last two questions | run the job again  |
| 429, 5xx, server unreachable         | run the job again                                | run the job again   | run the job again                  | run the job again  |
| Prompt longer than the context       | half the passages, once; then `context_too_long` | `context_too_long`  | search with the last two questions | `internal_error`   |
| Other 4xx                            | `model_rejected`                                 | `model_rejected`    | search with the last two questions | `model_rejected`   |

On the last attempt, a failure that would run the job again is recorded as `model_unavailable` instead. Each run of
an answer job is capped at 10 minutes and each run of a preparation at 15, every call in it included; a run
that reaches its limit ends the job with `model_unavailable`, without another run.

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
minute-long answers, a long wait is normal. A row with no live job is queued again under a new attempt, at most
twice, then failed with `max_attempts`. If the new job can't be added, the requeue isn't counted and the row keeps its new attempt, so a job
that arrives late still runs; and a sweep stops at the first Redis error, so an outage never uses up requeues. Requeues are counted apart from attempts, so a user's retry
(step 3b) always gets a fresh start.

**Start-up check.** The worker sends one tiny request to each model when it starts and leaves the result for
`/ready`, which reports it but stays ready: questions wait in the queue while the model server is away. It is a
setting, on by default. I turned it off on the machine this was built on, where LM Studio loads a model whenever one
is asked for, so every worker restart would have loaded the chat model.
