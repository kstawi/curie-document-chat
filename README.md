# Curie document chat

A small service for asking questions about one document and getting answers backed by quotes from it. Built as a
take-home exercise for Curie; it is not affiliated with or endorsed by Curie.

Upload a Markdown, plain-text or PDF file; it is split into passages and indexed in the background. Then ask questions
in a conversation about it. Each answer comes with quotes that the server has found in the document, with their
position, line and section. If the document doesn't answer the question, the reply says so.

Design and limits: [DESIGN.md](DESIGN.md). Endpoints: [docs/integration.md](docs/integration.md). Failure cases and
how each was checked: [docs/edge-cases.md](docs/edge-cases.md). How a coding agent was used and checked:
[docs/ai-use.md](docs/ai-use.md).

**Recording** (under five minutes):
https://drive.google.com/file/d/1D8keRAuGFamHvyK0pqtZQCdTHl8rDz1w/view?usp=sharing

**Time.** About 19.5 hours of work from the first line of code to submission, against the four-hour target, plus about
3.6 hours of preparation before it (planning and a test of local models). Measured afterwards from the session logs,
the coding agent was working for about 17.7 of those hours and waiting on me (to read its replies, decide, answer its
questions, or record) for about 1.5; about 0.3 were gaps counted as neither. Time I spent reading along while it
worked counts as its time, and about 0.9 more hours of my replies fell between the logged rows. Helper agents, mostly
reviewers, ran at least about 7 more hours in parallel, preparation included. The preparation splits the same way into
about 2.1, 0.8 and 0.7 hours. Breaks, overnight ones included, are listed separately in [TIMELOG.md](TIMELOG.md), with
the split per row. Beyond the required core: PDF upload and the web app (both optional in the brief), the written note
on a million documents, a search benchmark, conversation names and deleting documents.

## Run it

Needs Docker with Compose, ports 3000 and 8080 free, and a model: LM Studio on this machine, or a key for any
OpenAI-compatible service. Built and run on Windows with Docker Desktop; Linux and macOS are untested.

**First the model. LM Studio (the default):** install it and download both models below. The chat model needs about
16 GB of free memory. Load both with no idle timer, so a request never waits for a model to load:

```sh
lms server start
lms load google/gemma-4-26b-a4b-qat -c 16384 -y
lms load text-embedding-nomic-embed-text-v1.5 -y
```

The containers reach it at `host.docker.internal:1234`. On Linux, LM Studio must listen on more than 127.0.0.1 for
that to work (not tested).

**Or a hosted model:** uncomment the Gemini block in `.env` (next step) and add your key, or point `MODEL_BASE_URL`,
`CHAT_MODEL` and `EMBEDDING_MODEL` at another OpenAI-compatible service. Gemini's free tier often answers 503 or 429.
Answers on the hosted path were last run in step 2 of the build; DESIGN.md says what that leaves unchecked.

**Then the stack:**

```sh
cp .env.example .env   # then pick the model block you want
docker compose up --build -d --wait
curl http://127.0.0.1:3000/ready   # "model": {"chat": "ok", "embedding": "ok", ...} once both answer
```

The worker checks the models when it starts; if they came up later, `docker compose restart worker` checks again.

## Try it

Open http://127.0.0.1:8080 and upload a file, for example `samples/harbor-archive-pilot.md`. Once it reads Ready,
ask about it on the right; each quote under an answer, when clicked, shows where it sits in the document.

The API itself is on port 3000. From the repository folder, in a POSIX shell (Git Bash, WSL, macOS or Linux;
PowerShell quotes the JSON differently):

```sh
# Upload the sample note. Send the title before the file.
curl -F "title=Harbor Archive" -F "file=@samples/harbor-archive-pilot.md" http://127.0.0.1:3000/documents
# → {"id":"<doc>","status":"queued",...}; poll until "status":"ready"
curl http://127.0.0.1:3000/documents/<doc>

# Start a conversation and ask.
curl -X POST http://127.0.0.1:3000/documents/<doc>/conversations
# → {"id":"<conversation>",...}
curl -H "content-type: application/json" -d '{"question":"Who owned the pilot?"}' \
  http://127.0.0.1:3000/conversations/<conversation>/messages
# → {"id":"<message>","status":"pending",...}; poll until it is "completed"
curl http://127.0.0.1:3000/messages/<message>
```

A completed answer looks like this (with the local model, answers took from about 15 seconds to two and a half
minutes in testing):

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
so it isn't shown). `scripts/smoke.mjs` (Node 22 on the host) runs the sample questions against a running stack.

A failed document or answer can be tried again with `POST /documents/<doc>/retry` or `POST /messages/<message>/retry`
(only a conversation's latest question). Every POST accepts an `Idempotency-Key` header: a request sent again with the
same key gets its first response instead of running twice, and a different request with that key gets 422. While 20
uploads or 20 questions already wait, new ones get 503 `busy` with `Retry-After`. `DELETE /documents/<doc>` deletes a
document with its conversations and answers.

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
