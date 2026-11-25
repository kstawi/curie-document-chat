import { PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib';

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
