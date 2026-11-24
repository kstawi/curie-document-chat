// Fixed error codes with messages safe to show a client. Details (provider text, stack traces) stay in logs or the
// debug column.
export const ERROR_MESSAGES = {
  empty_document: 'The document has no text.',
  document_not_ready: 'The document is not ready for questions yet.',
  embedding_model_changed:
    'The document was indexed with a different embedding model than the one now configured. Re-prepare it first.',
  model_unavailable: 'The model server could not be reached or is overloaded. Try again later.',
  model_rejected: 'The model server rejected the request. Check the model settings.',
  model_bad_output: 'The model did not return a usable answer.',
  internal_error: 'Something went wrong.',
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
