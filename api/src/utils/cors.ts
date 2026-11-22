/**
 * Headers to support CORS requests
 * https://supabase.com/docs/guides/functions/cors
 */
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, range',
  'Access-Control-Expose-Headers':
    'Content-Disposition, Content-Range, Accept-Ranges, X-PMTiles-Sha256, X-PMTiles-Bytes',
};
