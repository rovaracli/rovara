"use strict";
// The emulator's control paths (/_rovara/seed, /reset, /ledger/summary) belong to the worker alone. From the sealed round they must be REFUSED: 403 (or 401) with no token and with a made-up one. A control path that answers
// 2xx, or answers with anything else (a 404 would only mean the path is not there), FAILS. The emulator must be up for the control test to mean anything: its health path answers first.
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { endpoint, call } = require("../lib/aws-http.js");

const CONTROL = [
  { method: "GET", path: "/_rovara/ledger/summary" },
  { method: "GET", path: "/_rovara/ledger" },
  { method: "POST", path: "/_rovara/seed", body: "{}" },
  { method: "POST", path: "/_rovara/reset", body: "{}" },
];
const refused = (answer) => answer.status === 403 || answer.status === 401;

test("the emulator is up (its health path answers), so a refusal below is a refusal and not an absence", async () => {
  const url = endpoint();
  assert.ok(url, "the run gave this check no AWS_ENDPOINT_URL_S3: there is no emulator to test");
  const health = await call(url, { path: "/_rovara/health" });
  assert.equal(health.status, 200, `the health path answered ${health.status ?? health.error}`);
});

test("every control path is refused from the sealed round, with no token and with a made-up one", async () => {
  const url = endpoint();
  assert.ok(url, "the run gave this check no AWS_ENDPOINT_URL_S3: there is no emulator to test");
  const wrong = randomBytes(24).toString("hex");
  const bad = [];
  for (const item of CONTROL) {
    for (const headers of [{}, { "x-rovara-control-token": wrong }, { authorization: `Bearer ${wrong}` }]) {
      const answer = await call(url, { ...item, headers: { ...headers, ...(item.body ? { "content-type": "application/json" } : {}) } });
      if (!refused(answer)) bad.push(`${item.method} ${item.path} (${Object.keys(headers)[0] || "no token"}): ${answer.status ?? answer.error}`);
    }
  }
  assert.deepEqual(bad, [], "a control path was not refused with 403 or 401");
});

test("a refusal carries nothing of the ledger or the seed (no counters, no resource names)", async () => {
  const url = endpoint();
  assert.ok(url, "the run gave this check no AWS_ENDPOINT_URL_S3: there is no emulator to test");
  const answer = await call(url, { path: "/_rovara/ledger/summary" });
  assert.ok(refused(answer), `the ledger summary answered ${answer.status ?? answer.error}`);
  assert.doesNotMatch(answer.body, /"calls"|orders-archive|order-events|"operations"/u);
});
