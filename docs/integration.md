# Integrating with the API

What a client needs beyond the route list: how an answer's progress is streamed, and how quotes point into the
document. The routes and their bodies are in `DESIGN.md` and the Fastify schemas.

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
| `progress` | once on connecting, then on each new stage  | the message with `status: "pending"`; `answer`, `note`, `quotes` empty |
| `final`    | once, with event id `final`, then the close | the message with `status: "completed"` or `"failed"`                   |

The stream also sends a comment line (`: heartbeat`) every 15 seconds (`STREAM_HEARTBEAT_MS`), which keeps proxies
from closing a quiet connection; clients ignore it.

`stage` on a pending message is one of:

- `null`: waiting in the queue;
- `rewriting`: turning a follow-up into a standalone question (only when there are earlier answers);
- `searching`, `writing`, `checking` (the quotes);
- `retrying`: the model server was down or stuck, and the answer is waiting to be tried again.

No draft text is ever sent: an answer appears only in the `final` event, after its quotes were checked. A `final`
message with `status: "failed"` carries `error.code`; `POST /messages/:id/retry` starts it again (only the latest
question of a conversation, and only once it has failed), after which a new stream follows the new attempt.

### Reconnecting

The browser's `EventSource` reconnects by itself whenever a stream closes, including after the final event. It then
sends `Last-Event-ID: final`, and the server answers 204, which makes `EventSource` stop. A client that connects
after the answer is done still receives it once, as a `final` event. A dropped connection before the end is simply
opened again: the first event repeats the current state.

Through the web app, the API sits under `/api`:

```js
const events = new EventSource(`/api/messages/${id}/events`);
events.addEventListener('progress', (e) => showStage(JSON.parse(e.data).stage));
events.addEventListener('final', (e) => {
  showMessage(JSON.parse(e.data));
  events.close();
});
```

With curl, `curl -N http://127.0.0.1:3000/messages/<id>/events` prints the events as they arrive.

Other responses: 404 for an unknown message and 400 for a malformed id, both as the usual JSON error body, before
any stream starts.

## Quote offsets

Each quote in an answer has `start` and `end`, offsets into the document's text as `GET /documents/:id/content`
returns it, counted in UTF-16 code units (JavaScript string indices), so `content.slice(start, end)` is the quoted
span. `line` is the 1-based line where the quote starts, and `section` the heading path above it. Line endings in
stored text are always `\n`.

A quote's `text` is that span with hidden characters (controls, zero-width and direction characters, tag
characters) removed, so it can differ from the raw slice when the document contains them; highlight by offsets, not
by searching for `text`.
