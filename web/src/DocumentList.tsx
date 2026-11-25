import type { Ref } from 'react';
import type { DocumentInfo } from './api';

const STATUS: Record<DocumentInfo['status'], string> = {
  queued: 'Waiting',
  processing: 'Reading',
  ready: 'Ready',
  failed: 'Failed',
};

// The sidebar: the documents to open, then the upload button, in a section of its own at the bottom.
export function DocumentList({
  documents,
  open,
  notice,
  listError,
  uploadLabel,
  uploadFailed,
  listRef,
  onSelect,
  onUpload,
}: {
  documents: DocumentInfo[];
  open: string[];
  notice: string;
  listError: string | null;
  uploadLabel: string;
  uploadFailed: boolean;
  listRef: Ref<HTMLElement>;
  onSelect: (id: string) => void;
  onUpload: () => void;
}) {
  return (
    <nav ref={listRef} className="sidebar" aria-label="Documents">
      {/* Above the list rather than in it, so scrolling never hides it and it never covers an item. Mounted from the
          start, so screen readers announce it when it appears. */}
      <p className="notice" role="status">
        {notice}
      </p>
      <div className="sidebar-list">
        {listError && (
          <p className="error" role="alert">
            {listError}
          </p>
        )}
        <ul>
          {documents.map((d) => {
            const isOpen = open.includes(d.id);
            return (
              <li key={d.id}>
                <button
                  className={`document${isOpen ? ' open' : ''}`}
                  data-id={d.id}
                  onClick={() => onSelect(d.id)}
                >
                  <bdi className="title">{d.title}</bdi>
                  <span className={`status ${d.status}`}>{STATUS[d.status]}</span>
                  {isOpen && <span className="visually-hidden">, open</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <section className="sidebar-upload" aria-label="Upload">
        <button className={`button primary${uploadFailed ? ' failed' : ''}`} onClick={onUpload}>
          {uploadLabel}
        </button>
      </section>
    </nav>
  );
}
