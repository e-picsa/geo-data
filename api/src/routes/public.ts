import { corsHeaders } from '../utils/cors.ts';
import { adminBoundaries } from '../services/admin-boundaries.ts';
import { adminCenters } from '../services/admin-centers.ts';

export const handlePublicRoutes = async (req: Request, pathname: string): Promise<Response> => {
  // Health / Readiness Check Endpoint
  if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Admin / District Centers Endpoint
  if (pathname === '/centers') {
    return adminCenters(req);
  }

  // Main Boundaries Endpoint
  if (req.method === 'POST' && pathname === '/') {
    return adminBoundaries(req);
  }

  // Fallback for unsupported routes
  return new Response('Not Found', {
    status: 404,
    headers: corsHeaders,
  });
};
