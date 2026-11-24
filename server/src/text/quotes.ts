import { hiddenLengthAt } from './clean.js';
import type { Quote } from '../db.js';
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
// Soft hyphen, zero-width characters, byte-order mark, and Markdown emphasis and code marks.
// Markdown emphasis and code marks, which a model may leave out of a quote.
const MARKS = /[*_`]/;

// The model may change quote and dash styles, spacing or emphasis marks when it copies a passage. Each character
// here maps to one character or to none, so a match in the normalised text maps straight back to the original.
export function normalise(
  text: string,
  from = 0,
  to = text.length,
): { text: string; map: number[] } {
  let out = '';
  const map: number[] = [];
  let afterSpace = true;
  for (let i = from; i < to; i++) {
    // Hidden characters first: some (form feed, vertical tab) would otherwise count as whitespace.
    const hidden = hiddenLengthAt(text, i);
    if (hidden) {
      i += hidden - 1;
      continue;
    }
    let c = text[i]!;
    if (MARKS.test(c)) continue;
    if (/\s/.test(c)) {
      if (afterSpace) continue;
      c = ' ';
      afterSpace = true;
    } else {
      afterSpace = false;
      if (SINGLE_QUOTES.test(c)) c = "'";
      else if (DOUBLE_QUOTES.test(c)) c = '"';
      else if (DASHES.test(c)) c = '-';
    }
    out += c;
    map.push(i);
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
    if (last && content.slice(last.end, r.start).trim() === '') {
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

// Accepts a quote only if it appears in the passages sent to the model for this answer. When the text repeats, the
// first match in document order wins.
export function verifyQuotes(
  content: string,
  quotes: string[],
  sent: Range[],
  sections: Section[],
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
      const end = range.map[at + needle.length - 1]! + 1;
      const section = sectionAt(sections, start);
      const line = content.slice(0, start).split('\n').length;
      found = { text: content.slice(start, end), start, end, line, section };
      break;
    }
    if (!found) result.rejected.push({ text: quote, reason: 'not_found' });
    else if (!result.verified.some((q) => q.start === found.start && q.end === found.end)) {
      result.verified.push(found);
    }
  }
  return result;
}
