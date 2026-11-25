import { useRef, useState } from 'react';
import { api, type ApiError, type DocumentInfo } from './api';

const STATUS: Record<DocumentInfo['status'], string> = {
  queued: 'Waiting',
  processing: 'Reading',
  ready: 'Ready',
  failed: 'Failed',
};

export function DocumentList({
  documents,
  selectedId,
  error,
  onSelect,
  onChanged,
}: {
  documents: DocumentInfo[];
  selectedId: string | null;
  error: string | null;
  onSelect: (id: string) => void;
  onChanged: (doc: DocumentInfo) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'retry' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (kind: 'upload' | 'retry', action: () => Promise<DocumentInfo>) => {
    setBusy(kind);
    setProblem(null);
    try {
      onChanged(await action());
    } catch (err) {
      setProblem((err as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <nav className="pane documents" aria-label="Documents">
      <label className="upload">
        <span className="button primary">
          {busy === 'upload' ? 'Uploading' : 'Upload a document'}
        </span>
        <input
          ref={input}
          type="file"
          accept=".md,.markdown,.txt,.pdf,text/markdown,text/plain,application/pdf"
          disabled={busy !== null}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void run('upload', () => api.upload(file));
          }}
        />
      </label>
      <p className="hint">Markdown or text up to 1 MB, PDF up to 5 MB and 100 pages.</p>
      {(problem ?? error) && (
        <p className="error" role="alert">
          {problem ?? error}
        </p>
      )}
      <ul>
        {documents.map((d) => (
          <li key={d.id}>
            <button
              className={`document${d.id === selectedId ? ' selected' : ''}`}
              aria-current={d.id === selectedId ? 'true' : undefined}
              onClick={() => onSelect(d.id)}
            >
              <bdi className="title">{d.title}</bdi>
              <span className={`status ${d.status}`}>{STATUS[d.status]}</span>
            </button>
            {d.id === selectedId && d.retryable && (
              <button
                className="button small"
                disabled={busy !== null}
                onClick={() => void run('retry', () => api.retryDocument(d.id))}
              >
                {d.status === 'ready' ? 'Prepare again for the current model' : 'Try again'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
