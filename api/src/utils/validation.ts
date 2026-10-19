import { z } from 'zod';
import { ErrorResponse } from './response.ts';

export async function validateBody<T extends z.ZodType>(
  req: Request,
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;

  try {
    body = await req.json();
  } catch (err) {
    console.error(err);
    throw ErrorResponse('Invalid JSON body');
  }

  const result = schema.safeParse(body);

  if (!result.success) {
    const { formErrors, fieldErrors } = z.flattenError(result.error);
    const fields = Object.keys(fieldErrors);

    // Keep the Zod detail for debugging, but always include a human-readable
    // `error` — every other failure body on these routes carries one.
    throw ErrorResponse(
      {
        error:
          fields.length > 0
            ? `Invalid request body: ${fields.join(', ')}.`
            : 'Invalid request body.',
        formErrors,
        fieldErrors,
      },
      400,
    );
  }

  return result.data;
}
