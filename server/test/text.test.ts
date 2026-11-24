import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/text/chunk.js';
import { mergeRanges, normalise, verifyQuotes } from '../src/text/quotes.js';

const sample = readFileSync(
  new URL('../../samples/harbor-archive-pilot.md', import.meta.url),
  'utf8',
);

describe('chunkText', () => {
  it('cuts the sample note into its sections, each an exact slice of the text', () => {
    const chunks = chunkText(sample);
    expect(chunks.map((c) => c.headingPath)).toEqual([
      'Harbor Archive retrieval pilot',
      'Harbor Archive retrieval pilot > Purpose and setup',
      'Harbor Archive retrieval pilot > Results',
      'Harbor Archive retrieval pilot > Decision',
      'Harbor Archive retrieval pilot > Limitations',
    ]);
    for (const c of chunks) expect(sample.slice(c.start, c.end)).toBe(c.text);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps every paragraph line in some chunk, in order and without overlap', () => {
    const chunks = chunkText(sample);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.start).toBeGreaterThanOrEqual(chunks[i - 1]!.end);
    }
    for (const line of sample.split('\n').filter((l) => l.trim() && !l.startsWith('#'))) {
      expect(chunks.some((c) => c.text.includes(line))).toBe(true);
    }
  });

  it('splits a paragraph too long for one chunk at sentence ends', () => {
    const sentence = 'The archive kept every note it was given for later review. ';
    const text = `# Long\n\n${sentence.repeat(80).trim()}\n`;
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(text.slice(c.start, c.end)).toBe(c.text);
      expect(c.text.length).toBeLessThanOrEqual(1_600);
      expect(c.text.endsWith('.')).toBe(true);
    }
  });

  it('hard-splits a paragraph with no sentence ends or spaces', () => {
    const text = 'x'.repeat(5_000);
    const chunks = chunkText(text);
    expect(chunks.map((c) => c.text).join('')).toBe(text);
  });

  it('drops headings with no text of their own but keeps them in the path', () => {
    const chunks = chunkText('# Paper\n\n## Empty\n\n### Sub\n\nBody text here.\n');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.headingPath).toBe('Paper > Empty > Sub');
  });

  it('treats "#" lines inside a fenced code block as code, not headings', () => {
    const text =
      '# Setup\n\nRun this:\n\n```sh\n# start the stack\ndocker compose up\n```\n\nThen wait.\n';
    const chunks = chunkText(text);
    expect(chunks.map((c) => c.headingPath)).toEqual(['Setup']);
    expect(chunks[0]!.text).toContain('# start the stack');
  });

  it('returns nothing for blank text', () => {
    expect(chunkText('\n\n  \n')).toEqual([]);
  });
});

describe('verifyQuotes', () => {
  const chunks = chunkText(sample);
  const all = chunks.map(({ start, end }) => ({ start, end }));

  it('locates an exact quote', () => {
    const { verified, rejected } = verifyQuotes(
      sample,
      ['Mira Chen owned the limited pilot.'],
      all,
      chunks,
    );
    expect(rejected).toEqual([]);
    expect(verified).toHaveLength(1);
    const q = verified[0]!;
    expect(sample.slice(q.start, q.end)).toBe('Mira Chen owned the limited pilot.');
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
    const { verified, rejected } = verifyQuotes(
      sample,
      ['The pilot cost five million dollars in total.'],
      all,
      chunks,
    );
    expect(verified).toEqual([]);
    expect(rejected).toEqual([
      { text: 'The pilot cost five million dollars in total.', reason: 'not_found' },
    ]);
  });

  it('rejects quotes shorter than 20 characters', () => {
    const { rejected } = verifyQuotes(sample, ['Mira Chen'], all, chunks);
    expect(rejected[0]?.reason).toBe('too_short');
  });

  it('only accepts quotes from the passages that were sent', () => {
    const results = chunks.find((c) => c.headingPath.endsWith('Results'))!;
    const decision = chunks.find((c) => c.headingPath.endsWith('Decision'))!;
    const sent = [{ start: results.start, end: results.end }];
    expect(
      verifyQuotes(sample, ['Mira Chen owned the limited pilot.'], sent, chunks).verified,
    ).toEqual([]);
    expect(
      verifyQuotes(sample, ['Mira Chen owned the limited pilot.'], [decision], chunks).verified,
    ).toHaveLength(1);
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
    const { verified } = verifyQuotes(text, ['A repeated sentence for testing.'], sent, []);
    expect(verified[0]?.start).toBe(0);
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
