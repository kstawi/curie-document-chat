// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DocumentInfo } from '../src/api';
import { App } from '../src/App';

const doc = (n: number): DocumentInfo => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  title: `Document ${n}`,
  format: 'text',
  status: 'ready',
  error: null,
  retryable: false,
  createdAt: '2026-11-25T10:00:00.000Z',
});
const docs = [1, 2, 3, 4, 5].map(doc);

const reply = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

let root: Root;
let container: HTMLDivElement;
// The reply to the next upload, settled by the test.
let uploadReply: { promise: Promise<Response>; settle: (r: Response) => void };

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/documents' && init?.method === 'POST') return uploadReply.promise;
      if (url.startsWith('/api/documents?')) return reply({ items: docs });
      if (url.endsWith('/content')) {
        return reply({ content: 'Some text.', format: 'text', pages: null });
      }
      return reply({ items: [] });
    }),
  );
  window.matchMedia = () => ({ matches: false }) as MediaQueryList;
  Element.prototype.scrollIntoView = () => {};
  // jsdom has no modal dialogs; these do what the browser's do to the open attribute and the close event.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
  let settle!: (r: Response) => void;
  uploadReply = { promise: new Promise((r) => (settle = r)), settle };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};
const inList = (n: number) =>
  [...container.querySelectorAll('nav button')].find((b) =>
    b.textContent?.includes(`Document ${n}`),
  );
const windows = () => [...container.querySelectorAll('section.window')].map((w) => w.ariaLabel);
// The window's focus moves a frame later, after the upload dialog has handed it back.
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
const split = (title: string) =>
  container
    .querySelector(`section.window[aria-label="${title}"] [role="separator"]`)
    ?.getAttribute('aria-valuenow');
const choose = async (file: File) => {
  const input = container.querySelector<HTMLInputElement>('dialog input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
};
const settleUpload = (response: Response) =>
  act(async () => {
    uploadReply.settle(response);
    await uploadReply.promise;
  });
const note = () => new File(['# A note\n'], 'note.md', { type: 'text/markdown' });

// Before, the document pane and the chat shared a key, so every switch left the old pane on the page.
it('keeps one document pane per open window while documents are opened, pointed to and closed', async () => {
  expect(container.querySelector('main')?.textContent).toContain('Upload a document');
  await click(inList(1));
  await click(inList(2));
  await click(inList(1));
  await nextFrame();
  expect(windows()).toEqual(['Document 1', 'Document 2']);
  expect(container.querySelectorAll('.reader')).toHaveLength(2);
  expect(document.activeElement?.ariaLabel).toBe('Document 1');

  await click(container.querySelector('[aria-label="Close Document 2"]'));
  expect(windows()).toEqual(['Document 1']);
  expect(container.querySelectorAll('.reader')).toHaveLength(1);
  expect(document.activeElement).toBe(inList(2));
});

it('opens at most four documents, and says to close one first', async () => {
  for (const n of [1, 2, 3, 4, 5]) await click(inList(n));
  expect(windows()).toEqual(['Document 1', 'Document 2', 'Document 3', 'Document 4']);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Close one');

  await click(container.querySelector('[aria-label="Close Document 3"]'));
  await click(inList(5));
  expect(windows()).toEqual(['Document 1', 'Document 2', 'Document 4', 'Document 5']);
});

it('opens the upload dialog, with the limits, from the upload button', async () => {
  const dialog = container.querySelector('dialog');
  expect(dialog?.open).toBe(false);
  await click(container.querySelector('.sidebar-upload button'));
  expect(dialog?.open).toBe(true);
  expect(dialog?.textContent).toContain('PDF up to 5 MB and 100 pages');
  await click(dialog?.querySelector('[aria-label="Close"]'));
  expect(dialog?.open).toBe(false);
});

// Windows keyed by position would hand a closed window's state to the next one.
it('keeps the split of each window when another closes, and starts a reopened one afresh', async () => {
  await click(inList(1));
  await click(inList(2));
  const divider = container.querySelector(
    'section.window[aria-label="Document 2"] [role="separator"]',
  )!;
  await act(async () =>
    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
  );
  expect([split('Document 1'), split('Document 2')]).toEqual(['50', '55']);

  await click(container.querySelector('[aria-label="Close Document 1"]'));
  expect(split('Document 2')).toBe('55');
  await click(inList(1));
  expect([split('Document 2'), split('Document 1')]).toEqual(['55', '50']);
});

// The upload finishes after windows were opened meanwhile; it must see them, not those open when it started.
it('fits an upload that finishes after four windows were opened around the documents open by then', async () => {
  await click(container.querySelector('.sidebar-upload button'));
  await choose(note());
  for (const n of [1, 2, 3, 4]) await click(inList(n));
  await settleUpload(reply(doc(6)));
  expect(windows()).toEqual(['Document 1', 'Document 2', 'Document 3', 'Document 4']);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Close one');
  expect(inList(6)).toBeTruthy();
});

it('opens an upload in a window with the focus, from the empty page', async () => {
  await click(container.querySelector('main button'));
  await choose(note());
  await settleUpload(reply(doc(6)));
  await nextFrame();
  expect(container.querySelector('dialog')?.open).toBe(false);
  expect(windows()).toEqual(['Document 6']);
  expect(document.activeElement?.ariaLabel).toBe('Document 6');
});

it('opens the dialog again with the reason when an upload it was closed on fails', async () => {
  const dialog = container.querySelector('dialog');
  await click(container.querySelector('.sidebar-upload button'));
  await choose(note());
  await click(dialog?.querySelector('[aria-label="Close"]'));
  expect(dialog?.open).toBe(false);
  await settleUpload(
    new Response(JSON.stringify({ error: 'unsupported_type', message: 'Not a text file.' }), {
      status: 415,
    }),
  );
  expect(dialog?.open).toBe(true);
  expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe('Not a text file.');
});
