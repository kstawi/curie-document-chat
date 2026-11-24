// Characters a reader can't see, which could carry instructions only the model would read: C0 and C1 controls other
// than tab and line feed, the soft hyphen, zero-width and invisible-operator characters, bidi controls, the byte-order
// mark, and Unicode tag characters (U+E0000 to U+E007F, which can spell out a whole hidden sentence).
const HIDDEN_SOURCE =
  '[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]';
const HIDDEN_ALL = new RegExp(HIDDEN_SOURCE, 'gu');
const HIDDEN_ONE = new RegExp(`^${HIDDEN_SOURCE}$`, 'u');

// Whether the character starting at `i` is hidden; the quote matcher drops exactly what forModel removes.
export function hiddenLengthAt(text: string, i: number): number {
  const cp = text.codePointAt(i)!;
  const ch = String.fromCodePoint(cp);
  return HIDDEN_ONE.test(ch) ? ch.length : 0;
}

// Text on its way to the model. The stored text keeps these characters, so every offset still matches the upload.
export const forModel = (text: string) => text.replace(HIDDEN_ALL, '');

// A question as stored and searched: hidden characters gone, composed Unicode, one line.
export const cleanQuestion = (question: string) =>
  forModel(question).normalize('NFC').replace(/\s+/g, ' ').trim();
