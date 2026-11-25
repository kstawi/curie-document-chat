// Characters a reader can't see, which could carry instructions only the model would read: every control character
// and every character Unicode marks as ignorable by default (zero-width and direction characters, invisible
// operators, fillers, the byte-order mark, tag characters that can spell out a whole hidden sentence, variation
// selectors that can carry a byte each). Kept on purpose:
// - whitespace controls (tab, line feed, vertical tab, form feed, carriage return, next line), which separate words;
// - the zero-width joiner and non-joiner, which Persian words and joined emoji need and which can't spell anything;
// - the two variation selectors that draw a character as text (U+FE0E) or as an emoji (U+FE0F). The other
//   selectors go, since a run of them after one letter is invisible and could spell out bytes.
// Lost: the England, Scotland and Wales flags, built from tag characters, show as a plain black flag, since a hidden
// sentence could be dressed up as a flag.
const HIDDEN_SOURCE =
  '[[\\p{Cc}\\p{Default_Ignorable_Code_Point}]--[\\t\\n\\v\\f\\r\u0085\u200C\u200D\uFE0E\uFE0F]]';
// The joiners and selectors in the kept list stand for themselves, one by one, not as parts of a combined character.
// eslint-disable-next-line no-misleading-character-class
const HIDDEN_ALL = new RegExp(HIDDEN_SOURCE, 'gv');
// eslint-disable-next-line no-misleading-character-class
const HIDDEN_ONE = new RegExp(`^${HIDDEN_SOURCE}$`, 'v');

// Whether the character starting at `i` is hidden; the quote matcher drops exactly what forModel removes.
export function hiddenLengthAt(text: string, i: number): number {
  const cp = text.codePointAt(i)!;
  const ch = String.fromCodePoint(cp);
  return HIDDEN_ONE.test(ch) ? ch.length : 0;
}

// Text on its way to the model. The stored text keeps these characters, so every offset still matches the upload.
export const forModel = (text: string) => text.replace(HIDDEN_ALL, '');

// Runs of whitespace as one space: what /\s/ matches, plus next line (U+0085), which it misses.
export const WHITESPACE = /[\s\u0085]/;
export const oneLine = (text: string) => text.replace(/[\s\u0085]+/g, ' ').trim();
// Nothing a reader can see: only whitespace and hidden characters. (`trim` keeps next line.)
export const isBlank = (text: string) => !/[^\s\u0085]/.test(forModel(text));

// A question as stored and searched: hidden characters gone, composed Unicode, one line.
export const cleanQuestion = (question: string) => oneLine(forModel(question).normalize('NFC'));
