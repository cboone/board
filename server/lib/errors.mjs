const ERRORS = Object.freeze({
  invalid_request: [400, 'The request is invalid.', false],
  session_required: [401, 'Sign in to continue.', false],
  forbidden: [403, 'This request is not permitted.', false],
  source_authorization_required: [
    403,
    'Authorize GitHub again to check repositories.',
    false,
  ],
  source_unavailable: [404, 'The selected source is unavailable.', false],
  source_unstable: [409, 'The source changed during the check.', true],
  source_limit_exceeded: [
    422,
    'The source exceeds the configured collection limits.',
    false,
  ],
  source_incomplete: [
    422,
    'The source could not be collected completely.',
    true,
  ],
  provider_rate_limited: [
    429,
    'GitHub is limiting requests. Try again later.',
    true,
  ],
  source_timeout: [504, 'The source operation exceeded its deadline.', true],
  provider_unavailable: [502, 'GitHub is temporarily unavailable.', true],
  service_unavailable: [503, 'Board storage is temporarily unavailable.', true],
  internal_error: [500, 'An unexpected error occurred.', false],
});

/** Only predefined messages may cross the server/browser boundary. */
export class BoardError extends Error {
  constructor(code, { retryable, cause } = {}) {
    const selected = Object.hasOwn(ERRORS, code) ? code : 'internal_error';
    const [status, message, defaultRetryable] = ERRORS[selected];
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'BoardError';
    this.code = selected;
    this.status = status;
    this.retryable =
      typeof retryable === 'boolean' ? retryable : defaultRetryable;
  }
}

export function normalizeError(error) {
  return error instanceof BoardError && Object.hasOwn(ERRORS, error.code)
    ? new BoardError(error.code, { retryable: error.retryable })
    : new BoardError('internal_error');
}

export function errorEnvelope(error) {
  const normalized = normalizeError(error);
  const [, message] = ERRORS[normalized.code] ?? ERRORS.internal_error;
  return {
    error: { code: normalized.code, message, retryable: normalized.retryable },
  };
}

export function errorResponse(error) {
  const normalized = normalizeError(error);
  return Response.json(errorEnvelope(normalized), {
    status: normalized.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
