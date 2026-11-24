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
Every connection gets a listener, so the query in flight fails and the next one gets a fresh connection. If Postgres
is unreachable at start-up, the API logs why and exits, and Docker restarts it.

The app connects as the database owner, a superuser, because `create extension vector` needs one (pgvector isn't
marked as a trusted extension). In production an init script would create the extension and the app would use a
role without superuser rights.

`chunks.embedding` is a `vector` with no fixed size, because embedding models differ (768 dimensions for the local
model, 3,072 for Gemini's by default). A question is only ever compared with the chunks of one document, embedded
by the model that embedded that document (from step 2 the app checks the stored model name before searching).
Search is exact and scoped to one document: a 100-page PDF makes a few hundred chunks, few enough to compare all of them (to
be timed with the benchmark), and pgvector can't index a column without a fixed size except with one partial index
per model size. Each chunk also gets a generated `tsvector` from its heading path and text, with a GIN index, for
the keyword half of the search.

**Health.** `/health` is liveness only and never touches a dependency. `/ready` checks Postgres and Redis, each
raced against a two-second timeout so a hung dependency can't hang the probe, and answers 503 naming the one that
failed. Redis is used without an offline queue, so commands fail fast during an outage instead of piling up in
memory. Start-up and connection errors are logged as messages only: pg-pool attaches the whole client to
idle-connection errors, and some `pg` errors carry row data. Request errors will follow the same rule once routes
touch the database (step 2).
