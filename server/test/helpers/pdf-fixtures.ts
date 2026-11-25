import { degrees, PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib';

// PDFs generated for the tests, so no binary fixture is committed. All text is our own.

// Words wrapped to lines of at most `width` characters.
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export const REPORT = {
  title: 'A Generated Two-Column Report on the Harbor Archive Pilot',
  header: 'Harbor Archive Report, internal draft',
  left: [
    'Mira Chen owned the limited pilot from the first week. She chose six archive collections that staff search every day.',
    'The team measured how often the right passage came first. Keyword search found exact names well but missed paraphrases.',
  ],
  right: [
    'Hybrid search joined keyword and meaning based results. It found paraphrased questions that keyword search missed entirely.',
    // Ends at the bottom of page 1's right column; the sentence goes on at the top of page 2.
    'The final decision about the default search was recorded on',
  ],
  nextLeft: [
    '18 March 2026 by the pilot owner after the review meeting. Keyword search stays the default for now.',
    // A word broken across two lines with a hyphen, as a typesetter would.
    'Every result was checked against the archive exam-|ple set before the pilot closed.',
  ],
  nextRight: [
    'The second phase will widen the pilot to twelve collections and measure the cost per question.',
  ],
  lastLeft: ['The third page holds the appendix with the list of collections and their owners.'],
  lastRight: ['Each collection owner signed off on the measurements before the report went out.'],
};

// Three pages: a title across the top of page 1, two columns drawn row by row (so drawing order mixes them), a
// running header and a page number on every page, and a sentence that crosses from page 1 to page 2.
export async function twoColumnReport(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const columns = (paragraphs: string[]) =>
    paragraphs.flatMap((p, i) => [
      ...(i > 0 ? [''] : []),
      // A "|" forces a line break, as after the hyphen in "exam-|ple".
      ...p.split('|').flatMap((part) => wrap(part, 40)),
    ]);
  const pages: [string[], string[]][] = [
    [columns(REPORT.left), columns(REPORT.right)],
    [columns(REPORT.nextLeft), columns(REPORT.nextRight)],
    [columns(REPORT.lastLeft), columns(REPORT.lastRight)],
  ];
  pages.forEach(([left, right], index) => {
    const page = doc.addPage([612, 792]);
    page.drawText(REPORT.header, { x: 72, y: 752, size: 9, font });
    let top = 700;
    if (index === 0) {
      page.drawText(REPORT.title, { x: 72, y: 712, size: 14, font });
      top = 680;
    }
    // The last right-column line of page 1 sits at the very bottom, so the sentence breaks across the page.
    const rows = Math.max(left.length, right.length);
    for (let i = 0; i < rows; i++) {
      const y = top - i * 13;
      if (left[i]) page.drawText(left[i]!, { x: 72, y, size: 10, font });
      if (right[i]) page.drawText(right[i]!, { x: 320, y, size: 10, font });
    }
    page.drawText(`Page ${index + 1}`, { x: 290, y: 40, size: 9, font });
  });
  return doc.save();
}

// One plain page per entry.
export async function plainPdf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([612, 792]);
    wrap(text, 80).forEach((line, i) =>
      page.drawText(line, { x: 72, y: 700 - i * 14, size: 11, font }),
    );
  }
  return doc.save();
}

// Two things papers typeset with LaTeX do: a word gap marked by a narrow space of its own between differently styled
// words, and an accent drawn as its own glyph in front of the letter.
export async function typesetPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const page = doc.addPage([612, 792]);
  let x = 72;
  const run = (text: string, font: typeof regular, size: number) => {
    page.drawText(text, { x, y: 700, size, font });
    x += font.widthOfTextAtSize(text, size);
  };
  run('With', regular, 9);
  run(' ', regular, 5);
  run('semantically meaningful', italic, 9);
  run(' ', italic, 5);
  run('we mean that similar sentences are close.', regular, 9);
  page.drawText('Department of Computer Science, Technische Universit¨at Darmstadt', {
    x: 72,
    y: 680,
    size: 9,
    font: regular,
  });
  // "´" written for an apostrophe, and once as an accent.
  page.drawText('Let´s meet at the caf´e by the harbour after the review.', {
    x: 72,
    y: 660,
    size: 9,
    font: regular,
  });
  // A footnote mark, raised and smaller, right after the end of a sentence.
  x = 72;
  const sentence = 'The pilot ran in each test run.';
  page.drawText(sentence, { x, y: 640, size: 10, font: regular });
  page.drawText('12', {
    x: x + regular.widthOfTextAtSize(sentence, 10),
    y: 643.6,
    size: 7,
    font: regular,
  });
  page.drawText('Hybrid search was proposed in earlier work and adopted.', {
    x: 72,
    y: 628,
    size: 10,
    font: regular,
  });
  // A stamp up the left margin, as arXiv adds, starting level with the lines above: read as a line, it would land
  // among them.
  page.drawText('Generated stamp in the margin', {
    x: 30,
    y: 650,
    size: 9,
    font: regular,
    rotate: degrees(90),
  });
  return doc.save();
}

