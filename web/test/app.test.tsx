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
// Holds a rename's reply back when a test needs it to arrive late.
let renameGate: Promise<void> = Promise.resolve();
// Questions stay pending, to be followed; renames and reads of the names fail, as with the server out of reach.
let pendingAnswers = false;
let failNames = false;

const answerMessage = (conversationId: string, status: 'pending' | 'completed') => ({
  id: '20000000-0000-4000-8000-000000000001',
  conversationId,
  sequence: 1,
  question: 'Who owned the pilot?',
  status,
  stage: null,
  outcome: status === 'completed' ? 'not_in_document' : null,
  answer: null,
  note: status === 'completed' ? 'Not covered.' : null,
  quotes: [],
  error: null,
  model: 'fake',
  createdAt: '2026-11-25T10:00:00.000Z',
  updatedAt: '2026-11-25T10:00:00.000Z',
});

// jsdom has no event streams; this one records each and lets a test send its events.
class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, (e: MessageEvent<string>) => void>();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

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
      const outOfReach = () =>
        new Response(
          JSON.stringify({ error: 'unavailable', message: 'The server could not be reached.' }),
          { status: 503 },
        );
      if (init?.method === 'PATCH') {
        await renameGate;
        if (failNames) return outOfReach();
        const id = url.split('/')[3];
        const title = (JSON.parse(init.body as string) as { title: string }).title;
        renames.push(title);
        conversations = conversations.map((c) => (c.id === id ? { ...c, title } : c));
        return reply(conversations.find((c) => c.id === id));
      }
      if (url.endsWith('/conversations')) {
        return failNames ? outOfReach() : reply({ items: conversations });
      }
      if (url.endsWith('/messages') && init?.method === 'POST') {
        return reply(answerMessage(url.split('/')[3]!, pendingAnswers ? 'pending' : 'completed'));
      }
      return reply({ items: [] });
    }),
  );
  window.matchMedia = () => ({ matches: false }) as MediaQueryList;
  // jsdom's page never has the focus; a browser's does while it is in use.
  document.hasFocus = () => true;
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
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
  conversations = [];
  renames = [];
  pendingAnswers = false;
  failNames = false;
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

const CONVERSATION = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const conversation = (id: string, title: string | null) => ({
  id,
  createdAt: '2026-11-25T10:00:00.000Z',
  title,
});
const isolated = (name: string) =>
  `${String.fromCharCode(0x2068)}${name}${String.fromCharCode(0x2069)} (`;
const header = () => container.querySelector('section.window .chat-header')!;
const menuShows = () => header().querySelector('select')?.selectedOptions[0]?.textContent ?? '';
const box = () => header().querySelector('input');
const renameButton = () =>
  [...header().querySelectorAll('button')].find((b) => b.textContent === 'Rename')!;
const openBox = async () => {
  await click(renameButton());
  expect(document.activeElement).toBe(box());
};
const typeIn = (text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box(), text);
    box()!.dispatchEvent(new Event('input', { bubbles: true }));
  });
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(async () =>
    box()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init })),
  );
const clickAway = () => act(async () => (inList(2) as HTMLElement).focus());
const showConversations = async (...list: ReturnType<typeof conversation>[]) => {
  conversations = list;
  await click(inList(1));
};
const askQuestion = async (text: string) => {
  const textarea = container.querySelector('section.window textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      text,
    );
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(container.querySelector('section.window form.ask button.primary'));
};

it('shows a conversation by its name and a date, and saves a rename on Enter or clicking away', async () => {
  await showConversations(conversation(CONVERSATION, 'Who owned the pilot?'));
  expect(menuShows().startsWith(isolated('Who owned the pilot?'))).toBe(true);

  await openBox();
  await typeIn('Pilot owner');
  await press('Enter');
  expect(renames).toEqual(['Pilot owner']);
  expect(box()).toBeNull();
  expect(document.activeElement).toBe(renameButton());
  expect(menuShows().startsWith(isolated('Pilot owner'))).toBe(true);

  await openBox();
  await typeIn('Pilot ownership');
  await clickAway();
  expect(renames).toEqual(['Pilot owner', 'Pilot ownership']);
});

