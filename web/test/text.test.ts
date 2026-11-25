import { describe, expect, it } from 'vitest';
import { pieces, toLines, touches, type Line } from '../src/text';

const rebuild = (content: string, lines: Line[]) =>
  lines
    .map((l) =>
      pieces(l, null)
        .map((p) => content.slice(p.start, p.end))
        .join(''),
    )
    .join('\n');

describe('toLines', () => {
  const markdown = [
    '# Harbor Archive',
    '',
    'Mira Chen owned the **limited** pilot.',
    '> A quoted line',
    '- a list item',
    '12. a numbered item',
    '```',
    '# not a heading in code',
    '```',
    '#hashtag is text',
    '## Results ##',
    '   ',
    '#',
  ].join('\n');

  it('keeps every character, so the lines join back to the stored text', () => {
    expect(rebuild(markdown, toLines(markdown, 'markdown', null))).toBe(markdown);
    const awkward = '\n\nline\twith tab\n​\n\n';
    expect(rebuild(awkward, toLines(awkward, 'markdown', null))).toBe(awkward);
  });

  it('styles Markdown lines by their marker, and only Markdown', () => {
    const lines = toLines(markdown, 'markdown', null);
    expect(lines.map((l) => l.kind)).toEqual([
      'heading',
      'blank',
      'text',
      'quote',
      'list',
      'list',
      'fence',
      'code',
      'fence',
      'text',
      'heading',
      'blank',
      'text',
    ]);
    expect(lines[0]).toMatchObject({ level: 1, markerEnd: 2 });
    expect(markdown.slice(lines[3]!.start, lines[3]!.markerEnd)).toBe('> ');
    expect(markdown.slice(lines[5]!.start, lines[5]!.markerEnd)).toBe('12. ');
    expect(
      toLines(markdown, 'text', null).every((l) => l.kind === 'text' || l.kind === 'blank'),
    ).toBe(true);
  });

  it('follows the server on tilde fences and on the 200-character heading cap', () => {
    const tilde = ['~~~', '# a shell comment', '~~~', '# Heading'].join('\n');
    expect(toLines(tilde, 'markdown', null).map((l) => l.kind)).toEqual([
      'fence',
      'code',
      'fence',
      'heading',
    ]);
    expect(toLines(`# ${'x'.repeat(198)}`, 'markdown', null)[0]!.kind).toBe('heading');
    expect(toLines(`# ${'x'.repeat(199)}`, 'markdown', null)[0]!.kind).toBe('text');
  });

  it('marks the first line of each PDF page', () => {
    const content = 'Page one text.\n\nPage two text.';
    const lines = toLines(content, 'pdf', [
      { page: 1, start: 0, end: 14 },
      { page: 2, start: 16, end: 30 },
    ]);
    expect(lines.map((l) => l.page)).toEqual([1, undefined, 2]);
  });
});

describe('pieces', () => {
  const content = '## Results of the pilot';
  const [line] = toLines(content, 'markdown', null);

  it('cuts a line at its marker and around a highlighted range', () => {
    const cut = pieces(line!, { start: 11, end: 17 });
    expect(cut.map((p) => [content.slice(p.start, p.end), p.marker, p.highlighted])).toEqual([
      ['## ', true, false],
      ['Results ', false, false],
      ['of the', false, true],
      [' pilot', false, false],
    ]);
  });

  it('highlights a whole line inside a range that spans several lines', () => {
    const text = 'first line\nsecond line\nthird line';
    const lines = toLines(text, 'text', null);
    const range = { start: 6, end: 28 };
    expect(lines.map((l) => touches(l, range))).toEqual([true, true, true]);
    expect(pieces(lines[1]!, range)).toEqual([
      { start: 11, end: 22, marker: false, highlighted: true },
    ]);
    expect(touches(lines[0]!, { start: 30, end: 33 })).toBe(false);
    // A range that starts on the line break after a line still lights that line.
    expect(touches(lines[0]!, { start: 10, end: 12 })).toBe(true);
  });
});
