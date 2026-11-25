import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiError, type DocumentContent, type DocumentInfo } from './api';
import type { Highlight } from './App';
import { pieces, toLines, touches, type Line } from './text';

const WAITING: Record<DocumentInfo['status'], string> = {
  queued: 'Waiting to be read.',
  processing: 'Reading the document and indexing it for search.',
  ready: '',
  failed: '',
};

export function DocumentView({
  document,
  highlight,
}: {
  document: DocumentInfo | null;
  highlight: Highlight | null;
}) {
  const [loaded, setLoaded] = useState<{ id: string; content: DocumentContent } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ready = document?.status === 'ready';
  const id = document?.id;

  useEffect(() => {
    if (!id || !ready) return;
    let current = true;
    api
      .content(id)
      .then((content) => {
        if (!current) return;
        setLoaded({ id, content });
        setProblem(null);
      })
      .catch((err: ApiError) => current && setProblem(err.message));
    return () => {
      current = false;
    };
  }, [id, ready]);

  const content = loaded && loaded.id === id ? loaded.content : null;
  const lines = useMemo(
    () => (content ? toLines(content.content, content.format, content.pages) : []),
    [content],
  );

  // The first highlighted line is scrolled to the middle of the pane.
  const first = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    first.current?.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  }, [highlight]);

  const firstLit = highlight ? lines.findIndex((l) => touches(l, highlight)) : -1;
  // Built again only when the text or the highlight changes: the list refresh re-renders this pane every 2 s
  // while any document is being prepared, and a long document has thousands of lines.
  const text = useMemo(
    () =>
      content && (
        <div className="document-text">
          {lines.map((line: Line, i) => {
            const isFirst = i === firstLit;
            return (
              <Fragment key={line.start}>
                {line.page !== undefined && (
                  <div className="page-marker" role="separator" aria-label={`Page ${line.page}`}>
                    Page {line.page}
                  </div>
                )}
                <div
                  ref={isFirst ? first : undefined}
                  className={`line ${line.kind}${line.level ? ` h${line.level}` : ''}`}
                  dir="auto"
                >
                  {pieces(line, highlight).map((p) => {
                    const text = content.content.slice(p.start, p.end);
                    if (p.highlighted) return <mark key={p.start}>{text}</mark>;
                    if (p.marker)
                      return (
                        <span key={p.start} className="marker">
                          {text}
                        </span>
                      );
                    return <Fragment key={p.start}>{text}</Fragment>;
                  })}
                </div>
              </Fragment>
            );
          })}
        </div>
      ),
    [content, lines, highlight, firstLit],
  );

  if (!document) {
    return (
      <main className="pane reader empty">
        <p>Upload a document, or choose one from the list, to read it and ask about it.</p>
      </main>
    );
  }
  return (
    <main className="pane reader" aria-label={document.title}>
      <h1>
        <bdi>{document.title}</bdi>
      </h1>
      {document.status === 'failed' && <p className="error">{document.error?.message}</p>}
      {!ready && document.status !== 'failed' && (
        <p className="muted">{WAITING[document.status]}</p>
      )}
      {problem && <p className="error">{problem}</p>}
      {text}
    </main>
  );
}
