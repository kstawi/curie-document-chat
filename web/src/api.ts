import type { PageSpan } from './text';

export interface DocumentInfo {
  id: string;
  title: string;
  format: 'markdown' | 'text' | 'pdf';
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error: { code: string; message: string } | null;
  retryable: boolean;
  createdAt: string;
}

export interface DocumentContent {
  content: string;
  format: DocumentInfo['format'];
  pages: PageSpan[] | null;
}

export interface Conversation {
  id: string;
  createdAt: string;
}

export interface Quote {
  text: string;
  start: number;
  end: number;
  line: number;
  section: string;
  startPage?: number;
  endPage?: number;
}

export type Stage = 'rewriting' | 'searching' | 'writing' | 'checking' | 'retrying' | null;

export interface Message {
  id: string;
  sequence: number;
  question: string;
  status: 'pending' | 'completed' | 'failed';
  stage: Stage;
  outcome: 'answered' | 'not_in_document' | 'unsupported' | null;
  answer: string | null;
  note: string | null;
  quotes: Quote[];
  error: { code: string; message: string } | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// The API answers errors as JSON with a fixed code and a message meant for people. A proxy in front of it (nginx
// during a restart, say) may answer with a page of HTML instead, which is not shown.
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, 'network', 'The server could not be reached. Check that it is running.');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error = body as { error?: string; message?: string } | null;
    throw new ApiError(
      res.status,
      error?.error ?? 'http_error',
      error?.message ?? `The server answered ${res.status}. Try again shortly.`,
    );
  }
  return body as T;
}

const json = (method: string, payload?: unknown): RequestInit => ({
  method,
  headers: payload === undefined ? {} : { 'content-type': 'application/json' },
  body: payload === undefined ? undefined : JSON.stringify(payload),
});

export const api = {
  documents: () => call<{ items: DocumentInfo[] }>('/documents?limit=100').then((r) => r.items),
  upload(file: File) {
    const form = new FormData();
    form.append('file', file);
    return call<DocumentInfo>('/documents', { method: 'POST', body: form });
  },
  retryDocument: (id: string) => call<DocumentInfo>(`/documents/${id}/retry`, json('POST')),
  content: (id: string) => call<DocumentContent>(`/documents/${id}/content`),
  conversations: (documentId: string) =>
    call<{ items: Conversation[] }>(`/documents/${documentId}/conversations`).then((r) => r.items),
  newConversation: (documentId: string) =>
    call<Conversation>(`/documents/${documentId}/conversations`, json('POST')),
  messages: (conversationId: string) =>
    call<{ items: Message[] }>(`/conversations/${conversationId}/messages`).then((r) => r.items),
  ask: (conversationId: string, question: string) =>
    call<Message>(`/conversations/${conversationId}/messages`, json('POST', { question })),
  retryMessage: (id: string) => call<Message>(`/messages/${id}/retry`, json('POST')),
  message: (id: string) => call<Message>(`/messages/${id}`),
};

// Follows one answer until it is final: the event stream while it lasts, polling if the browser gives up on it (an
// error status while the API restarts). Returns a function that stops following.
export function follow(id: string, update: (message: Message) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const events = new EventSource(`/api/messages/${id}/events`);
  const stop = () => {
    stopped = true;
    events.close();
    clearTimeout(timer);
  };
  const poll = async () => {
    if (stopped) return;
    try {
      const message = await api.message(id);
      update(message);
      if (message.status !== 'pending') return stop();
    } catch {
      // The next poll tries again.
    }
    timer = setTimeout(() => void poll(), 2_000);
  };
  events.addEventListener('progress', (e) => update(JSON.parse((e as MessageEvent<string>).data)));
  events.addEventListener('final', (e) => {
    update(JSON.parse((e as MessageEvent<string>).data));
    stop();
  });
  events.onerror = () => {
    // CLOSED here means the browser gave up on the stream, not that the answer is done.
    if (events.readyState === EventSource.CLOSED && !stopped) void poll();
  };
  return stop;
}
