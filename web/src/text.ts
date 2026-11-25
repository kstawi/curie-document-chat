// The stored text as lines to render. Nothing is removed or rewritten: every line is an exact slice of the stored
// text, so the offsets of a quote point straight at what is on screen. Markdown is shown as styled lines, its marker
// characters kept but dimmed.

export type LineKind = 'text' | 'blank' | 'heading' | 'quote' | 'list' | 'fence' | 'code';

export interface Line {
  start: number;
  end: number;
  kind: LineKind;
  // Heading level, 1 to 6.
  level?: number;
  // Where the dimmed marker ends ("## ", "> ", "- "), as an offset into the text.
  markerEnd?: number;
  // PDFs: the page this line starts, if it is the first line of one.
  page?: number;
}

export interface PageSpan {
  page: number;
  start: number;
  end: number;
}

// The same rules as the server's chunker (server/src/text/chunk.ts), so a line shown as a heading is one the search
// treats as a heading too.
const MAX_HEADING_CHARS = 200;
// The server also drops closing hashes from a heading's title; whether a line is a heading never depends on them.
const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const QUOTE = /^[ \t]*>[ \t]?/;
const LIST = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;

export function toLines(content: string, format: string, pages: PageSpan[] | null): Line[] {
  const markdown = format === 'markdown';
  const pageStarts = new Map((pages ?? []).map((p) => [p.start, p.page]));
  const lines: Line[] = [];
  let inFence = false;
  let start = 0;
  for (const text of content.split('\n')) {
    const end = start + text.length;
    const line: Line = { start, end, kind: text.trim() === '' ? 'blank' : 'text' };
    if (markdown) {
      if (FENCE.test(text)) {
        inFence = !inFence;
        line.kind = 'fence';
      } else if (inFence) {
        line.kind = 'code';
      } else {
        const heading = text.length <= MAX_HEADING_CHARS ? HEADING.exec(text) : null;
        const quote = QUOTE.exec(text);
        const list = LIST.exec(text);
        if (heading && heading[2]!.trim()) {
          line.kind = 'heading';
          line.level = heading[1]!.length;
          line.markerEnd = start + text.length - heading[2]!.length;
        } else if (quote) {
          line.kind = 'quote';
          line.markerEnd = start + quote[0].length;
        } else if (list) {
          line.kind = 'list';
          line.markerEnd = start + list[0].length;
        }
      }
    }
    const page = pageStarts.get(start);
    if (page !== undefined) line.page = page;
    lines.push(line);
    start = end + 1;
  }
  return lines;
}

export interface Piece {
  start: number;
  end: number;
  marker: boolean;
  highlighted: boolean;
}

// A line cut where its marker ends and where a highlighted range starts and ends. Empty pieces are left out; the
// pieces together cover the line exactly.
export function pieces(line: Line, highlight: { start: number; end: number } | null): Piece[] {
  const cuts = new Set([line.start, line.end]);
  if (line.markerEnd !== undefined) cuts.add(line.markerEnd);
  if (highlight) {
    for (const at of [highlight.start, highlight.end]) {
      if (at > line.start && at < line.end) cuts.add(at);
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: Piece[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i]!;
    const end = sorted[i + 1]!;
    out.push({
      start,
      end,
      marker: line.markerEnd !== undefined && end <= line.markerEnd,
      highlighted: highlight !== null && start >= highlight.start && end <= highlight.end,
    });
  }
  return out;
}

// Whether a line holds any of the highlighted range, including the line break after it.
export const touches = (line: Line, highlight: { start: number; end: number } | null) =>
  highlight !== null && highlight.start <= line.end && highlight.end > line.start;
