import process from "node:process";
if (!process.env) {
  process.env = {};
}
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.210.0/assert/mod.ts";
import { adminBoundaries } from "./admin-boundaries.ts";

Deno.test({
  name: "adminBoundaries - Successfully generates TopoJSON for MW Admin Layer 2",
  async fn() {
    // Ensure we don't leak ops or resources in tests
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ country_code: "MW", admin_level: 2 }),
      // Create an AbortSignal since our fetch depends on req.signal
      signal: AbortSignal.timeout(30000),
    });

    const res = await adminBoundaries(req);

    // Assert successful 200 OK
    assertEquals(res.status, 200);

    const data = await res.json();
    console.log("Returned payload keys:", Object.keys(data));

    // Check that we got TopoJSON back
    assertExists(data.topojson);
    assertEquals(data.country_code, "MW");
    assertEquals(data.admin_level, 2);

    // Verify properties we extract
    const topojson = data.topojson;
    assertEquals(topojson.type, "Topology");

    // There should be at least one geometry feature exported
    assertEquals(typeof data.feature_count, "number");
    assertEquals(
      data.feature_count > 0,
      true,
      "Feature count must be greater than zero",
    );

    assertEquals(typeof data.size_kb, "number");
    assertEquals(typeof data.size_kb, "number");
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "adminBoundaries - Successfully generates TopoJSON for MW Admin Layer 5 with clip",
  async fn() {
    // Ensure we don't leak ops or resources in tests
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ country_code: "MW", admin_level: 5 }),
      // Create an AbortSignal since our fetch depends on req.signal
      signal: AbortSignal.timeout(60000),
    });

    const res = await adminBoundaries(req);

    // Assert successful 200 OK
    assertEquals(res.status, 200);

    const data = await res.json();
    console.log("Returned payload keys:", Object.keys(data));

    // Check that we got TopoJSON back
    assertExists(data.topojson);
    assertEquals(data.country_code, "MW");
    assertEquals(data.admin_level, 5);
    assertEquals(data.topojson.type, "Topology");
    assertEquals(
      data.feature_count > 0,
      true,
      "Feature count must be greater than zero",
    );
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "adminBoundaries - Fails validation with invalid country code",
  async fn() {
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ country_code: "INVALID", admin_level: 2 }),
    });

    const res = await adminBoundaries(req);

    // Should get a validation error (Bad Request)
    assertEquals(res.status, 400);
  },
});

Deno.test({
  name: "adminBoundaries - Fails validation with invalid admin_level",
  async fn() {
    const req = new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ country_code: "MW", admin_level: 10 }), // 10 is invalid
    });

    const res = await adminBoundaries(req);
    assertEquals(res.status, 400);
  },
});
