import { corsHeaders } from "./utils/cors.ts";
import { adminBoundaries } from "./admin-boundaries.ts";

const port = parseInt(Deno.env.get("PORT") ?? "8080");

const abortController = new AbortController();

const shutdown = () => {
  console.log("Shutting down gracefully...");
  abortController.abort();
};

Deno.addSignalListener("SIGINT", shutdown);
if (Deno.build.os !== "windows") {
  Deno.addSignalListener("SIGTERM", shutdown);
}

Deno.serve({ port, signal: abortController.signal }, async (req: Request) => {
  // handle cors pre-flight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const { pathname } = new URL(req.url);

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

  // Fallback for unsupported routes
  return new Response("Not Found", {
    status: 404,
    headers: corsHeaders,
  });
});
