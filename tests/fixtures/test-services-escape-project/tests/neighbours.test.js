"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { tryConnect } = require("../lib/attempt.js");
const { neighbourTargets } = require("../lib/targets.js");

test("the working sandbox's address, the gateway and the metadata address cannot be reached", async () => {
  const reached = [];
  for (const { host, port } of neighbourTargets()) {
    if ((await tryConnect(host, port)) === "connected") reached.push(`${host}:${port}`);
  }
  assert.deepEqual(reached, []);
});

test("positive control: the run's own Postgres IS reachable (so the refusals above are not a dead network)", async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url, "the run gave this check no DATABASE_URL");
  const parsed = new URL(url);
  assert.equal(await tryConnect(parsed.hostname, Number(parsed.port || 5432)), "connected");
});
