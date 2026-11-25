import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkPages, chunkText, sectionAt, sectionIndex } from '../src/text/chunk.js';
import { cleanTitle, decodeUpload, looksLikeMarkdown } from '../src/text/decode.js';
import { answerPrompt, rewritePrompt } from '../src/prompt.js';
import { cleanQuestion, forModel } from '../src/text/clean.js';
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

  it('ignores zero-width spaces and soft hyphens on either side', () => {
    const text = 'The keyword\u200B search answered in 0.7 s, the hy\u00ADbrid one in 1.2 s.';
    const quote = 'keyword search answered in 0.7 s, the hybrid one';
    expect(verifyQuotes(text, [quote], [{ start: 0, end: text.length }], []).verified).toHaveLength(
      1,
    );
    const plain = 'The keyword search answered in 0.7 s.';
    const marked = 'keyword\u200B search answered\uFEFF in 0.7 s';
    expect(
      verifyQuotes(plain, [marked], [{ start: 0, end: plain.length }], []).verified,
    ).toHaveLength(1);
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

describe('hidden characters', () => {
  const hiddenOnes = [
    0x0, 0x7, 0xe, 0x1f, 0x7f, 0x9f, 0xad, 0x34f, 0x61c, 0x115f, 0x1160, 0x17b4, 0x180b, 0x200b,
    0x200e, 0x202a, 0x202e, 0x2060, 0x2064, 0x2065, 0x2066, 0x206a, 0x3164, 0xfeff, 0xfff0, 0xffa0,
    0x1bca0, 0x1d173, 0xe0000, 0xe0041, 0xe007f, 0xe0080, 0xe0100, 0xe01ef, 0xe0fff, 0xfe00, 0xfe0d,
  ].map((cp) => String.fromCodePoint(cp));
  // Whitespace controls, the joiners and the text and emoji variation selectors are kept for the model.
  const visibleOnes = [
    'a',
    'Z',
    ' ',
    '\n',
    '\t',
    '\v',
    '\f',
    '\r',
    '.',
    '"',
    'é',
    '😀',
    '#',
    '*',
  ].concat(
    [0x85, 0x2019, 0x2014, 0x200c, 0x200d, 0xfe0e, 0xfe0f].map((cp) => String.fromCodePoint(cp)),
    // Hyphens, a ligature, a full-width letter and a combining accent go through the hyphen and NFKD rules.
    ['-', '‐', 'ﬁ', 'Ａ', '́', '\u{1d400}'],
  );

  it('are dropped by quote matching exactly as they are removed from text for the model', () => {
    // A fixed pseudo-random sequence, so a failure can be replayed.
    let seed = 7;
    const pick = <T>(items: T[]) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return items[seed % items.length]!;
    };
    for (let run = 0; run < 500; run++) {
      let text = '';
      for (let i = 0; i < 40; i++)
        text += pick([0, 1, 2]) === 0 ? pick(hiddenOnes) : pick(visibleOnes);
      expect(normalise(forModel(text)).text).toBe(normalise(text).text);
    }
  });

  it('are each removed for the model (the test above only shows the two sides agree)', () => {
    for (const ch of hiddenOnes) expect(forModel(`a${ch}b`)).toBe('ab');
  });

  it('leave ordinary text, such as the sample note, exactly as it is', () => {
    expect(forModel(sample)).toBe(sample);
  });

  it('leave whitespace controls as spaces, and Persian words and joined emoji whole', () => {
    expect(cleanQuestion(`Who\vowned\rthe\fpilot${String.fromCodePoint(0x85)}now?`)).toBe(
      'Who owned the pilot now?',
    );
    const persian = `می${String.fromCodePoint(0x200c)}خواهم`;
    expect(cleanQuestion(persian)).toBe(persian);
    const coder = `👩${String.fromCodePoint(0x200d)}💻 notes`;
    expect(cleanTitle(coder, 'x')).toBe(coder);
  });

  it('are left out of quote matching with the joiners, which a model may drop from a quote', () => {
    const zwnj = String.fromCodePoint(0x200c);
    const zwj = String.fromCodePoint(0x200d);
    const text = `The note says می${zwnj}خواهم and the team 👩${zwj}💻 shipped the pilot.`;
    const all = [{ start: 0, end: text.length }];
    expect(
      verifyQuotes(text, ['The note says میخواهم and the team'], all, []).verified,
    ).toHaveLength(1);
    expect(verifyQuotes(text, ['the team 👩💻 shipped the pilot'], all, []).verified).toHaveLength(
      1,
    );
  });

  it('treat next line (U+0085) as a space in quote matching, which plain whitespace checks miss', () => {
    const text = `The pilot ran for six weeks${String.fromCodePoint(0x85)}and then stopped for review.`;
    const quote = 'ran for six weeks and then stopped for review';
    expect(verifyQuotes(text, [quote], [{ start: 0, end: text.length }], []).verified).toHaveLength(
      1,
    );
  });

  it('join passages separated only by hidden characters', () => {
    const text = `First passage.${String.fromCodePoint(0x200b, 0xe0041)} Second passage.`;
    expect(
      mergeRanges(text, [
        { start: 0, end: 14 },
        { start: 18, end: text.length },
      ]),
    ).toEqual([{ start: 0, end: text.length }]);
  });

  it('never reach a prompt, whatever slot they come in', () => {
    const hidden = String.fromCodePoint(0xe0049, 0x202e, 0x200b);
    const earlier = [{ question: `Q${hidden}?`, answer: `A${hidden}.` }];
    for (const prompt of [
      answerPrompt(
        [{ id: 'p', ordinal: 0, start: 0, end: 9, headingPath: '', text: `Passage${hidden}.` }],
        `Who${hidden}?`,
        earlier,
      ),
      rewritePrompt(`Who${hidden}?`, earlier),
    ]) {
      for (const m of prompt) expect(forModel(String(m.content))).toBe(m.content);
    }
  });

  it('are removed from titles, which are composed and cut by code point', () => {
    expect(
      cleanTitle(
        `Re${String.fromCodePoint(0xe0041, 0x200b)}port cafe${String.fromCodePoint(0x301)}`,
        'x',
      ),
    ).toBe('Report café');
    const long = cleanTitle(`${'a'.repeat(199)}😀b`, 'x');
    expect([...long]).toHaveLength(200);
    expect(long.endsWith('😀')).toBe(true);
  });
});

describe('quote matching on PDF-style text', () => {
  const check = (content: string, quote: string) =>
    verifyQuotes(content, [quote], [{ start: 0, end: content.length }], []).verified[0];

  it('matches ligatures, full-width letters and accents however they were stored', () => {
    const content = 'The ﬁnal decision was made by Ｍira Chén in spring.';
    const q = check(content, 'final decision was made by Mira Chén')!;
    expect(content.slice(q.start, q.end)).toBe('ﬁnal decision was made by Ｍira Chén');
  });

  it('joins a word hyphenated at a line end, and keeps a real hyphen matching either way', () => {
    const content =
      'Every result was checked against the archive exam-\nple set and the well-\nknown list.';
    expect(check(content, 'checked against the archive example set')).toBeDefined();
    expect(check(content, 'the archive example set and the well-known list')).toBeDefined();
    expect(
      check('A well-known list of every archive.', 'A well-known list of every'),
    ).toBeDefined();
    // Not between letters: a page range keeps its hyphen.
    expect(
      check('See the table on pages 3-\n4 for the figures.', 'See the table on pages 34 for'),
    ).toBeUndefined();
    // After a digit the hyphen stays, so the quote keeps it too.
    expect(
      check('Use the 3-\nway split for every archive.', 'Use the 3- way split for every'),
    ).toBeDefined();
  });

  it('joins after an accented letter, and across the break to the next column or page', () => {
    const content = 'Die Universitä-\nten und das exam-\n\nple set der Archive bleiben.';
    expect(check(content, 'Die Universitäten und das example set')).toBeDefined();
    expect(check(content, 'Die Universitä-ten und das exam-ple set')).toBeDefined();
  });

  it('matches an en dash between letters with a hyphen, both ways', () => {
    const dash = 'The Navier–Stokes model held for every archive.';
    const hyphen = 'The Navier-Stokes model held for every archive.';
    expect(check(dash, 'The Navier-Stokes model held for')).toBeDefined();
    expect(check(hyphen, 'The Navier–Stokes model held for')).toBeDefined();
  });

  it('does not join a hyphen across a paragraph break into a new sentence', () => {
    const content = 'We ran the pre-\n\nAnd then the main study began in spring.';
    expect(check(content, 'We ran the preAnd then the main study')).toBeUndefined();
    expect(check(content, 'We ran the pre- And then the main study')).toBeDefined();
  });

  it('ends a quote after the whole last character, even outside the basic plane', () => {
    const content = 'The pilot closed with a party and a cake 🎂 for the team.';
    const q = check(content, 'closed with a party and a cake 🎂')!;
    expect(content.slice(q.start, q.end)).toBe('closed with a party and a cake 🎂');
  });

  it('gives a PDF quote its pages, and a range label when it crosses a page break', () => {
    const content = 'The decision was recorded on\n\n18 March 2026 by the owner.';
    const pages = [
      { page: 1, start: 0, end: 28 },
      { page: 2, start: 30, end: content.length },
    ];
    const { verified } = verifyQuotes(
      content,
      ['recorded on 18 March 2026 by the owner', '18 March 2026 by the owner'],
      [{ start: 0, end: content.length }],
      sectionIndex(content, pages),
      pages,
    );
    expect(verified[0]).toMatchObject({ startPage: 1, endPage: 2, section: 'pages 1–2' });
    expect(verified[1]).toMatchObject({ startPage: 2, endPage: 2, section: 'page 2' });
  });
});

describe('chunkPages', () => {
  it('keeps passages within their page, labels them with it, and reads no Markdown in a PDF', () => {
    // As Markdown, the last line would be a heading with nothing under it, after a paragraph too long to pack it
    // with, and so left out of every passage.
    const first = `${'Mira Chen owned the limited pilot. '.repeat(13)}\n# 2 more pilots are planned for spring`;
    const content = `${first}\n\nThe second page starts here.`;
    const pages = [
      { page: 1, start: 0, end: first.length },
      { page: 2, start: first.length + 2, end: content.length },
    ];
    expect(chunkPages(content, pages)).toEqual([
      { ordinal: 0, start: 0, end: first.length, headingPath: 'page 1', text: first },
      {
        ordinal: 1,
        start: first.length + 2,
        end: content.length,
        headingPath: 'page 2',
        text: 'The second page starts here.',
      },
    ]);
  });
});

describe('next line (U+0085)', () => {
  // `trim` and `\s` miss it, so every blank check has to count it.
  const nel = '\u0085';
  it('counts as blank in a document, under a heading and between quoted passages', () => {
    expect(() => decodeUpload(Buffer.from(`${nel}\n${nel}`))).toThrow('The document has no text.');
    // A heading with nothing visible under it makes no passage.
    expect(chunkText(`# Title\n${nel}\n`)).toEqual([]);
    const a = 'Mira Chen owned the limited pilot.';
    const b = 'The pilot ran for six weeks in spring.';
    const content = `${a}${nel}${b}`;
    expect(
      mergeRanges(content, [
        { start: 0, end: a.length },
        { start: a.length + 1, end: content.length },
      ]),
    ).toEqual([{ start: 0, end: content.length }]);
  });

  it('splits a long paragraph at it rather than inside a word', () => {
    const text = Array(400).fill('pilots').join('\u0085');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text).toMatch(/^pilots(\u0085pilots)*$/);
  });
});
