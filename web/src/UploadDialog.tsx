import { useEffect, useId, useRef, useState } from 'react';

// The upload: the limits, a file picker and a drop area, and the reason when a file is refused.
export function UploadDialog({
  open,
  busy,
  error,
  onFile,
  onClose,
}: {
  open: boolean;
  busy: boolean;
  error: string | null;
  onFile: (file: File) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [over, setOver] = useState(false);
  const titleId = useId();

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const take = (files: FileList | null | undefined) => {
    const file = files?.[0];
    if (file && !busy) onFile(file);
  };

  return (
    <dialog ref={dialog} className="upload-dialog" aria-labelledby={titleId} onClose={onClose}>
      <header className="dialog-header">
        <h2 id={titleId}>Upload a document</h2>
        <button className="close" aria-label="Close" title="Close" onClick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <p className="muted">
        Markdown or text up to 1 MB, PDF up to 5 MB and 100 pages. One file at a time.
      </p>
      <div
        className="drop"
        data-over={over || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files);
        }}
      >
        <p>{busy ? 'Uploading' : 'Drop a file here, or'}</p>
        <label className="upload">
          <span className="button primary">Choose a file</span>
          <input
            type="file"
            accept=".md,.markdown,.txt,.pdf,text/markdown,text/plain,application/pdf"
            disabled={busy}
            onChange={(e) => {
              take(e.target.files);
              e.target.value = '';
            }}
          />
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
