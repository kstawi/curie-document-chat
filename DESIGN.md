# Design

A summary by topic. The reasons behind each step, written as it was built, are in
[docs/build-notes.md](docs/build-notes.md); the endpoints and their shapes are in
[docs/integration.md](docs/integration.md) and [docs/openapi.json](docs/openapi.json).

## Assumptions

- One user and no accounts, as the brief allows; access is a design note below.
- A conversation is about one document. Documents and questions are in English, which the keyword search assumes.
- Answers come from a chat model on the same machine (LM Studio) or any OpenAI-compatible service. On the local
  model an answer took from about 15 seconds to two and a half minutes, so a reader waits for a checked answer
  rather than watching text appear.
- Files are Markdown or plain text up to 1 MB, or PDF up to 5 MB and 100 pages with a text layer.
- Everything runs on one machine under Docker Compose.

## Architecture

Six services. **web** is nginx serving the built React app and passing `/api` on, so the browser sees one origin.
**api** is Fastify with a zod schema on every route: it writes a row and adds a BullMQ job. **worker** prepares
documents and answers questions, calling the model server, and reports each stage through BullMQ's queue events,
which the API turns into server-sent events. **pdf-parser** reads PDFs, one child process per file, on a network
shared with the worker alone. **postgres** (with pgvector) holds everything; **redis** holds the queues.

Networks keep nginx away from Postgres and Redis, and the parser away from all but the worker. The app's own
containers run as non-root users on read-only filesystems, and every service has memory and process limits.

## Data model

- `documents`: title, format, the stored text, status (`queued`, `processing`, `ready`, `failed`), the error, the
  embedding model used, a PDF's page map, and `attempt`, `requeues` and `heartbeat_at` for failure handling.
- `document_files`: an uploaded PDF, kept so it can be read again, never served.
- `chunks`: a passage's exact start and end in the stored text, its heading path and text, a generated `tsvector`
  with a GIN index, and an embedding in a `vector` column with no fixed size, so documents embedded by different
  models can sit side by side.
- `conversations` and `turns`: a conversation's name and where it came from (its first question, the model or the
  user); one `turns` row per question and its answer, with its status, stage, outcome, answer or note, checked
  quotes, and the model and path that produced it. A partial unique index allows one pending question per
  conversation.
- `idempotency_keys`: the stored response for each key and route, for 24 hours.

## Background preparation

An upload's type comes from its bytes, never the file name. Text must be UTF-8 and is stored with line endings made
LF and a byte-order mark dropped, nothing else, so every offset points at the stored text. A job splits it along
headings and paragraphs into passages of about 300 tokens, packing small sections together, embeds them with their
heading paths, and writes every passage and the `ready` status in one transaction. A PDF first goes to the parser,
which puts two-column pages in reading order, keeps one copy of a running head, drops page numbers, and records
where each page starts. Scans are refused.

## Retrieval and answers

One SQL statement ranks a document's passages twice, by full-text match and by vector distance, and merges the two
top-20 lists by reciprocal rank fusion. Passages fill a 4,000-token budget best-first and go to the model in
document order; a document that fits the budget goes in whole. A follow-up is first rewritten into a standalone
question, used for the search only.

The model gets the passages, the last three turns that got an answer or a not-in-document note, and the question,
each inside a tag the document can't guess, and must reply with strict JSON. The server then looks for each quote
in the passages it sent (at least 20 characters, through a normalised copy that ignores quote and dash styles,
spacing, Markdown emphasis, hidden characters, compatibility forms and line-end hyphens) and decides the outcome
itself: `answered` needs at least one quote found; a claim with none is `unsupported` and its text is never shown;
`not_in_document` keeps the model's short note, marked as not backed by a quote.

## A full-length paper

A 100-page paper makes a few hundred passages; a document that would make more than 5,000 is refused before
anything is embedded, and searching 5,000 took about 50 to 65 ms. A question never sends the whole paper: the best
passages up to 4,000 tokens, the rules, the last three turns and the question leave room for the 1,700-token reply
cap inside the 16,384-token context the local model is loaded with. A prompt that still doesn't fit is tried once
with half the passages, then fails as `context_too_long`. Questions answered in a few places work at any length;
questions about the whole paper ("summarise it", "list every result") get only the passages that rank highest, so
their answers can be incomplete.

## Answer delivery

A question's POST returns at once as `pending`. `GET /messages/:id/events` streams the stage (waiting, naming the conversation, rewriting a
follow-up, searching, writing, checking quotes, or waiting to try again after a model outage) and then the stored
answer once, with the id `final`; every 15 seconds it re-reads the row, which catches what no job reports.
`GET /messages/:id` returns the same row for clients that poll, and the web app falls back to polling when the
stream gives up.

## Failure handling

Every job update is guarded by its status and attempt, so a late or repeated job can't overwrite newer state. Model
failures lead to:

| Failure                              | Answer, thinking on                              | Retry, thinking off | Follow-up rewrite                  | Embeddings                                                  |
| ------------------------------------ | ------------------------------------------------ | ------------------- | ---------------------------------- | ----------------------------------------------------------- |
| Token cap, no JSON, wrong JSON shape | retry with thinking off                          | `model_bad_output`  | search with the last two questions | `model_bad_output`                                          |
| Call timeout                         | retry with thinking off                          | run the job again   | search with the last two questions | run the job again                                           |
| 429, 5xx, server unreachable         | run the job again                                | run the job again   | run the job again                  | run the job again                                           |
| Prompt longer than the context       | half the passages, once; then `context_too_long` | `context_too_long`  | search with the last two questions | preparing: `internal_error`; a question: `context_too_long` |
| Other 4xx                            | `model_rejected`                                 | `model_rejected`    | search with the last two questions | `model_rejected`                                            |

