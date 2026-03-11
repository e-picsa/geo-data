import { corsHeaders } from '../utils/cors.ts';
import { adminBoundaries } from '../services/admin-boundaries.ts';

export const handlePublicRoutes = async (req: Request, pathname: string): Promise<Response> => {
  // Health / Readiness Check Endpoint
  if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
    return new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Main API Endpoint
  if (req.method === 'POST' && pathname === '/') {
    return adminBoundaries(req);
  }

  // Fallback for unsupported routes
  return new Response('Not Found', {
    status: 404,
    headers: corsHeaders,
  });
};
