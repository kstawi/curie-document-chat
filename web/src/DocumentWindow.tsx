import { useEffect, useId, useRef, useState } from 'react';
import { api, type ApiError, type DocumentInfo } from './api';
import type { Highlight } from './App';
import { Chat } from './Chat';
import { DocumentView } from './DocumentView';

// The document's share of the window's width, in percent; neither side can be squeezed shut.
const MIN_SPLIT = 25;
const MAX_SPLIT = 75;
const clamp = (n: number) => Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, Math.round(n)));
const KEY_STEPS: Record<string, number> = { ArrowLeft: -5, ArrowRight: 5 };

// One open document: its text and its conversation side by side, split by a line that can be dragged.
export function DocumentWindow({
  document,
  pointed,
  onClose,
  onDeleted,
  onChanged,
}: {
  document: DocumentInfo;
  pointed: number;
  onClose: () => void;
  onDeleted: () => void;
  onChanged: (doc: DocumentInfo) => void;
}) {
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [split, setSplit] = useState(50);
  const [dragging, setDragging] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteProblem, setDeleteProblem] = useState<string | null>(null);
  const self = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const questionId = useId();

  // Pointed to from the list: outlined for a moment, with the focus moved here.
  useEffect(() => {
    const el = self.current;
    if (!pointed || !el) return;
    // After the upload dialog closes, which hands the focus back to the button that opened it.
    const frame = requestAnimationFrame(() => el.focus());
    el.dataset.pointed = '';
    const timer = setTimeout(() => delete el.dataset.pointed, 1_200);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      delete el.dataset.pointed;
    };
  }, [pointed]);

  const retry = async () => {
    setRetrying(true);
    setProblem(null);
    try {
      onChanged(await api.retryDocument(document.id));
    } catch (err) {
      setProblem((err as ApiError).message);
    } finally {
      setRetrying(false);
      // The button goes once the retry is in, so the focus moves to the window.
      self.current?.focus();
    }
  };

  const askToDelete = () => {
    setDeleteProblem(null);
    confirm.current?.showModal();
    // Cancel first, so Enter or Space right away deletes nothing.
    cancel.current?.focus();
  };

  // A failed delete hands the focus back to Cancel, once the buttons are enabled again.
  useEffect(() => {
    if (deleteProblem) cancel.current?.focus();
  }, [deleteProblem]);

  const remove = async () => {
    setDeleting(true);
    setDeleteProblem(null);
    try {
      await api.deleteDocument(document.id);
    } catch (err) {
      // Already gone (deleted in another tab, say) is what was asked for.
      if ((err as ApiError).status !== 404) {
        setDeleting(false);
        // Escape closes the dialog even while it waits; then the window says why, not the hidden dialog.
        if (confirm.current?.open) setDeleteProblem((err as ApiError).message);
        else {
          setProblem((err as ApiError).message);
          self.current?.focus();
        }
        return;
      }
    }
    // Closed first: while the modal is open, the rest of the page can't take the focus.
    confirm.current?.close();
    onDeleted();
  };

  const resize = (clientX: number) => {
    const box = body.current?.getBoundingClientRect();
    if (box && box.width > 0) setSplit(clamp(((clientX - box.left) / box.width) * 100));
  };

  return (
    <section ref={self} className="window" aria-label={document.title} tabIndex={-1}>
      <header className="window-header">
        <h2>
          <bdi>{document.title}</bdi>
        </h2>
        <button
          className="delete"
          aria-label={`Delete ${document.title}`}
          title="Delete"
          // Not while a retry is out (its reply would put the document back in the list), nor while a delete is.
          disabled={retrying || deleting}
          onClick={askToDelete}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 4.5h11M6.5 4.5V2.5h3v2M4 4.5l.7 9h6.6l.7-9M6.7 7v4.5M9.3 7v4.5" />
          </svg>
        </button>
        {document.retryable && (
          <button
            className="button small"
            disabled={retrying || deleting}
            onClick={() => void retry()}
          >
            {document.status === 'ready' ? 'Prepare again for the current model' : 'Try again'}
          </button>
        )}
        <button
          className="close"
          aria-label={`Close ${document.title}`}
          title="Close"
          onClick={onClose}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <dialog ref={confirm} className="confirm-dialog" aria-labelledby={questionId}>
        <p id={questionId}>
          Delete <bdi>{document.title}</bdi> and its conversations? This can't be undone.
        </p>
        {deleteProblem && (
          <p className="error" role="alert">
            {deleteProblem}
          </p>
        )}
        <div className="dialog-actions">
          <button
            ref={cancel}
            className="button"
            disabled={deleting}
            onClick={() => confirm.current?.close()}
          >
            Cancel
          </button>
          <button className="button primary" disabled={deleting} onClick={() => void remove()}>
            {deleting ? 'Deleting' : 'Delete'}
          </button>
        </div>
      </dialog>
      {problem && (
        <p className="error window-problem" role="alert">
          {problem}
        </p>
      )}
      <div ref={body} className="window-body" data-dragging={dragging || undefined}>
        <div className="window-document" style={{ flexBasis: `${split}%` }}>
          <DocumentView document={document} highlight={highlight} />
        </div>
        <div
          className="divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Width of the document and the conversation"
          aria-valuemin={MIN_SPLIT}
          aria-valuemax={MAX_SPLIT}
          aria-valuenow={split}
          aria-valuetext={`Document ${split}%`}
          tabIndex={0}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            // No text selection while dragging.
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
          }}
          onPointerMove={(e) => dragging && resize(e.clientX)}
          onPointerUp={() => setDragging(false)}
          onLostPointerCapture={() => setDragging(false)}
          onKeyDown={(e) => {
            const next =
              e.key === 'Home'
                ? MIN_SPLIT
                : e.key === 'End'
                  ? MAX_SPLIT
                  : KEY_STEPS[e.key] !== undefined
                    ? clamp(split + KEY_STEPS[e.key]!)
                    : null;
            if (next === null) return;
            e.preventDefault();
            setSplit(next);
          }}
        />
        <Chat document={document} onQuote={setHighlight} />
      </div>
    </section>
  );
}
