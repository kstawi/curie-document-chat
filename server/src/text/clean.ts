// Characters a reader can't see, which could carry instructions only the model would read: C0 and C1 controls other
// than whitespace (tab, line feed, vertical tab, form feed, carriage return), the soft hyphen, the zero-width space,
// direction marks and controls, invisible operators, the byte-order mark, Hangul fillers, Unicode tag characters
// (U+E0000 to U+E007F, which can spell out a whole hidden sentence) and the supplementary variation selectors (which can
// carry a byte each). Kept: the zero-width joiner and non-joiner, which Persian words and joined emoji need and which
// can't spell anything on their own. Lost: the England, Scotland and Wales flags, built from tag characters, show as a
// plain black flag, since a hidden sentence could be dressed up as a flag.
const HIDDEN_SOURCE =
  '[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]';
// The variation selectors are matched one by one, on purpose, not as part of a combined character.
// eslint-disable-next-line no-misleading-character-class
const HIDDEN_ALL = new RegExp(HIDDEN_SOURCE, 'gu');
// eslint-disable-next-line no-misleading-character-class
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
