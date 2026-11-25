import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import { MAX_PAGES } from './limits.js';

export type PdfFailure =
  'pdf_encrypted' | 'pdf_no_text' | 'pdf_too_many_pages' | 'pdf_parse_failed';
export type PdfResult = { pages: string[] } | { error: PdfFailure };

// Fewer visible characters than this in the whole file, or mostly unmapped glyphs: there is no usable text layer,
// which is what a scanned PDF looks like.
const MIN_VISIBLE_CHARS = 50;

const fontData = `${join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`;

interface Piece {
  str: string;
  x: number;
  y: number;
  end: number;
  size: number;
  // The PDF put a space piece just before this one.
  spaced?: boolean;
}

// One run of text on one baseline, with no wide gap inside it.
interface Segment {
  pieces: Piece[];
  x: number;
  end: number;
  y: number;
  size: number;
}

interface Line {
  y: number;
  size: number;
  text: string;
  // A piece of a two-column row, or a line across the whole page.
  side: 'left' | 'right' | 'full';
  // In one of the top or bottom rows of its page.
  edge?: boolean;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;

// Text pieces on the same baseline become segments; a gap wider than about three spaces splits them, so the two
// halves of a two-column row stay apart. A space piece only marks a space before the next piece: it can be as wide
// as the gutter, so it never joins two pieces itself.
function segments(items: TextItem[]): Segment[] {
  const pieces: Piece[] = items
    .filter((it) => it.str !== '')
    .map((it) => {
      const [a, b, , d, x, y] = it.transform as number[];
      return {
        str: it.str,
        x: x!,
        y: y!,
        end: x! + it.width,
        size: Math.hypot(a!, b!) || Math.abs(d!) || 1,
      };
    });
  pieces.sort((p, q) => q.y - p.y || p.x - q.x);
  const rows: Piece[][] = [];
  for (const p of pieces) {
    const row = rows.at(-1);
    // Against the larger of the two sizes, so a raised footnote mark or exponent stays on its line.
    if (row && Math.abs(row[0]!.y - p.y) <= Math.max(row[0]!.size, p.size) * 0.45) row.push(p);
    else rows.push([p]);
  }
  const out: Segment[] = [];
  for (const row of rows) {
    row.sort((p, q) => p.x - q.x);
    let seg: Segment | null = null;
    let spaced = false;
    for (const p of row) {
      if (p.str.trim() === '') {
        spaced = true;
        continue;
      }
      if (seg && p.x - seg.end <= p.size * 1.5) {
        seg.pieces.push({ ...p, spaced });
        seg.end = Math.max(seg.end, p.end);
      } else {
        if (seg) out.push(seg);
        // Its own height, not the row's: rows can lump together lines of two columns set slightly apart.
        seg = { pieces: [p], x: p.x, end: p.end, y: p.y, size: p.size };
      }
      spaced = false;
    }
    if (seg) out.push(seg);
  }
  return out;
}

// LaTeX and similar tools often draw an accent as a glyph of its own in front of the letter ("Universit¨at"). Put
// back together wherever Unicode has the accented letter, so the text reads, and quotes match, as written.
const SPACING_ACCENTS: Record<string, string> = {
  '¨': '̈',
  '´': '́',
  ˆ: '̂',
  '˜': '̃',
  ˇ: '̌',
  '˘': '̆',
  '˚': '̊',
  '˝': '̋',
  '˙': '̇',
  '¯': '̄',
};
const ACCENT_THEN_LETTER = /([¨´ˆ˜ˇ˘˚˝˙¯]) ?(\p{L})/gu;
const joinAccents = (text: string) =>
  text.replace(ACCENT_THEN_LETTER, (whole, accent: string, letter: string) => {
    // "´" before a consonant is more often an apostrophe ("Let´s") than an accent.
    if (accent === '´' && !/[aeiouy]/i.test(letter)) return whole;
    // A dotless i under an accent is the i of "naïve".
    const joined = ((letter === 'ı' ? 'i' : letter) + SPACING_ACCENTS[accent]).normalize('NFC');
    return joined.length === 1 ? joined : whole;
  });

const segmentText = (s: Segment) => {
  let text = '';
  let end: number | undefined;
  for (const p of s.pieces) {
    // A space piece, or a gap of a fifth of the font size or more, which is a space the PDF didn't spell out.
    if (
      end !== undefined &&
      (p.spaced || p.x - end > p.size * 0.2) &&
      !/\s$/.test(text) &&
      !/^\s/.test(p.str)
    ) {
      text += ' ';
    }
    text += p.str;
    end = p.end;
  }
  return joinAccents(text.trim());
};

// A gutter: a vertical band in the middle part of the page that most rows leave empty, with text on both sides, and
// lines on each side that mostly fill their column. The last check keeps a table of labels and values on a
// one-column page from being read as two columns.
function findGutter(segs: Segment[]): number | null {
  const x = gutterCandidate(segs);
  if (x === null) return null;
  const left = Math.min(...segs.map((s) => s.x));
  const right = Math.max(...segs.map((s) => s.end));
  const fills = (side: Segment[], span: number) =>
    median(side.map((s) => s.end - s.x)) >= span * 0.5;
  return fills(
    segs.filter((s) => s.end <= x),
    x - left,
  ) &&
    fills(
      segs.filter((s) => s.x >= x),
      right - x,
    )
    ? x
    : null;
}

function gutterCandidate(segs: Segment[]): number | null {
  if (segs.length < 6) return null;
  const left = Math.min(...segs.map((s) => s.x));
  const right = Math.max(...segs.map((s) => s.end));
  const width = right - left;
  if (width <= 0) return null;
  let best: { x: number; crossing: number } | null = null;
  for (let x = left + width * 0.3; x <= left + width * 0.7; x += 2) {
    const crossing = segs.filter((s) => s.x < x && s.end > x).length;
    const leftSide = segs.filter((s) => s.end <= x).length;
    const rightSide = segs.filter((s) => s.x >= x).length;
    // Most rows on both sides, and few lines across: titles and figure captions may cross, columns don't.
    if (leftSide < segs.length * 0.25 || rightSide < segs.length * 0.25) continue;
    if (crossing > segs.length * 0.15) continue;
    if (!best || crossing < best.crossing) best = { x, crossing };
  }
  return best?.x ?? null;
}

// Reading order for a page: lines across the page stay where they are; between them, the left column is read top
// to bottom before the right one.
function readingOrder(segs: Segment[]): Line[] {
  const gutter = findGutter(segs);
  const lines: Line[] = segs.map((s) => ({
    y: s.y,
    size: s.size,
    text: segmentText(s),
    side:
      gutter === null || (s.x < gutter && s.end > gutter)
        ? 'full'
        : s.end <= gutter
          ? 'left'
          : 'right',
  }));
  // Segments come sorted top to bottom, left to right; a run of column pieces is reordered as a block.
  const out: Line[] = [];
  let block: Line[] = [];
  const flush = () => {
    out.push(...block.filter((l) => l.side === 'left'), ...block.filter((l) => l.side === 'right'));
    block = [];
  };
  for (const line of lines) {
    if (line.side === 'full') {
      flush();
      out.push(line);
    } else {
      block.push(line);
    }
  }
  flush();
  return out;
}

// A page number as printed: "12", "Page 12", "12 of 40", "12/40", "- 12 -".
const PAGE_NUMBER =
  /^(?:page\s+)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?$|^[-\u2013\u2014]\s*\d{1,4}\s*[-\u2013\u2014]$/i;
const runningKey = (l: Line) => {
  const text = l.text.replace(/\s+/g, ' ').toLowerCase();
  return PAGE_NUMBER.test(text) ? 'page number' : text;
};

// The lines in the two highest and two lowest rows of a page, by where they sit, whatever their reading order: in a
// two-column page a running head on the right side is read after the left column.
function markEdges(lines: Line[]) {
  const rows = [...new Set(lines.map((l) => Math.round(l.y)))].sort((a, b) => b - a);
  const edges = new Set([...rows.slice(0, 2), ...rows.slice(-2)]);
  for (const l of lines) l.edge = edges.has(Math.round(l.y));
}

// Lines that repeat at the top or bottom of most pages (titles, running heads) are layout, not content, and so are
// page numbers there. Compared as written, so lines that differ only in a number ("Question 1", "Question 2") stay.
function runningLines(pages: Line[][]): Set<string> {
  const counts = new Map<string, number>();
  for (const lines of pages) {
    for (const k of new Set(lines.filter((l) => l.edge).map(runningKey))) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const needed = Math.max(2, Math.ceil(pages.length / 2));
  return new Set([...counts].filter(([, n]) => pages.length >= 2 && n >= needed).map(([k]) => k));
}

// A page as text: lines joined by line breaks, a blank line where the gap to the next line in the same flow is
// clearly wider than the usual line spacing.
function pageText(lines: Line[]): string {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1]!.y - lines[i]!.y;
    if (gap > 0) gaps.push(gap);
  }
  const usual = median(gaps);
  let text = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > 0) {
      const prev = lines[i - 1]!;
      const gap = prev.y - line.y;
      // A jump up (the top of the next column) or a change of flow also starts a paragraph; the next cell of a
      // table row, on the same height, does not.
      const paragraph =
        gap < -line.size * 0.2 || prev.side !== line.side || gap > Math.max(usual, line.size) * 1.4;
      text += paragraph ? '\n\n' : '\n';
    }
    text += line.text;
  }
  return text;
}