it('sends nothing for Escape, an empty box or an untouched one, and waits while another window has the focus', async () => {
  await showConversations(conversation(CONVERSATION, 'Pilot'));

  await openBox();
  await typeIn('Not this');
  await press('Escape');
  expect(box()).toBeNull();
  expect(document.activeElement).toBe(renameButton());

  // Escape while an input method is composing belongs to the input method.
  await openBox();
  await typeIn('Nor this');
  await press('Escape', { isComposing: true });
  expect(box()).not.toBeNull();
  await press('Escape');

  await openBox();
  await typeIn('   ');
  await clickAway();

  await openBox();
  await clickAway();

  // Switching to another window takes the focus from the box without it being a choice: it stays open.
  await openBox();
  await typeIn('Half typed');
  document.hasFocus = () => false;
  await clickAway();
  expect(box()?.value).toBe('Half typed');
  document.hasFocus = () => true;
  await act(async () => box()!.focus());
  await press('Escape');

  expect(renames).toEqual([]);
  expect(menuShows().startsWith(isolated('Pilot'))).toBe(true);
});

// Compared with the name the box opened with, not the name now: the model's may have arrived meanwhile.
it("keeps the model's name when it arrives while an untouched rename box is open", async () => {
  await showConversations(conversation(CONVERSATION, 'Who owned the pilot?'));
  pendingAnswers = true;
  await askQuestion('Who owned the pilot?');
  expect(FakeEventSource.instances).toHaveLength(1);

  await openBox();
  conversations = [conversation(CONVERSATION, 'Named by the model')];
  await act(async () =>
    FakeEventSource.instances[0]!.emit('final', answerMessage(CONVERSATION, 'completed')),
  );
  expect(box()?.value).toBe('Who owned the pilot?');
  await clickAway();
  expect(renames).toEqual([]);
  expect(menuShows().startsWith(isolated('Named by the model'))).toBe(true);
});

it('reopens on the new name when Rename is pressed while a rename is saving', async () => {
  await showConversations(conversation(CONVERSATION, 'Pilot'));
  await openBox();
  await typeIn('Pilot lead');
  let release!: () => void;
  renameGate = new Promise((r) => (release = r));
  // The button takes the focus as it is pressed, so the box saves, then the click opens it again.
  await act(async () => renameButton().focus());
  await click(renameButton());
  expect(box()?.value).toBe('Pilot lead');
  await act(async () => {
    release();
    await renameGate;
  });
  renameGate = Promise.resolve();
  await clickAway();
  expect(renames).toEqual(['Pilot lead']);
});

it('puts the name back when a rename fails with the server out of reach', async () => {
  await showConversations(conversation(CONVERSATION, 'Pilot'));
  failNames = true;
  await openBox();
  await typeIn('Unsaved name');
  await press('Enter');
  expect(menuShows().startsWith(isolated('Pilot'))).toBe(true);
  expect(container.querySelector('section.window [role="alert"]')?.textContent).toBe(
    'The server could not be reached.',
  );
});

it('reads the names again after a question is sent, when the menu gets the focus, and on a switch', async () => {
  await showConversations(conversation(CONVERSATION, 'Before'), conversation(OTHER, 'Other'));
  expect(menuShows().startsWith(isolated('Before'))).toBe(true);

  conversations = [conversation(CONVERSATION, 'After sending'), conversation(OTHER, 'Other')];
  await askQuestion('Who owned the pilot?');
  expect(menuShows().startsWith(isolated('After sending'))).toBe(true);

  conversations = [conversation(CONVERSATION, 'After focus'), conversation(OTHER, 'Other')];
  await act(async () => header().querySelector('select')!.focus());
  expect(menuShows().startsWith(isolated('After focus'))).toBe(true);

  const choose = (id: string) =>
    act(async () => {
      const select = header().querySelector('select')!;
      select.value = id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  await choose(OTHER);
  conversations = [conversation(CONVERSATION, 'After switching'), conversation(OTHER, 'Other')];
  await choose(CONVERSATION);
  expect(menuShows().startsWith(isolated('After switching'))).toBe(true);
});

it('changes the words every few seconds while the model writes, and tells screen readers the stage once', async () => {
  await showConversations(conversation(CONVERSATION, 'Pilot'));
  pendingAnswers = true;
  await askQuestion('Who owned the pilot?');
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const stage = (name: string) =>
    act(async () =>
      FakeEventSource.instances[0]!.emit('progress', {
        ...answerMessage(CONVERSATION, 'pending'),
        stage: name,
      }),
    );
  const shown = () => container.querySelector('section.window .stage')?.textContent;
  const looping = () => container.querySelector('section.window .thinking')?.textContent;

  await stage('naming');
  expect(shown()).toBe('Naming the conversation');
  await stage('writing');
  expect(looping()).toBe('Thinking…');
  await act(async () => vi.advanceTimersByTime(2500));
  expect(looping()).toBe('Reading the passages…');
  expect(container.querySelector('section.window [role="status"]')?.textContent).toBe(
    'Writing the answer',
  );
  await stage('checking');
  expect(looping()).toBeUndefined();
  expect(shown()).toBe('Checking quotes against the text');
});
