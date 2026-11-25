import { useCallback, useEffect, useState } from 'react';
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

  const refresh = useCallback(async () => {
    try {
      setDocuments(await api.documents());
      setListError(null);
    } catch (err) {
      setListError((err as ApiError).message);
    }
  }, []);

  useEffect(() => {
    let current = true;
    api.documents().then(
      (list) => current && setDocuments(list),
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
          setDocuments((list) => [doc, ...list.filter((d) => d.id !== doc.id)]);
          select(doc.id);
        }}
      />
      <DocumentView document={selected} highlight={highlight} />
      {selected ? (
        <Chat key={selected.id} document={selected} onQuote={setHighlight} />
      ) : (
        <section className="pane chat" aria-label="Conversation" />
      )}
    </div>
  );
}