// Four pages of a journal in two columns: the running head sits at the top right and the page number at the bottom
// left, so neither is first or last in reading order. A sentence runs from the left column into the right one.
export async function journalPages(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 4; n++) {
    // Each page's own text, at its edges too: body lines repeated on every page would rightly count as running.
    const left = wrap(
      `Part ${n}. ${REPORT.left.join(' ')} The decision was finally recorded in part ${n}`,
      40,
    );
    const right = wrap(
      `on the eighteenth, part ${n}, by the owner. ${REPORT.nextRight[0]} End of part ${n}.`,
      40,
    );
    const page = doc.addPage([612, 792]);
    page.drawText('Journal of Archive Studies', { x: 420, y: 752, size: 9, font });
    left.forEach((line, i) => page.drawText(line, { x: 72, y: 700 - i * 13, size: 10, font }));
    right.forEach((line, i) => page.drawText(line, { x: 320, y: 700 - i * 13, size: 10, font }));
    page.drawText(String(10 + n), { x: 72, y: 40, size: 9, font });
  }
  return doc.save();
}

// Three quiz pages whose first and last lines differ only in a number: content, not running lines.
export async function quizPages(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  [10, 15, 5].forEach((points, i) => {
    const page = doc.addPage([612, 792]);
    page.drawText(`Question ${i + 1}`, { x: 72, y: 740, size: 12, font });
    wrap(REPORT.left[i % 2]!, 80).forEach((line, j) =>
      page.drawText(line, { x: 72, y: 700 - j * 14, size: 11, font }),
    );
    page.drawText(`Worth ${points} points`, { x: 72, y: 60, size: 11, font });
  });
  return doc.save();
}

// A one-column page with a table of labels and values.
export async function tablePage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  wrap(REPORT.left[0]!, 80).forEach((line, i) =>
    page.drawText(line, { x: 72, y: 740 - i * 14, size: 11, font }),
  );
  const rows = [
    ['Pilot owner', 'Mira Chen'],
    ['Collections searched', 'Six archive collections'],
    ['Search kinds compared', 'Keyword, meaning and hybrid'],
    ['Decision recorded', '18 March 2026'],
    ['Next phase', 'Twelve collections'],
    ['Measured', 'Cost per question'],
  ];
  rows.forEach(([label, value], i) => {
    page.drawText(label!, { x: 72, y: 660 - i * 16, size: 11, font });
    page.drawText(value!, { x: 300, y: 660 - i * 16, size: 11, font });
  });
  return doc.save();
}

// Two columns with different line spacing, as when one holds small footnote text: rows across the page don't line
// up, and the small lines make the usual line gap smaller than the other column's.
export async function unevenColumns(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const left = wrap(REPORT.left.join(' ').repeat(3), 50);
  const right = wrap(`${REPORT.right[0]} ${REPORT.nextRight[0]}`, 40);
  left.forEach((line, i) => page.drawText(line, { x: 72, y: 700 - i * 8, size: 7, font }));
  right.forEach((line, i) => page.drawText(line, { x: 320, y: 700 - i * 12, size: 10, font }));
  return doc.save();
}

export async function blankPdf(pageCount = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([612, 792]);
  return doc.save();
}

// A 1x1 grey PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64',
);

// A scanned page: an image and no text layer.
export async function imageOnlyPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(PNG);
  doc.addPage([612, 792]).drawImage(image, { x: 72, y: 200, width: 468, height: 500 });
  return doc.save();
}

// Marked as encrypted with a user password nobody knows: any reader must ask for a password.
export async function encryptedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc
    .addPage([612, 792])
    .drawText('Secret text behind a password.', { x: 72, y: 700, size: 11, font });
  const bytes32 = (b: number) => PDFHexString.of(b.toString(16).padStart(2, '0').repeat(32));
  const encrypt = doc.context.obj({
    Filter: PDFName.of('Standard'),
    V: 1,
    R: 2,
    O: bytes32(0x11),
    U: bytes32(0x22),
    P: -4,
  });
  doc.context.trailerInfo.Encrypt = doc.context.register(encrypt);
  doc.context.trailerInfo.ID = doc.context.obj([bytes32(0x33), bytes32(0x33)]);
  return doc.save({ useObjectStreams: false });
}

