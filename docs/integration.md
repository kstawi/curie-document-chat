# Integrating with the API

What a client needs beyond the route list: how an answer's progress is streamed, and how quotes point into the
document. The routes and their bodies are in `DESIGN.md` and the Fastify schemas.

Uploads are Markdown or text up to 1 MB, or PDF up to 5 MB and 100 pages; the type comes from the file's first bytes.

## Following an answer

`POST /conversations/:id/messages` returns 202 with the message, still `pending`. From there, either poll
`GET /messages/:id` or open the event stream:

```
GET /messages/:id/events
Accept: text/event-stream
```

The stream sends the message as it is stored now, then a new event each time it changes, then the final state, and
closes. Every event's data is one line of JSON, the same object `GET /messages/:id` returns.

| Event      | Sent                                        | Data                                                                   |
| ---------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| `progress` | once on connecting, then on stage changes   | the message with `status: "pending"`; `answer`, `note`, `quotes` empty |
| `final`    | once, with event id `final`, then the close | the message with `status: "completed"` or `"failed"`                   |

The stream also sends a comment line (`: heartbeat`) every 15 seconds (`STREAM_HEARTBEAT_MS`), which keeps proxies
from closing a quiet connection; clients ignore it.

`stage` on a pending message is one of:

- `null`: waiting in the queue, including after a worker stopped mid-answer and put it back;
- `rewriting`: turning a follow-up into a standalone question (only when there are earlier answers);
- `searching`, `writing`, `checking` (the quotes);
- `retrying`: the model server was down or stuck, and the answer is waiting to be tried again.

Stages can be skipped: one that is over before the stream reads the message again (`checking` often is) is never
sent, so a client showing a list of steps should mark the earlier ones done when a later one arrives.

If a worker crashes rather than stopping, the last stage stays while no worker runs. Once one runs again, BullMQ
finds the abandoned job within about a minute and runs it again, and the stage moves on from there.

No draft text is ever sent: an answer appears only in the `final` event, after its quotes were checked. A `final`
message with `status: "failed"` carries `error.code`; `POST /messages/:id/retry` starts it again (only the latest
question of a conversation, and only once it has failed), after which a new stream follows the new attempt.

### Reconnecting

The browser's `EventSource` reconnects by itself whenever a stream closes, including after the final event. It then
sends `Last-Event-ID: final`, and the server answers 204 without looking the message up, which makes `EventSource`
stop. A client that connects after the answer is done still receives it once, as a `final` event. After a dropped
connection, `EventSource` reconnects and the first event repeats the current state.

It gives up for good on an error status, though: a 503 while the API shuts down (`shutting_down`), or a 502 from a
proxy while the API restarts. A client that has not had its `final` event should then open a new stream after a
pause, or fall back to `GET /messages/:id`.

Through the web app, the API sits under `/api`:

```js
const events = new EventSource(`/api/messages/${id}/events`);
events.addEventListener('progress', (e) => showStage(JSON.parse(e.data).stage));
events.addEventListener('final', (e) => {
  showMessage(JSON.parse(e.data));
  events.close();
});
// CLOSED here means EventSource gave up (an error status), not the end of the answer.
events.onerror = () => {
  if (events.readyState === EventSource.CLOSED) setTimeout(reopen, 3000);
};
```

The web app itself switches to polling `GET /messages/:id` every 2 s once its stream gives up. With curl,
`curl -N http://127.0.0.1:3000/messages/<id>/events` prints the events as they arrive.

Other responses, as the usual JSON error body before any stream starts: 404 for an unknown message, 400 for a
malformed id, 503 `shutting_down` (or, for a request that reaches the API after it began closing, Fastify's own
503 body).

## Quote offsets

Each quote in an answer has `start` and `end`, offsets into the document's text as `GET /documents/:id/content`
returns it, counted in UTF-16 code units (JavaScript string indices), so `content.slice(start, end)` is the quoted
span. `line` is the 1-based line where the quote starts, and `section` the heading path above it. Line endings in
stored text are always `\n`.

A quote's `text` is that span with hidden characters (controls, zero-width and direction characters, tag
characters) removed, so it can differ from the raw slice when the document contains them; highlight by offsets, not
by searching for `text`.

### PDFs

For a PDF, `GET /documents/:id/content` also returns `pages`: `[{ page, start, end }]`, where each page's text sits in
`content`; pages are joined by a blank line. A quote from a PDF has `startPage` and `endPage`, and its `section` is
`page N`, or `pages N–M` when it crosses a page break. A running head or footer appears once, where it is first found, and page numbers not at all; words
hyphenated at a line end stay as the PDF has them (a quote may still join them).
