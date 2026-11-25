import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type DocumentInfo } from './api';
import { DocumentList } from './DocumentList';
import { DocumentWindow } from './DocumentWindow';
import { UploadDialog } from './UploadDialog';
import { closeWindow, openWindow } from './windows';

export interface Highlight {
  start: number;
  end: number;
}

const FULL = 'Four documents are open. Close one to open another.';

export function App() {
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [open, setOpen] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  // Which open window the list last pointed to; the count changes on every click, so a second click points again.
  const [pointed, setPointed] = useState<{ id: string; count: number } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const sidebar = useRef<HTMLElement>(null);
  // The open windows, the document list and whether the upload dialog is open, for handlers that finish later, such
  // as an upload.
  const openNow = useRef(open);
  const documentsNow = useRef(documents);
  const uploadOpenNow = useRef(uploadOpen);
  useEffect(() => {
    openNow.current = open;
    documentsNow.current = documents;
    uploadOpenNow.current = uploadOpen;
  }, [open, documents, uploadOpen]);

  // Counts uploads and retries, so a list read that started before one doesn't undo it when it lands.
  const changes = useRef(0);
  // One read at a time, so a slow one can't land after the next poll's and show older states.
  const reading = useRef(false);
  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const seen = changes.current;
    try {
      const list = await api.documents();
      if (seen === changes.current) setDocuments(list);
      setListError(null);
    } catch (err) {
      setListError((err as ApiError).message);
    } finally {
      reading.current = false;
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

  // An upload goes first, as the list is newest first; a retried document keeps its place.
  const changed = (doc: DocumentInfo) => {
    changes.current++;
    setDocuments((list) =>
      list.some((d) => d.id === doc.id)
        ? list.map((d) => (d.id === doc.id ? doc : d))
        : [doc, ...list],
    );
  };

  const byId = new Map(documents.map((d) => [d.id, d]));
  const windows = open.flatMap((id) => byId.get(id) ?? []);

  // A document that has dropped out of the list (only the newest 100 are read) gives up its window's place.
  const show = (id: string, focus = false) => {
    const listed = new Set(documentsNow.current.map((d) => d.id));
    const next = openWindow(
      openNow.current.filter((o) => listed.has(o)),
      id,
    );
    if (next.result === 'already-open' || (focus && next.result === 'opened')) {
      setPointed((p) => ({ id, count: (p?.count ?? 0) + 1 }));
    }
    setNotice(next.result === 'full' ? FULL : '');
    openNow.current = next.open;
    setOpen(next.open);
  };

  const close = (id: string) => {
    openNow.current = closeWindow(openNow.current, id);
    setOpen(openNow.current);
    setNotice('');
    setPointed((p) => (p?.id === id ? null : p));
    // The window and its button go, so the focus moves to the document in the list.
    sidebar.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus();
  };

  const upload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const doc = await api.upload(file);
      changed(doc);
      // With the dialog still open, the focus goes to the new window (the button that opened the dialog may be gone
      // with the empty page). Closed, the reader has moved on, so the focus stays where it is.
      const focus = uploadOpenNow.current;
      setUploadOpen(false);
      show(doc.id, focus);
    } catch (err) {
      // Shown in the dialog; if it was closed meanwhile, the upload button says so until it is opened again.
      setUploadError((err as ApiError).message);
    } finally {
      setUploading(false);
    }
  };

  const startUpload = () => setUploadOpen(true);
  const uploadLabel = uploading
    ? 'Uploading'
    : uploadError
      ? 'Upload failed: see why'
      : 'Upload a document';

  // A file dropped anywhere but the upload dialog's drop area is ignored; the browser would otherwise open it in
  // place of the app, and every open window with it. Dragged text still drops into the question box.
  useEffect(() => {
    const ignore = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', ignore);
    window.addEventListener('drop', ignore);
    return () => {
      window.removeEventListener('dragover', ignore);
      window.removeEventListener('drop', ignore);
    };
  }, []);

  return (
    <div className="app">
      <h1 className="visually-hidden">Curie document chat</h1>
      <DocumentList
        documents={documents}
        open={open}
        notice={notice}
        listError={listError}
        uploadLabel={uploadLabel}
        uploadFailed={uploadError !== null && !uploading}
        listRef={sidebar}
        onSelect={show}
        onUpload={startUpload}
      />
      <main className={`workspace count-${windows.length}`} aria-label="Open documents">
        {windows.length === 0 ? (
          <div className="empty">
            <p>Upload a document, or choose one from the list, to read it and ask about it.</p>
            <button className="button primary large" onClick={startUpload}>
              {uploadLabel}
            </button>
          </div>
        ) : (
          windows.map((d) => (
            <DocumentWindow
              key={d.id}
              document={d}
              pointed={pointed?.id === d.id ? pointed.count : 0}
              onClose={() => close(d.id)}
              onChanged={changed}
            />
          ))
        )}
      </main>
      <UploadDialog
        open={uploadOpen}
        busy={uploading}
        error={uploadError}
        onFile={(file) => void upload(file)}
        onClose={() => {
          setUploadOpen(false);
          // Seen by now, so the upload button goes back to normal.
          setUploadError(null);
        }}
      />
    </div>
  );
}
