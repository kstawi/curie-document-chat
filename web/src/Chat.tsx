import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  follow,
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
  });

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
  const stopFollowing = useRef<(() => void) | null>(null);
  const end = useRef<HTMLDivElement>(null);

  const put = (message: Message) =>
    setThread((t) => ({
      ...t,
      messages: t.messages.some((m) => m.id === message.id)
        ? t.messages.map((m) => (m.id === message.id ? message : m))
        : [...t.messages, message],
    }));
  const track = (id: string) => {
    stopFollowing.current?.();
    stopFollowing.current = follow(id, put);
  };

  // Stop following an answer when this conversation or document is left.
  useEffect(() => () => stopFollowing.current?.(), []);

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

  useEffect(() => {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    end.current?.scrollIntoView({ block: 'end', behavior: smooth ? 'smooth' : 'auto' });
  }, [messages]);

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
      track(message.id);
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
    if (!text) return;
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
  };

  const latest = messages.at(-1);
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
          onClick={() => setConversationId(null)}
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
            {m.status === 'pending' && (
              <p className="stage" role="status">
                {STAGES[m.stage ?? 'waiting']}
              </p>
            )}
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
                <p className="error">{m.error?.message}</p>
                {m.id === latest?.id && (
                  <button
                    className="button small"
                    disabled={sending}
                    onClick={() => void send(() => api.retryMessage(m.id))}
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
          id="question"
          value={question}
          maxLength={2000}
          rows={3}
          disabled={!ready}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
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
