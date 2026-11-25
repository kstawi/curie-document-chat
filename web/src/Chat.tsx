import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  follow,
  wording,
  type ApiError,
  type Conversation,
  type DocumentInfo,
  type Message,
} from './api';
import type { Highlight } from './App';

const STAGES: Record<string, string> = {
  waiting: 'Waiting in the queue',
  rewriting: 'Working out what the follow-up refers to',
  searching: 'Searching the document',
  writing: 'Writing the answer',
  checking: 'Checking quotes against the text',
  retrying: 'The model server did not answer; trying again shortly',
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    // Two conversations started in the same minute would otherwise look alike.
    second: '2-digit',
  });

// What a screen reader hears as an answer the reader is waiting for moves on.
function progress(m: Message) {
  if (m.status === 'pending') return STAGES[m.stage ?? 'waiting'] ?? 'Working on the answer.';
  if (m.status === 'failed') return 'The answer failed.';
  if (m.outcome === 'answered') return 'Answer ready.';
  if (m.outcome === 'not_in_document') return 'The document does not seem to cover this.';
  return 'No answer could be backed by a quote.';
}

function where(q: Message['quotes'][number]) {
  if (q.startPage !== undefined) {
    return q.endPage !== q.startPage
      ? `Pages ${q.startPage} to ${q.endPage}`
      : `Page ${q.startPage}`;
  }
  return q.section ? `${q.section}, line ${q.line}` : `Line ${q.line}`;
}

