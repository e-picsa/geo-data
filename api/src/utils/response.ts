import { corsHeaders } from './cors.ts';

/**
 * Return an error response
 *
 * Note - if reading from js-client need to await error context body for message
 * https://github.com/supabase/functions-js/issues/45
 *
 * @example
 * ```ts
 * const {dat, error} = await invokeFunction(...)
 * if (error && error instanceof FunctionsHttpError) {
 *  const errorMessage = await error.context.json();
 *  const errorJson = JSON.parse(errorMessage)
 *  console.error(errorJson)
 * }
 * ```
 */
export function ErrorResponse(msg: any, status = 400) {
  return new Response(JSON.stringify(msg), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function JSONResponse<T>(data: T, initOrStatus: number | ResponseInit = 200) {
  if (typeof initOrStatus === 'number') {
    return new Response(JSON.stringify(data), {
      status: initOrStatus,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { headers, status, ...rest } = initOrStatus;
  return new Response(JSON.stringify(data), {
    status: status ?? 200,
    ...rest,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}
