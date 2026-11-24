import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkText, sectionAt, sectionIndex } from '../src/text/chunk.js';
import { cleanTitle, looksLikeMarkdown } from '../src/text/decode.js';
import { mergeRanges, normalise, verifyQuotes } from '../src/text/quotes.js';

const sample = readFileSync(
  new URL('../../samples/harbor-archive-pilot.md', import.meta.url),
  'utf8',
);

// Every chunk must be a non-empty, exact slice of the text, in order, without overlap.
function expectWellFormed(text: string, chunks: ReturnType<typeof chunkText>) {
  chunks.forEach((c, i) => {
    expect(c.ordinal).toBe(i);
    expect(c.end).toBeGreaterThan(c.start);
    expect(text.slice(c.start, c.end)).toBe(c.text);
    expect(c.text.isWellFormed()).toBe(true);
    if (i > 0) expect(c.start).toBeGreaterThanOrEqual(chunks[i - 1]!.end);
  });
}

describe('chunkText', () => {
  it('cuts the sample note into exact slices, packing its short sections together', () => {
    const chunks = chunkText(sample);
    expectWellFormed(sample, chunks);
    expect(chunks.map((c) => c.headingPath)).toEqual([
      'Harbor Archive retrieval pilot',
      'Harbor Archive retrieval pilot > Results',
      'Harbor Archive retrieval pilot > Limitations',
    ]);
  });

  it('keeps every paragraph line in some chunk', () => {
    const chunks = chunkText(sample);
    for (const line of sample.split('\n').filter((l) => l.trim() && !l.startsWith('#'))) {
      expect(chunks.some((c) => c.text.includes(line))).toBe(true);
    }
  });

  it('splits a paragraph too long for one chunk at sentence ends', () => {
    const sentence = 'The archive kept every note it was given for later review. ';
    const text = `# Long\n\n${sentence.repeat(80).trim()}\n`;
    const chunks = chunkText(text);
    expectWellFormed(text, chunks);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks.slice(1)) {
      expect(c.text.length).toBeLessThanOrEqual(1_600);
      expect(c.text.endsWith('.')).toBe(true);
    }
  });

  it('hard-splits a paragraph with no sentence ends or spaces', () => {
    const text = 'x'.repeat(5_000);
    const chunks = chunkText(text);
    expectWellFormed(text, chunks);
    expect(chunks.map((c) => c.text).join('')).toBe(text);
  });

  it('never makes an empty chunk from an indented long line', () => {
    for (const text of [
      `    ${'x'.repeat(2_000)}`,
      `${'A full paragraph of text. '.repeat(50)}\n\n    ${'y'.repeat(2_000)}`,
      `# H\n\n    ${'z'.repeat(2_000)}`,
    ]) {
      expectWellFormed(text, chunkText(text));
    }
  });

  it('never cuts an emoji in half', () => {
    // The leading letter puts a high surrogate at the end of the first cut window.
    const text = `a${'😀'.repeat(1_000)}`;
    const chunks = chunkText(text);
    expectWellFormed(text, chunks);
    expect(chunks.map((c) => c.text).join('')).toBe(text);
  });

  it('packs thousands of one-line sections into a manageable number of chunks', () => {
    const text = Array.from({ length: 2_000 }, (_, i) => `## Term ${i}\n\nDefinition ${i}.\n`).join(
      '\n',
    );
    const chunks = chunkText(text);
    expectWellFormed(text, chunks);
    expect(chunks.length).toBeLessThan(200);
  });

  it('chunks a very long heading-like line quickly, as a paragraph', () => {
    for (const filler of ['#', ' ']) {
      const text = `# ${filler.repeat(160_000)}x\n\nBody.\n`;
      const started = performance.now();
      const chunks = chunkText(text);
      expect(performance.now() - started).toBeLessThan(1_000);
      expectWellFormed(text, chunks);
      expect(chunks.every((c) => c.headingPath === '')).toBe(true);
      expect(sectionIndex(text)).toEqual([]);
    }
  });

  it('keeps a "#" inside a heading and drops a closing run of "#"', () => {
    expect(sectionIndex('# C#\n\nText.\n')[0]?.path).toBe('C#');
    expect(sectionIndex('## Results ##\n\nText.\n')[0]?.path).toBe('Results');
  });

  it('keeps packed chunks within the size limit, even across long blank runs', () => {
    for (const text of [
      `# Short\n\nTiny.${'\n'.repeat(20_000)}# Next\n\nMore text.\n`,
      `# Short\n\nTiny.\n\n# ${'Long heading '.repeat(15)}\n\n${'Words in the body. '.repeat(30)}\n`,
    ]) {
      const chunks = chunkText(text);
      expectWellFormed(text, chunks);
      for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1_600);
    }
  });

  it('treats "#" lines inside a fenced code block as code, not headings', () => {
    const text =
      '# Setup\n\nRun this:\n\n```sh\n# start the stack\ndocker compose up\n```\n\nThen wait.\n';
    const chunks = chunkText(text);
    expect(chunks.map((c) => c.headingPath)).toEqual(['Setup']);
    expect(chunks[0]!.text).toContain('# start the stack');
  });

  it('returns nothing for blank text or headings alone', () => {
    expect(chunkText('\n\n  \n')).toEqual([]);
    expect(chunkText('# A\n\n## B\n')).toEqual([]);
  });
});

