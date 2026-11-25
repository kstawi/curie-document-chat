import { HttpError } from '../errors.js';
import { forModel, isBlank, oneLine } from './clean.js';

const UTF8_BOM = [0xef, 0xbb, 0xbf];

const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((b, i) => bytes[i] === b);

// The type comes from the bytes, never from the file name or the Content-Type the client sent.
export const isPdf = (bytes: Uint8Array) => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

// Turns an uploaded Markdown or text file into the stored text. Line endings become LF; nothing else is changed, so
// offsets match what was sent.
export function decodeUpload(bytes: Uint8Array): string {
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) {
    throw new HttpError(400, 'invalid_encoding', 'The file is UTF-16. Send it as UTF-8.');
  }
  if (bytes.includes(0)) {
    throw new HttpError(
      415,
      'unsupported_type',
      'The file looks binary. Send Markdown or plain text.',
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      startsWith(bytes, UTF8_BOM) ? bytes.subarray(3) : bytes,
    );
  } catch {
    throw new HttpError(400, 'invalid_encoding', 'The file is not valid UTF-8.');
  }
  text = text.replace(/\r\n?/g, '\n');
  // Nothing visible counts as nothing: a file of hidden characters only is empty to a reader.
  if (isBlank(text)) {
    throw new HttpError(400, 'empty_document', 'The document has no text.');
  }
  return text;
}

// A display title only: hidden characters removed, composed (NFC), on one line, at most 200 code points.
export function cleanTitle(raw: string | undefined, fallback: string): string {
  const cleaned = oneLine(forModel(raw ?? '').normalize('NFC'));
  // Cut by code point, so an emoji at the limit stays whole.
  const title = [...cleaned].slice(0, 200).join('').trim();
  return title || fallback;
}

export const looksLikeMarkdown = (text: string) => /^#{1,6}[ \t]+\S/m.test(text);
