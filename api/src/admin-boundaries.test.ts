import process from "node:process";
if (!process.env) {
  process.env = {};
}
import { test, expect } from "bun:test";
import { adminBoundaries } from "./admin-boundaries.ts";

test("adminBoundaries - Successfully generates TopoJSON for MW Admin Layer 2", async () => {
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
  expect(res.status).toBe(200);

  const data = await res.json() as any;
  console.log("Returned payload keys:", Object.keys(data));

  // Check that we got TopoJSON back
  expect(data.topojson).toBeDefined();
  expect(data.country_code).toBe("MW");
  expect(data.admin_level).toBe(2);

  // Verify properties we extract
  const topojson = data.topojson;
  expect(topojson.type).toBe("Topology");

  // There should be at least one geometry feature exported
  expect(typeof data.feature_count).toBe("number");
  expect(data.feature_count > 0).toBe(true);

  expect(typeof data.size_kb).toBe("number");
}, 30000);

test("adminBoundaries - Successfully generates TopoJSON for MW Admin Layer 5 with clip", async () => {
  const req = new Request("http://localhost/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ country_code: "MW", admin_level: 5 }),
    signal: AbortSignal.timeout(60000),
  });

  const res = await adminBoundaries(req);

  expect(res.status).toBe(200);

  const data = await res.json() as any;
  console.log("Returned payload keys:", Object.keys(data));

  expect(data.topojson).toBeDefined();
  expect(data.country_code).toBe("MW");
  expect(data.admin_level).toBe(5);
  expect(data.feature_count > 0).toBe(true);
}, 60000);

test("adminBoundaries - Fails validation with invalid country code", async () => {
  const req = new Request("http://localhost/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ country_code: "INVALID", admin_level: 2 }),
  });

  const res = await adminBoundaries(req);

  expect(res.status).toBe(400);
});

test("adminBoundaries - Fails validation with invalid admin_level", async () => {
  const req = new Request("http://localhost/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ country_code: "MW", admin_level: 10 }), // 10 is invalid
  });

  const res = await adminBoundaries(req);
  expect(res.status).toBe(400);
});
