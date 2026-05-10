import { z } from 'zod';

export const BOUNDARY_REQUEST_SCHEMA = z.object({
  country_code: z
    .string()
    .length(2)
    .regex(/^[a-zA-Z]{2}$/, 'Must be a valid 2-letter country code')
    .transform((v: string) => v.toUpperCase()),
});

export type BoundaryRequestParams = z.infer<typeof BOUNDARY_REQUEST_SCHEMA>;
