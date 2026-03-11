import { corsHeaders } from "./utils/cors.ts";
import { adminBoundaries } from "./admin-boundaries.ts";
import { getCache } from "./utils/cache.ts";

const port = parseInt(process.env.PORT ?? "8080");

const VERSION = 20260306;

console.log('Serve api version ' + VERSION);

Bun.serve({
  port,
  async fetch(req: Request) {
    // handle cors pre-flight
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsHeaders });
    }

    const url = new URL(req.url);
    const pathname = url.pathname;

    // Health / Readiness Check Endpoint
    if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Main API Endpoint
    if (req.method === "POST" && pathname === "/") {
      return adminBoundaries(req);
    }

    // Admin Cache Invalidation Endpoint
    if (req.method === "POST" && pathname === "/admin/clear-cache") {
      try {
        const cache = getCache();
        await cache.clear();
        return new Response(
          JSON.stringify({ status: "success", message: "Cache cleared" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (err: any) {
        return new Response(
          JSON.stringify({ status: "error", message: err.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    // Fallback for unsupported routes
    return new Response("Not Found", {
      status: 404,
      headers: corsHeaders,
    });
  }
});
