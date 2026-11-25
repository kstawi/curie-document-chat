// Shared by the API (upload limit), the parser and the worker (reply checks); importing it loads no PDF library.
export const MAX_PDF_BYTES = 5 * 1024 * 1024;
export const MAX_PAGES = 100;
