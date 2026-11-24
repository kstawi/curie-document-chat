# Curie document chat

A small service for asking questions about one document and getting answers backed by quotes from it. Built as a
take-home exercise for Curie; it is not affiliated with or endorsed by Curie.

Upload a Markdown or plain-text file; it is split into passages and indexed in the background. Then ask questions
in a conversation about it. Each answer comes with quotes that the server has found in the document, with their
position, line and section. If the document doesn't answer the question, the reply says so.

Work in progress. Design notes: [DESIGN.md](DESIGN.md). Failure cases and how each was checked:
[docs/edge-cases.md](docs/edge-cases.md).

## Run it

Needs Docker with Compose, and a model: LM Studio on this machine, or a key for any OpenAI-compatible service.

```sh
cp .env.example .env   # then pick the model block you want
docker compose up --build -d --wait api worker
```

**LM Studio (the default).** About 16 GB of free memory for the chat model. Load both models before starting, with no
idle timer, so a request never waits for a model to load:

```sh
lms server start
lms load google/gemma-4-26b-a4b-qat -c 16384 -y
lms load text-embedding-nomic-embed-text-v1.5 -y
```

The containers reach it at `host.docker.internal:1234`. On Linux, LM Studio must listen on more than 127.0.0.1 for
that to work (not tested; this was built on Windows).

**A hosted model.** Uncomment the Gemini block in `.env` and add your key, or point `MODEL_BASE_URL`, `CHAT_MODEL` and
`EMBEDDING_MODEL` at another OpenAI-compatible service. Gemini's free tier often answers 503 or 429; a paid key runs
smoothly.

## Try it

From the repository folder, in a POSIX shell (Git Bash, WSL, macOS or Linux; PowerShell quotes the JSON
differently):

```sh
# Upload the sample note. Send the title before the file.
curl -F "title=Harbor Archive" -F "file=@samples/harbor-archive-pilot.md" http://127.0.0.1:3000/documents
# → {"id":"<doc>","status":"queued",...}; poll until "status":"ready"
curl http://127.0.0.1:3000/documents/<doc>

# Start a conversation and ask.
curl -X POST http://127.0.0.1:3000/documents/<doc>/conversations
curl -H "content-type: application/json" -d '{"question":"Who owned the pilot?"}' \
  http://127.0.0.1:3000/conversations/<conversation>/messages
# → {"id":"<message>","status":"pending",...}; poll until it is "completed"
curl http://127.0.0.1:3000/messages/<message>
```

A completed answer looks like this (with the local model, answers took about 15 to 65 seconds in testing):

```json
{
  "status": "completed",
  "outcome": "answered",
  "answer": "Mira Chen owned the limited pilot.",
  "quotes": [
    {
      "text": "Mira Chen owned the limited pilot.",
      "start": 1311,
      "end": 1345,
      "line": 29,
      "section": "Harbor Archive retrieval pilot > Decision"
    }
  ]
}
```

`outcome` is `answered` (with at least one quote found in the document), `not_in_document` (with the model's short
`note`, not backed by a quote) or `unsupported` (the model claimed an answer, but none of its quotes could be found,
so it isn't shown). `scripts/smoke.mjs` runs the sample questions against a running stack.

A failed document or answer can be tried again with `POST /documents/<doc>/retry` or `POST /messages/<message>/retry`
(only a conversation's latest question). Every POST accepts an `Idempotency-Key` header: a request sent again with
the same key gets its first response instead of running twice. While 20 uploads or 20 questions already wait, new
ones get 503 `busy` with `Retry-After`.

## Run the tests

Lint, type checks and all tests run in a container against their own database, with a fake model server, so no
model or key is needed:

```sh
docker compose run --rm test
```

This also starts Postgres and Redis, which keep running afterwards.

## Stop

`docker compose down` stops everything; add `-v` to delete the data as well.

## Licence

None. All rights reserved.