A job runs at most three times, and on the last a failure that would run it again is recorded as
`model_unavailable`. Each run has a time limit. A stopped worker puts its job back without spending an attempt. A
sweeper finds rows whose job was lost and queues them again, at most twice. A user can retry a failed document or
the latest question; every POST takes an `Idempotency-Key`; while 20 uploads or 20 questions wait, new ones get 503
`busy`. If Redis is down, the new row is removed and the client gets 503, rather than a row that would never move.
The call that names a conversation from its first question is the one model call whose failure changes nothing: the
question stays the name and the answer goes on.

Prompt injection can't be prevented, only contained: the model has no tools and the prompt no secrets, retrieval is
scoped to one document in code, quotes are checked by the server, and the web app shows all text as text. The worst
case is a wrong answer about the same document, for its own reader.

## Alternatives I weighed

**Streaming the answer's words.** It feels faster, but text isn't an answer until its quotes are checked, and an
answer whose quotes fail is hidden. I chose to stream progress instead and send the answer once it is checked.

**Meaning-only search.** On a generated 5,100-word report with 24 questions, meaning alone put the right passage in
the top three slightly more often than hybrid (23 and 21 of 24 with the local embeddings, 24 and 23 with Gemini's),
and the rule written before the run kept hybrid only because labels completed later moved one question. Both sent
the right passage to the model every time, so I kept hybrid, whose keyword half covers exact codes and rare names
one generated document can't test ([docs/benchmark.md](docs/benchmark.md)).

## How the work was split

Before the clock: a test of local models for verbatim quotes ([docs/model-check.md](docs/model-check.md)). Then, in
order: the skeleton, so every later step landed with tests run the same way; the thin path from upload to checked
answer, which the brief asks for first, run against both real models; failure handling in the worker, then at the
API, and input security, so the required system was sound before it grew; then the extras: live progress, PDF, the
search benchmark, and the web app last, once the API it calls was in place (it added one field for it); these docs.
Each step ended with fresh reviews by an agent that hadn't seen the work. Real-model runs are in
[docs/model-runs.md](docs/model-runs.md), times in [TIMELOG.md](TIMELOG.md), and how the coding agent was directed
and checked in [docs/ai-use.md](docs/ai-use.md).

## Tests and checks

Most automated tests run the real code against real Postgres and Redis in containers, with real BullMQ workers and
a fake OpenAI-compatible model server that can hold a reply open, send broken JSON, answer 429 or 5xx, or refuse a
prompt as too long. The risky parts live in SQL and the queue (the search statement, guarded updates, idempotency
claims, retries, the sweeper, shutdown), where mocks would only test the mocks. Text code (chunking, quote
matching, hidden characters, PDF reading order on generated files) has unit tests and a fixed-seed random test, and
a server test checks that the web app's heading rule matches the server's. The web app's own tests cover splitting
text into lines and highlights, which windows are open, and, in a browser-like DOM, that switching documents
leaves no pane behind; the layout was checked by hand. Real models, slow and not repeatable, were checked in
written-up runs instead. Every failure case and how it was checked is in
[docs/edge-cases.md](docs/edge-cases.md).

## Complete and remaining

Complete: the required API, plus PDF, the web app, live progress, the hardening above and the benchmark, with 265
server and 21 web tests run in containers by `docker compose run --rm test`.

Not verified or not done:

- It has only run on Windows with Docker Desktop. There is no CI.
- The web app and conversation names have run on the local model once, in a dry run before the recording
  ([docs/model-runs.md](docs/model-runs.md)); every other check of them used stand-in models.
- Answers on the hosted path last ran on step 2's code; step 7's benchmark ran only Gemini's embeddings and
  follow-up rewrites, and how the app handles Gemini's 429 and 503 replies is untested.
- Virus scanning isn't built: it would be a ClamAV daemon the worker calls before reading a file, failing the
  document on a hit. Uploads are never served back, and the PDF parser has no route out.
- The app connects as a database superuser, which pgvector's `create extension` needs.
- Open event streams have no cap.
- Plain-text files get the server's Markdown heading rules for section labels, but the app draws them as plain text.
- In the web app, Enter during Safari's input-method conversion sends the question, and narrow screens get no
  layout of their own.

Next: deleting documents and conversations; re-preparing every document after a model change
rather than one at a time; skipping the embedding and the rewrite when a document goes in whole; summarising older
turns in long conversations; OCR for scans; a reranker; full-text search in other languages.

## Access to documents

I chose team spaces. A document belongs to a space, not a person: members of the space can read it and ask about
it, and the uploader or a space admin can delete it. Whether members see each other's conversations
is not decided.

In this code that would mean a `spaces` table, `space_members` with a role, `space_id` on documents and `user_id` on
conversations. Every id in a route leads to one document; that lookup would join the caller's membership and answer
404, not 403, so other spaces' ids can't be probed, and the list would filter by space. The event stream would
recheck on each re-read, closing a removed member's streams within 15 seconds. Idempotency keys would be per user:
today another person sending the same request with the same key gets the first response.

## A million documents

Answering across a million documents changes the search, not the answer check. Nothing below was measured.

- One embedding model per index, with a fixed vector size and an approximate index (pgvector's HNSW, or a separate
  vector store once one Postgres is too small). Changing models means re-embedding in the background into a new
  index and switching over.
- Retrieval in two stages, candidate documents and then passages within them, so the prompt stays at its budget,
  with the space filter inside the search rather than after it (easiest with passages partitioned by space).
- Quotes carry a document id; checking them against the passages sent works unchanged.
- Preparation is already a queue and scales out with workers; embedding throughput becomes the limit.
- The benchmark here covers one document. Cross-document recall needs its own labelled set before choosing.
