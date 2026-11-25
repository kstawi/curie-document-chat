import { forModel, hiddenLengthAt, isBlank, WHITESPACE } from './clean.js';
import type { PageSpan, Quote } from '../db.js';
import { sectionAt, type Section } from './chunk.js';

export interface Range {
  start: number;
  end: number;
}

// Shorter quotes are dropped: a two-word fragment would make almost any answer look supported.
export const MIN_QUOTE_CHARS = 20;

const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032]/;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033]/;
const DASHES = /[\u2010-\u2015\u2212]/;
// Markdown emphasis and code marks, and the zero-width joiners, which a model may leave out of a quote. Dropping
// the joiners here only (forModel keeps them) still agrees with forModel: they go on both sides of the match.
const MARKS = /[*_`\u200C\u200D]/;

const HYPHENS = /[-‐‑]/;
const LETTER = /\p{L}/u;
const SPACE_OR_TAB = /[ \t]/;

// After a hyphen that follows a letter: where the next letter starts if the hyphen joins two parts of a word (a
// letter straight after it, or one on the next line), else -1. Hidden characters and emphasis marks are skipped as
// normalise() skips them, so the text and its copy for the model agree.
function joinedAt(text: string, i: number, to: number): number {
  const skip = (j: number, spaces: boolean) => {
    for (;;) {
      if (j >= to) return j;
      const hidden = hiddenLengthAt(text, j);
      if (hidden) j += hidden;
      else if (MARKS.test(text[j]!) || (spaces && SPACE_OR_TAB.test(text[j]!))) j++;
      else return j;
    }
  };
  const letterAt = (j: number) => j < to && LETTER.test(String.fromCodePoint(text.codePointAt(j)!));
  let j = skip(i, false);
  if (letterAt(j)) return j;
  j = skip(i, true);
  if (text[j] !== '\n' || j >= to) return -1;
  j = skip(j + 1, true);
  return letterAt(j) ? j : -1;
}

// The model may change quote and dash styles, spacing or emphasis marks when it copies a passage, and text from a
// PDF has ligatures and words hyphenated at line ends. Both sides of a match go through this:
// - each character is decomposed on its own (NFKD), so a ligature becomes its letters, a full-width or styled letter
//   a plain one, and an accented letter reads the same whether it was stored composed or not;
// - a hyphen between letters is dropped, with the line break after it, so "exam-\nple" matches "example" and
//   "well-\nknown" matches "well-known" (both read "wellknown").
// Every character of the result maps back to the stored character it came from, so a match maps straight back.
export function normalise(
  text: string,
  from = 0,
  to = text.length,
): { text: string; map: number[] } {
  let out = '';
  const map: number[] = [];
  let afterSpace = true;
  for (let i = from; i < to; i++) {
    // Hidden characters first: the byte-order mark (U+FEFF) would otherwise count as whitespace.
    const hidden = hiddenLengthAt(text, i);
    if (hidden) {
      i += hidden - 1;
      continue;
    }
    const at = i;
    let c = String.fromCodePoint(text.codePointAt(i)!);
    i += c.length - 1;
    if (MARKS.test(c)) continue;
    if (WHITESPACE.test(c)) {
      if (afterSpace) continue;
      out += ' ';
      map.push(at);
      afterSpace = true;
      continue;
    }
    if (HYPHENS.test(c) && LETTER.test(out.at(-1) ?? '')) {
      const next = joinedAt(text, i + 1, to);
      if (next >= 0) {
        i = next - 1;
        continue;
      }
    }
    afterSpace = false;
    if (SINGLE_QUOTES.test(c)) c = "'";
    else if (DOUBLE_QUOTES.test(c)) c = '"';
    else if (DASHES.test(c)) c = '-';
    const plain = c.normalize('NFKD');
    out += plain;
    for (let k = 0; k < plain.length; k++) map.push(at);
  }
  if (out.endsWith(' ')) {
    out = out.slice(0, -1);
    map.pop();
  }
  return { text: out, map };
}

// Ranges in document order, with neighbours joined when only whitespace separates them, so a quote may cross the
// boundary between two passages that were sent next to each other.
export function mergeRanges(content: string, ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged.at(-1);
    // An overlapping range gives an empty slice, so it merges too.
    if (last && isBlank(content.slice(last.end, r.start))) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

export interface QuoteCheck {
  verified: Quote[];
  rejected: { text: string; reason: 'too_short' | 'not_found' }[];
}

const pageAt = (pages: PageSpan[], offset: number) =>
  pages.findLast((p) => p.start <= offset)?.page ?? pages[0]?.page ?? 1;

// Accepts a quote only if it appears in the passages sent to the model for this answer. When the text repeats, the
// first match in document order wins. For a PDF, `pages` gives each quote the pages it starts and ends on.
export function verifyQuotes(
  content: string,
  quotes: string[],
  sent: Range[],
  sections: Section[],
  pages?: PageSpan[] | null,
): QuoteCheck {
  const ranges = mergeRanges(content, sent).map((r) => ({
    ...r,
    ...normalise(content, r.start, r.end),
  }));
  const result: QuoteCheck = { verified: [], rejected: [] };
  for (const quote of quotes) {
    const needle = normalise(quote).text;
    if (needle.length < MIN_QUOTE_CHARS) {
      result.rejected.push({ text: quote, reason: 'too_short' });
      continue;
    }
    let found: Quote | null = null;
    for (const range of ranges) {
      const at = range.text.indexOf(needle);
      if (at < 0) continue;
      const start = range.map[at]!;
      // Past the whole stored character the match ends in, which may be a surrogate pair or a ligature.
      const last = range.map[at + needle.length - 1]!;
      const end = last + String.fromCodePoint(content.codePointAt(last)!).length;
      // Headings come from the stored text, so the label is cleaned like the quote's text.
      const section = forModel(sectionAt(sections, start));
      const line = content.slice(0, start).split('\n').length;
      // The text as the model read it, so no hidden character (an unclosed direction override, say) reaches a
      // reader; the offsets still cover the stored text exactly.
      found = { text: forModel(content.slice(start, end)), start, end, line, section };
      if (pages?.length) {
        const startPage = pageAt(pages, start);
        const endPage = pageAt(pages, end - 1);
        found.startPage = startPage;
        found.endPage = endPage;
        if (endPage !== startPage) found.section = `pages ${startPage}–${endPage}`;
      }
      break;
    }
    if (!found) result.rejected.push({ text: quote, reason: 'not_found' });
    else if (!result.verified.some((q) => q.start === found.start && q.end === found.end)) {
      result.verified.push(found);
    }
  }
  return result;
}