function isMostlyText(pages: string[]) {
  const visible = pages.join('').replace(/\s+/g, '');
  const unmapped = visible.match(/[�-]/g)?.length ?? 0;
  return visible.length >= MIN_VISIBLE_CHARS && unmapped < visible.length / 2;
}

// Text page by page, in reading order. Page text only: annotations, form fields and attachments are never read.
export async function extractPages(data: Uint8Array): Promise<PdfResult> {
  const task = getDocument({
    data,
    // No font or function in the file is ever turned into code: the 6.x build has no eval or `new Function` left
    // (checked), which is why the old isEvalSupported switch, the CVE-2024-4367 guard, is gone.
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: fontData,
    verbosity: 0,
  });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (err) {
    await task.destroy();
    return {
      error: (err as Error).name === 'PasswordException' ? 'pdf_encrypted' : 'pdf_parse_failed',
    };
  }
  try {
    if (pdf.numPages > MAX_PAGES) return { error: 'pdf_too_many_pages' };
    const pages: Line[][] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const items = content.items.filter((it): it is TextItem => 'str' in it);
      // Text drawn at an angle (a stamp in the margin, a rotated label) goes after the page's own lines.
      const level = items.filter((it) => Math.abs(it.transform[1] as number) < 1e-3);
      const angled = items.filter((it) => Math.abs(it.transform[1] as number) >= 1e-3);
      const lines = readingOrder(segments(level));
      markEdges(lines);
      for (const it of angled) {
        if (it.str.trim()) lines.push({ y: -Infinity, size: 0, text: it.str.trim(), side: 'full' });
      }
      pages.push(lines);
      page.cleanup();
    }
    const running = runningLines(pages);
    const texts = pages.map((lines) =>
      pageText(lines.filter((l) => !(l.edge && running.has(runningKey(l))))),
    );
    if (!isMostlyText(texts)) return { error: 'pdf_no_text' };
    return { pages: texts };
  } catch {
    return { error: 'pdf_parse_failed' };
  } finally {
    await task.destroy();
  }
}
