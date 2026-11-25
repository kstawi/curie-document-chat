import { extractPages } from './extract.js';

// One extraction per process: the parent sends the file, gets the result, and the process exits. A crash or an
// endless loop on a hostile file takes down only this process.
process.once('message', (data: Uint8Array) => {
  // A plain byte array: the file arrives as a Node Buffer, which pdf.js refuses.
  void extractPages(new Uint8Array(data))
    .catch(() => ({ error: 'pdf_parse_failed' as const }))
    .then((result) => process.send!(result, () => process.exit(0)));
});
