import { useEffect, useRef, useState } from 'react';
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
  onChanged,
}: {
  document: DocumentInfo;
  pointed: number;
  onClose: () => void;
  onChanged: (doc: DocumentInfo) => void;
}) {
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const [split, setSplit] = useState(50);
  const [dragging, setDragging] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const self = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);

  // Pointed to from the list: outlined for a moment, with the focus moved here.
  useEffect(() => {
    const el = self.current;
    if (!pointed || !el) return;
    el.focus();
    el.dataset.pointed = '';
    const timer = setTimeout(() => delete el.dataset.pointed, 1_200);
    return () => {
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
        {document.retryable && (
          <button className="button small" disabled={retrying} onClick={() => void retry()}>
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
