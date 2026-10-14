import { ErrorResponse } from '../utils/response.ts';
import { corsHeaders } from '../utils/cors.ts';

export type BoundaryErrorCode =
  | 'CLIENT_DISCONNECTED'
  | 'COUNTRY_NOT_SUPPORTED'
  | 'NO_BOUNDARIES_FOUND'
  | 'UPSTREAM_UNAVAILABLE'
  | 'GENERATION_TIMEOUT'
  | 'GENERATION_FAILED';

/**
 * Typed failure for boundary generation. Carries the HTTP status, a stable
 * machine-readable code, and whether the end user should retry — so clients
 * can show actionable messages instead of a generic 400.
 */
export class BoundaryError extends Error {
  constructor(
    public code: BoundaryErrorCode,
    message: string,
    public status: number,
    public retryable: boolean,
  ) {
    super(message);
    this.name = 'BoundaryError';
  }
}

/**
 * Client disconnects (browser navigated away, fetch aborted, Cloud Run /
 * load-balancer timeout) are routine during multi-minute first-generation —
 * not generation failures. Mirrors the tile routes' 499 convention, but keeps
 * a JSON body so boundary clients can still parse `{ code }`.
 */
export function isClientAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    error instanceof Error &&
    (error.name === 'AbortError' ||
      error.message === 'Aborted' ||
      error.message === 'Stream aborted')
  );
}

export function toBoundaryErrorResponse(error: unknown, signal?: AbortSignal): Response {
  if (isClientAbort(error, signal)) {
    return new Response(
      JSON.stringify({
        error: 'Request was cancelled before boundary data finished generating.',
        code: 'CLIENT_DISCONNECTED' satisfies BoundaryErrorCode,
        retryable: true,
      }),
      { status: 499, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  if (error instanceof BoundaryError) {
    return ErrorResponse(
      { error: error.message, code: error.code, retryable: error.retryable },
      error.status,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return ErrorResponse(
    {
      error: `Boundary generation failed: ${message}. Please retry — if the problem persists, the country may not be served yet.`,
      code: 'GENERATION_FAILED' satisfies BoundaryErrorCode,
      retryable: true,
    },
    500,
  );
}
