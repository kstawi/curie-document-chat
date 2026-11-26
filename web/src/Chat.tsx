import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
  naming: 'Naming the conversation',
  rewriting: 'Working out what the follow-up refers to',
  searching: 'Searching the document',
  writing: 'Writing the answer',
  checking: 'Checking quotes against the text',
  retrying: 'The model server did not answer; trying again shortly',
};

// The model writes for half a minute or more; words that change every few seconds show the page is not stuck.
const THINKING = ['Thinking…', 'Reading the passages…', 'Researching…', 'Writing the answer…'];

function Thinking() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setN((i) => (i + 1) % THINKING.length), 2500);
    return () => clearInterval(timer);
  }, []);
  return (
    <p className="stage">
      <span className="visually-hidden">{STAGES.writing}</span>
      {/* A new key restarts the fade-in; screen readers get the real stage instead of every change. */}
      <span key={n} className="thinking" aria-hidden="true">
        {THINKING[n]}
      </span>
    </p>
  );
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
// The name with a short date, so two similar names can still be told apart. An option can't hold <bdi>, so the name is
// isolated with the Unicode marks instead, and a right-to-left name keeps the date after it.
const ISOLATE = String.fromCharCode(0x2068);
const END_ISOLATE = String.fromCharCode(0x2069);
const label = (c: Conversation) =>
  `${ISOLATE}${c.title ?? 'New conversation'}${END_ISOLATE} (${when(c.createdAt)})`;

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
  // The name being typed while renaming the conversation on screen, and the name it started from; null when not
  // renaming.
  const [draft, setDraft] = useState<{ value: string; from: string } | null>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  // Set by Escape: the box loses the focus as it goes, which would otherwise save what was typed.
  const renameCancelled = useRef(false);
  const stopFollowing = useRef<(() => void) | null>(null);
  // The conversation on screen, for replies that arrive after the reader has switched to another.
  const shown = useRef<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Up to four chats share the page, so the question box's id is unique to this one.
  const questionId = useId();

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
  // Read again after a question is sent and when its answer is final, which is when a name can have changed.
  const refreshNames = () =>
    api.conversations(document.id).then(setConversations, () => {
      // The names on screen stay as they were; the next refresh tries again.
    });

  const track = (id: string) => {
    stopFollowing.current?.();
    stopFollowing.current = follow(id, (message) => {
      put(message);
      if (message.conversationId === shown.current) setAnnouncement(progress(message));
      if (message.status !== 'pending') void refreshNames();
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
        // An answer finished while another conversation was on screen may have brought this one its name.
        void refreshNames();
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
      void refreshNames();
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

  // Enter saves and so does clicking away; Escape, an empty name or the name the box opened with sends nothing, so a
  // name the model gives meanwhile is never overwritten by an untouched box.
  const saveName = async () => {
    const title = draft?.value.trim();
    const from = draft?.from;
    setDraft(null);
    if (renameCancelled.current) {
      renameCancelled.current = false;
      return;
    }
    if (!conversationId || !title || title === from) return;
    const id = conversationId;
    // Shown at once, so the box reopened before the server answers starts from the new name.
    setConversations((list) => list.map((c) => (c.id === id ? { ...c, title } : c)));
    try {
      const renamed = await api.rename(id, title);
      setConversations((list) => list.map((c) => (c.id === renamed.id ? renamed : c)));
    } catch (err) {
      // The name it had, at once, as the server may be out of reach for the reread too.
      setProblem((err as ApiError).message);
      setConversations((list) =>
        list.map((c) => (c.id === id ? { ...c, title: from || null } : c)),
      );
      void refreshNames();
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
        // A reread of the names may have listed it already; listed twice, it would share a key.
        setConversations((list) =>
          list.some((c) => c.id === created.id) ? list : [created, ...list],
        );
        setConversationId(created.id);
      }
    });
    if (sent) setQuestion('');
    // The Ask button turns disabled while sending, which would drop the focus.
    input.current?.focus();
  };

  return (
    <section className="pane chat" aria-label={`Conversation about ${document.title}`}>
      <header className="chat-header">
        {draft !== null ? (
          <label className="field">
            <span>Name</span>
            <input
              autoFocus
              value={draft.value}
              // Not cut here: the server counts characters after cleaning, and says when a name is too long.
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              onBlur={() => {
                // Switching to another window or tab is not clicking away: the box waits, and the focus comes back.
                if (window.document.hasFocus()) void saveName();
              }}
              onKeyDown={(e) => {
                // Both hand the focus back to the Rename button; the box saves as it loses the focus.
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  renameButton.current?.focus();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  renameCancelled.current = true;
                  renameButton.current?.focus();
                }
              }}
            />
          </label>
        ) : (
          conversations.length > 0 && (
            <label className="field">
              <span>Conversation</span>
              <select
                value={conversationId ?? ''}
                // A conversation answered while another was on screen may have its name by now.
                onFocus={() => void refreshNames()}
                onChange={(e) => setConversationId(e.target.value || null)}
              >
                {conversationId === null && <option value="">New conversation</option>}
                {conversations.map((c) => (
                  <option key={c.id} value={c.id}>
                    {label(c)}
                  </option>
                ))}
              </select>
            </label>
          )
        )}
        <button
          ref={renameButton}
          className="button small"
          disabled={conversationId === null}
          onClick={() => {
            renameCancelled.current = false;
            const name = conversations.find((c) => c.id === conversationId)?.title ?? '';
            setDraft({ value: name, from: name });
          }}
        >
          Rename
        </button>
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
                ? 'This document was prepared with a different model than the one now set up. Prepare it again with the button at the top of this window to ask questions.'
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
            {m.status === 'pending' &&
              (m.stage === 'writing' ? (
                <Thinking />
              ) : (
                <p className="stage">{STAGES[m.stage ?? 'waiting']}</p>
              ))}
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
        <label className="field-label" htmlFor={questionId}>
          Your question
        </label>
        <textarea
          ref={input}
          id={questionId}
          value={question}
          maxLength={2000}
          rows={2}
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
