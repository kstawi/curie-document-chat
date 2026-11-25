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
// Holds the document list back when a test needs it to arrive late.
let listGate: Promise<void> = Promise.resolve();
// Every document's conversations, and the renames asked for.
let conversations: { id: string; createdAt: string; title: string | null }[] = [];
let renames: string[] = [];

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/documents' && init?.method === 'POST') return uploadReply.promise;
      if (url.startsWith('/api/documents?')) {
        await listGate;
        return reply({ items: docs });
      }
      if (url.endsWith('/content')) {
        return reply({ content: 'Some text.', format: 'text', pages: null });
      }
      if (init?.method === 'PATCH') {
        const title = (JSON.parse(init.body as string) as { title: string }).title;
        renames.push(title);
        conversations = conversations.map((c) => ({ ...c, title }));
        return reply(conversations[0]);
      }
      if (url.endsWith('/conversations')) return reply({ items: conversations });
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
it('fits an upload that finishes after four windows were opened around them, leaving the focus alone', async () => {
  await click(container.querySelector('.sidebar-upload button'));
  await choose(note());
  await click(container.querySelector('dialog [aria-label="Close"]'));
  for (const n of [1, 2, 3, 4]) await click(inList(n));
  (inList(2) as HTMLElement).focus();
  await settleUpload(reply(doc(6)));
  await nextFrame();
  expect(windows()).toEqual(['Document 1', 'Document 2', 'Document 3', 'Document 4']);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Close one');
  expect(inList(6)).toBeTruthy();
  expect(document.activeElement).toBe(inList(2));
});

it('keeps the windows opened while an upload chosen before the list arrived went up', async () => {
  act(() => root.unmount());
  let release!: () => void;
  listGate = new Promise((r) => (release = r));
  root = createRoot(container);
  await act(async () => root.render(<App />));
  await click(container.querySelector('main button'));
  await choose(note());
  await click(container.querySelector('dialog [aria-label="Close"]'));
  await act(async () => release());
  await click(inList(1));
  await click(inList(2));
  await settleUpload(reply(doc(6)));
  expect(windows()).toEqual(['Document 1', 'Document 2', 'Document 6']);
  listGate = Promise.resolve();
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

it('marks the upload button when an upload fails after its dialog was closed, and shows why when opened', async () => {
  const dialog = container.querySelector('dialog');
  const button = () => container.querySelector('.sidebar-upload button');
  await click(button());
  await choose(note());
  await click(dialog?.querySelector('[aria-label="Close"]'));
  await settleUpload(
    new Response(JSON.stringify({ error: 'unsupported_type', message: 'Not a text file.' }), {
      status: 415,
    }),
  );
  expect(dialog?.open).toBe(false);
  expect(button()?.textContent).toBe('Upload failed: see why');

  await click(button());
  expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe('Not a text file.');
  await click(dialog?.querySelector('[aria-label="Close"]'));
  expect(button()?.textContent).toBe('Upload a document');
});

it('shows a conversation by its name and date, and renames it with Enter but not Escape', async () => {
  conversations = [
    {
      id: '10000000-0000-4000-8000-000000000001',
      createdAt: '2026-11-25T10:00:00.000Z',
      title: 'Who owned the pilot?',
    },
  ];
  renames = [];
  await click(inList(1));
  const header = () => container.querySelector('section.window .chat-header')!;
  expect(header().querySelector('option')?.textContent).toMatch(/^Who owned the pilot\? \(.+\)$/);

  const type = async (text: string, key: string) => {
    await click([...header().querySelectorAll('button')].find((b) => b.textContent === 'Rename'));
    const box = header().querySelector('input')!;
    expect(document.activeElement).toBe(box);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => box.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
  };

  await type('Pilot owner', 'Enter');
  expect(renames).toEqual(['Pilot owner']);
  expect(header().querySelector('input')).toBeNull();
  expect(header().querySelector('option')?.textContent).toMatch(/^Pilot owner \(/);

  await type('Something else', 'Escape');
  expect(renames).toEqual(['Pilot owner']);
  expect(header().querySelector('option')?.textContent).toMatch(/^Pilot owner \(/);
  expect(document.activeElement?.textContent).toBe('Rename');
  conversations = [];
});
