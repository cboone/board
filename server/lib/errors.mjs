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
  analysis_sensitive_input: [
    422,
    'The repository contains analysis input that cannot be sent safely.',
    false,
  ],
  analysis_input_too_large: [
    422,
    'The repository exceeds the configured analysis limits.',
    false,
  ],
  analysis_output_invalid: [
    502,
    'The analysis response could not produce a valid report.',
    true,
  ],
  analysis_ambiguous: [
    503,
    'The analysis result is uncertain and requires review.',
    false,
  ],
  analysis_provider_rate_limited: [
    429,
    'Analysis is temporarily rate limited. Try again later.',
    true,
  ],
  analysis_provider_unavailable: [
    502,
    'Analysis is temporarily unavailable.',
    true,
  ],
  budget_discussion_required: [
    409,
    'The setup spending threshold requires a decision before continuing.',
    false,
  ],
  budget_exhausted: [
    409,
    'The configured analysis spending limit has been reached.',
    false,
  ],
  pricing_review_required: [
    503,
    'Analysis pricing must be reviewed before continuing.',
    false,
  ],
  analysis_disabled: [
    503,
    'Paid analysis is not enabled for this operation.',
    false,
  ],
  idempotency_conflict: [
    409,
    'This analysis request identifier is already in use.',
    false,
  ],
  job_in_progress: [409, 'Another analysis is already in progress.', true],
  report_not_found: [404, 'The requested report does not exist.', false],
  report_catalog_full: [
    409,
    'The saved report catalog has reached its configured limit.',
    false,
  ],
  report_catalog_changed: [
    409,
    'The saved report list changed. Reload it and try again.',
    true,
  ],
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