export function Chat({
  document,
  onQuote,
}: {
  document: DocumentInfo;
  onQuote: (range: Highlight) => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Messages with the conversation they belong to, so switching conversations shows none until its own arrive.
  const [thread, setThread] = useState<{ id: string | null; messages: Message[] }>({
    id: null,
    messages: [],
  });
  const messages = useMemo(
    () => (thread.id === conversationId ? thread.messages : []),
    [thread, conversationId],
  );
  const [question, setQuestion] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const stopFollowing = useRef<(() => void) | null>(null);
  // The conversation on screen, for replies that arrive after the reader has switched to another.
  const shown = useRef<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const put = (message: Message) =>
    setThread((t) =>
      t.id !== message.conversationId
        ? t
        : {
            ...t,
            messages: t.messages.some((m) => m.id === message.id)
              ? t.messages.map((m) => (m.id === message.id ? message : m))
              : [...t.messages, message],
          },
    );
  const track = (id: string) => {
    stopFollowing.current?.();
    stopFollowing.current = follow(id, (message) => {
      put(message);
      if (message.conversationId === shown.current) setAnnouncement(progress(message));
    });
  };

  // Stop following an answer when this conversation or document is left, and follow none that is sent after.
  useEffect(
    () => () => {
      stopFollowing.current?.();
      shown.current = null;
    },
    [],
  );

  useEffect(() => {
    let current = true;
    api
      .conversations(document.id)
      .then((list) => {
        if (!current) return;
        setConversations(list);
        setConversationId(list[0]?.id ?? null);
      })
      .catch((err: ApiError) => current && setProblem(err.message));
    return () => {
      current = false;
    };
  }, [document.id]);

  useEffect(() => {
    stopFollowing.current?.();
    shown.current = conversationId;
    if (!conversationId) return;
    let current = true;
    api
      .messages(conversationId)
      .then((list) => {
        if (!current) return;
        setThread({ id: conversationId, messages: list });
        const pending = list.find((m) => m.status === 'pending');
        if (pending) track(pending.id);
      })
      .catch((err: ApiError) => current && setProblem(err.message));
    return () => {
      current = false;
    };
    // `track` only reads refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Scrolled down when a question is added or its answer arrives, not on every progress step.
  const latest = messages.at(-1);
  const scrollKey = `${messages.length}:${latest?.status}`;
  useEffect(() => {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    end.current?.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'auto' });
  }, [scrollKey]);

  const pending = messages.some((m) => m.status === 'pending');
  // A ready document indexed with another embedding model can't take questions until it's prepared again.
  const otherModel = document.status === 'ready' && document.retryable;
  const ready = document.status === 'ready' && !otherModel;

  const send = async (action: () => Promise<Message>) => {
    setSending(true);
    setProblem(null);
    try {
      const message = await action();
      put(message);
      // The first question's conversation is followed once it is switched to.
      if (message.conversationId === shown.current) track(message.id);
      return true;
    } catch (err) {
      setProblem((err as ApiError).message);
      return false;
    } finally {
      setSending(false);
    }
  };

  const ask = async () => {
    const text = question.trim();
    // Enter reaches here without the Ask button's checks.
    if (!text || sending || pending || !ready) return;
    const sent = await send(async () => {
      if (conversationId) return api.ask(conversationId, text);
      // The first question of a conversation creates it; the conversation is switched to once the question is in,
      // so loading its messages finds it.
      const created = await api.newConversation(document.id);
      try {
        return await api.ask(created.id, text);
      } finally {
        setConversations((list) => [created, ...list]);
        setConversationId(created.id);
      }
    });
    if (sent) setQuestion('');
    // The Ask button turns disabled while sending, which would drop the focus.
    input.current?.focus();
  };

  return (
    <section className="pane chat" aria-label="Conversation">
      <header className="chat-header">
        {conversations.length > 0 && (
          <label className="field">
            <span>Conversation</span>
            <select
              value={conversationId ?? ''}
              onChange={(e) => setConversationId(e.target.value || null)}
            >
              {conversationId === null && <option value="">New conversation</option>}
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {when(c.createdAt)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className="button small"
          disabled={conversationId === null}
          onClick={() => {
            setConversationId(null);
            input.current?.focus();
          }}
        >
          New conversation
        </button>
      </header>

      <div className="messages">
        {messages.length === 0 && (
          <p className="muted">
            {ready
              ? 'Ask a question about this document. Answers come only from its text, with the quotes that back them.'
              : otherModel
                ? 'This document was prepared with a different model than the one now set up. Prepare it again from the list to ask questions.'
                : document.status === 'failed' && !document.retryable
                  ? 'This document could not be prepared, so it cannot take questions.'
                  : 'Questions can be asked once the document is ready.'}
          </p>
        )}
        {messages.map((m) => (
          <article key={m.id} className="message">
            <p className="question">
              <bdi>{m.question}</bdi>
            </p>
            {m.status === 'pending' && <p className="stage">{STAGES[m.stage ?? 'waiting']}</p>}
            {m.status === 'completed' && m.outcome === 'answered' && (
              <>
                <p className="answer">
                  <bdi>{m.answer}</bdi>
                </p>
                <ul className="quotes">
                  {m.quotes.map((q) => (
                    <li key={`${q.start}-${q.end}`}>
                      <button
                        className="quote"
                        onClick={() => onQuote({ start: q.start, end: q.end })}
                      >
                        <bdi className="quote-text">{q.text}</bdi>
                        <span className="quote-where">{where(q)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {m.status === 'completed' && m.outcome === 'not_in_document' && (
              <>
                <p className="answer">
                  <bdi>{m.note}</bdi>
                </p>
                <p className="muted small">
                  Not backed by a quote: the document does not seem to cover this.
                </p>
              </>
            )}
            {m.status === 'completed' && m.outcome === 'unsupported' && (
              <p className="muted">
                No answer could be backed by a quote from the document, so none is shown. Try asking
                more specifically.
              </p>
            )}
            {m.status === 'failed' && (
              <>
                <p className="error">{m.error && wording(m.error)}</p>
                {m.id === latest?.id && (
                  <button
                    className="button small"
                    disabled={sending}
                    onClick={() =>
                      // The button goes once the retry is in, so the focus moves to the question box.
                      void send(() => api.retryMessage(m.id)).then(() => input.current?.focus())
                    }
                  >
                    Try again
                  </button>
                )}
              </>
            )}
          </article>
        ))}
        <div ref={end} />
      </div>
      {/* Mounted from the start, so screen readers announce each change to it; filled only by answers being followed. */}
      <p className="visually-hidden" role="status">
        {announcement}
      </p>

      <form
        className="ask"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        {problem && (
          <p className="error" role="alert">
            {problem}
          </p>
        )}
        <label className="field-label" htmlFor="question">
          Your question
        </label>
        <textarea
          ref={input}
          id="question"
          value={question}
          maxLength={2000}
          rows={3}
          disabled={!ready}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void ask();
            }
          }}
        />
        <button
          className="button primary"
          disabled={!ready || pending || sending || !question.trim()}
        >
          Ask
        </button>
      </form>
    </section>
  );
}