// Numbered sentences, so a test can check their order: "Left 3 of the column, ..." and so on.
const sentences = (side: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${side} ${i + 1} of the column holds a few words here.`);

// A first page as papers have it: a title and a long full-width abstract above two columns.
export async function abstractPage(fullWidth = 12, left = 30, right = 30): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const abstract = wrap(REPORT.left.join(' ').repeat(8), 95).slice(0, fullWidth);
  abstract.forEach((line, i) => page.drawText(line, { x: 72, y: 740 - i * 12, size: 10, font }));
  const top = 740 - fullWidth * 12 - 24;
  sentences('Left', left).forEach((line, i) =>
    page.drawText(line, { x: 72, y: top - i * 12, size: 9, font }),
  );
  sentences('Right', right).forEach((line, i) =>
    page.drawText(line, { x: 320, y: top - i * 12, size: 9, font }),
  );
  return doc.save();
}

// Six pages laid out like a book: no head on page 1, then the left-hand head on even pages and the right-hand head on
// odd ones; a footer that carries its page number; and a table whose heading row repeats at the top of every page.
export async function bookPages(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 6; n++) {
    const page = doc.addPage([612, 792]);
    if (n > 1 && n % 2 === 0)
      page.drawText('Halden Coastal Trust', { x: 72, y: 752, size: 9, font });
    if (n > 1 && n % 2 === 1)
      page.drawText('Saltmarsh Field Report', { x: 430, y: 752, size: 9, font });
    ['Date', 'Description', 'Amount'].forEach((cell, i) =>
      page.drawText(cell, { x: 72 + i * 180, y: 720, size: 11, font }),
    );
    // Each page's own text at its edges: body lines repeated on alternate pages would count as running heads.
    wrap(`Entries for part ${n}. ${REPORT.left[n % 2]!} End of part ${n}.`, 80).forEach((line, i) =>
      page.drawText(line, { x: 72, y: 690 - i * 14, size: 11, font }),
    );
    page.drawText(`Saltmarsh Field Report, page ${n} of 6`, { x: 72, y: 40, size: 9, font });
  }
  return doc.save();
}

// Three pages numbered at the foot, where page 2 also has numbers of its own in its edge rows: years in a table
// heading at the top and totals at the bottom.
export async function figuresPages(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 3; n++) {
    const page = doc.addPage([612, 792]);
    if (n === 2) {
      ['Year', '2024', '2025'].forEach((cell, i) =>
        page.drawText(cell, { x: 72 + i * 150, y: 740, size: 11, font }),
      );
      ['Total', '1250', '1300'].forEach((cell, i) =>
        page.drawText(cell, { x: 72 + i * 150, y: 80, size: 11, font }),
      );
    }
    wrap(`Part ${n}. ${REPORT.left[n % 2]!}`, 80).forEach((line, i) =>
      page.drawText(line, { x: 72, y: 700 - i * 14, size: 11, font }),
    );
    page.drawText(String(n), { x: 300, y: 40, size: 9, font });
  }
  return doc.save();
}

// A table of longer labels and values on a one-column page.
export async function longTablePage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const rows = [
    ['Pilot owner and sponsor', 'Mira Chen, head of the archive team'],
    ['Collections searched daily', 'Six archive collections in two rooms'],
    ['Search kinds compared', 'Keyword, meaning and hybrid search'],
    ['Decision recorded on', '18 March 2026 by the pilot owner'],
    ['Next phase planned', 'Twelve collections and costs per question'],
    ['Measured in the pilot', 'How often the right passage came first'],
  ];
  rows.forEach(([label, value], i) => {
    page.drawText(label!, { x: 72, y: 700 - i * 16, size: 11, font });
    page.drawText(value!, { x: 290, y: 700 - i * 16, size: 11, font });
  });
  return doc.save();
}

// A page of absurd width, with lines near both ends: enough of them that the column scan runs across the width.
export async function widePage(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([2e9, 792]);
  sentences('Left', 6).forEach((line, i) =>
    page.drawText(line, { x: 72, y: 700 - i * 14, size: 11, font }),
  );
  sentences('Right', 6).forEach((line, i) =>
    page.drawText(line, { x: 1.8e9, y: 700 - i * 14, size: 11, font }),
  );
  return doc.save();
}