describe('sections', () => {
  it('labels an offset with the heading path above it', () => {
    const sections = sectionIndex(sample);
    expect(sectionAt(sections, sample.indexOf('Mira Chen'))).toBe(
      'Harbor Archive retrieval pilot > Decision',
    );
    expect(sectionAt(sections, 0)).toBe('Harbor Archive retrieval pilot');
    expect(sectionAt(sectionIndex('No headings here.'), 3)).toBe('');
  });
});

describe('verifyQuotes', () => {
  const chunks = chunkText(sample);
  const sections = sectionIndex(sample);
  const all = chunks.map(({ start, end }) => ({ start, end }));

  it('locates an exact quote and labels it with its own section', () => {
    const { verified, rejected } = verifyQuotes(
      sample,
      ['Mira Chen owned the limited pilot.'],
      all,
      sections,
    );
    expect(rejected).toEqual([]);
    expect(verified).toHaveLength(1);
    const q = verified[0]!;
    expect(sample.slice(q.start, q.end)).toBe('Mira Chen owned the limited pilot.');
    // The quote sits in a chunk that starts in "Results", but the label is the section it is actually in.
    expect(q.section).toBe('Harbor Archive retrieval pilot > Decision');
    expect(sample.split('\n')[q.line - 1]).toContain('Mira Chen');
  });

  it('accepts curly quotes, other dashes, extra spaces and emphasis marks', () => {
    const text = 'The team said: "keep keyword search" - for now, while the pilot runs.';
    const quote = 'said:  “keep  keyword search” — for *now*, while the pilot';
    const { verified } = verifyQuotes(text, [quote], [{ start: 0, end: text.length }], []);
    expect(verified).toHaveLength(1);
    // Property: the original text at the returned offsets normalises to the same string as the quote.
    const q = verified[0]!;
    expect(normalise(text, q.start, q.end).text).toBe(normalise(quote).text);
  });

  it('rejects text that is not in the document', () => {
    const quote = 'The pilot cost five million dollars in total.';
    const { verified, rejected } = verifyQuotes(sample, [quote], all, sections);
    expect(verified).toEqual([]);
    expect(rejected).toEqual([{ text: quote, reason: 'not_found' }]);
  });

  it('rejects quotes shorter than 20 characters', () => {
    expect(verifyQuotes(sample, ['Mira Chen'], all, sections).rejected[0]?.reason).toBe(
      'too_short',
    );
  });

  it('only accepts quotes from the passages that were sent', () => {
    const intro = chunks[0]!;
    const results = chunks[1]!;
    const quote = 'Mira Chen owned the limited pilot.';
    expect(verifyQuotes(sample, [quote], [intro], sections).verified).toEqual([]);
    expect(verifyQuotes(sample, [quote], [results], sections).verified).toHaveLength(1);
  });

  it('accepts a quote that crosses from one sent passage into the next', () => {
    const text = 'First passage ends here.\n\nSecond passage starts here.';
    const sent = [
      { start: 0, end: 24 },
      { start: 26, end: text.length },
    ];
    const { verified } = verifyQuotes(text, ['ends here. Second passage'], sent, []);
    expect(verified).toHaveLength(1);
    expect(text.slice(verified[0]!.start, verified[0]!.end)).toBe('ends here.\n\nSecond passage');
  });

  it('picks the first match in document order when the text repeats', () => {
    const text = 'A repeated sentence for testing.\n\nA repeated sentence for testing.';
    const sent = [
      { start: 34, end: text.length },
      { start: 0, end: 32 },
    ];
    expect(
      verifyQuotes(text, ['A repeated sentence for testing.'], sent, []).verified[0]?.start,
    ).toBe(0);
  });

  it('merges neighbouring ranges only across whitespace', () => {
    const text = 'aaaa  bbbb cccc';
    expect(
      mergeRanges(text, [
        { start: 6, end: 10 },
        { start: 0, end: 4 },
      ]),
    ).toEqual([{ start: 0, end: 10 }]);
    expect(
      mergeRanges(text, [
        { start: 0, end: 4 },
        { start: 11, end: 15 },
      ]),
    ).toHaveLength(2);
  });
});

describe('upload helpers', () => {
  it('cleans a title of control and direction characters and caps its length', () => {
    expect(cleanTitle('  Report\u0007 \u202Eevil\u202C  ', 'x')).toBe('Report evil');
    expect(cleanTitle('a'.repeat(300), 'x')).toHaveLength(200);
    expect(cleanTitle(' \n ', 'Untitled')).toBe('Untitled');
  });

  it('calls a file Markdown only when it has a Markdown heading', () => {
    expect(looksLikeMarkdown('# Title\n\nText')).toBe(true);
    expect(looksLikeMarkdown('Plain text with #hashtag')).toBe(false);
  });
});
