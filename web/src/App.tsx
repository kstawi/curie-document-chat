import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type DocumentInfo } from './api';
import { Chat } from './Chat';
import { DocumentList } from './DocumentList';
import { DocumentView } from './DocumentView';

export interface Highlight {
  start: number;
  end: number;
}

export function App() {
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  // Counts uploads and retries, so a list read that started before one doesn't undo it when it lands.
  const changes = useRef(0);
  const refresh = useCallback(async () => {
    const seen = changes.current;
    try {
      const list = await api.documents();
      if (seen === changes.current) setDocuments(list);
      setListError(null);
    } catch (err) {
      setListError((err as ApiError).message);
    }
  }, []);

  useEffect(() => {
    let current = true;
    const seen = changes.current;
    api.documents().then(
      (list) => current && seen === changes.current && setDocuments(list),
      (err: ApiError) => current && setListError(err.message),
    );
    return () => {
      current = false;
    };
  }, []);

  // While a document is being prepared, its status is checked every two seconds.
  const preparing = documents.some((d) => d.status === 'queued' || d.status === 'processing');
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [preparing, refresh]);

  const selected = documents.find((d) => d.id === selectedId) ?? null;
  const select = (id: string) => {
    setSelectedId(id);
    setHighlight(null);
  };

  return (
    <div className="app">
      <DocumentList
        documents={documents}
        selectedId={selectedId}
        error={listError}
        onSelect={select}
        onChanged={(doc) => {
          changes.current++;
          // A new upload goes first, as the list is newest first; a retried document keeps its place.
          setDocuments((list) =>
            list.some((d) => d.id === doc.id)
              ? list.map((d) => (d.id === doc.id ? doc : d))
              : [doc, ...list],
          );
          select(doc.id);
        }}
      />
      {/* Keyed, so a failed content read shows only for its own document and is tried again on return. */}
      <DocumentView key={selected?.id} document={selected} highlight={highlight} />
      {selected ? (
        <Chat key={selected.id} document={selected} onQuote={setHighlight} />
      ) : (
        <section className="pane chat" aria-label="Conversation" />
      )}
    </div>
  );
}
