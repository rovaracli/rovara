"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { tryConnect, reached } = require("../lib/attempt.js");
const { neighbourTargets } = require("../lib/targets.js");
const { heartbeatFile, readJson } = require("../lib/state.js");

// For the working sandbox's address and the gateway, ANY answer is reaching them: a connection, or a reset ("refused") from a host that is there. Only a silent address (timeout, no route) passes.
test("the gateway and the addresses next to the check sandbox cannot be reached (a refusal counts as reached)", async () => {
  const { targets, problem } = neighbourTargets();
  assert.equal(problem, undefined, String(problem));
  assert.ok(targets.length > 0, "no neighbour to try");
  const reachedTargets = [];
  for (const { host, port, refusedCounts } of targets) {
    const verdict = await tryConnect(host, port);
    if (verdict === "connected" || (refusedCounts && reached(verdict))) reachedTargets.push(`${host}:${port} (${verdict})`);
  }
  assert.deepEqual(reachedTargets, []);
});

// The working sandbox sits on its OWN working-phase network, and its heartbeat LISTENS on a port there (tools/heartbeat.js records the address and port). A listening service that the sealed round cannot connect to, and does not
// even get a refusal from, is the proof that the working sandbox cannot be reached; the same test against a dead heartbeat would also pass, which is why relay.test.js fails a heartbeat that was not alive.
test("the working sandbox's listening heartbeat cannot be reached from the sealed round", async () => {
  const state = readJson(heartbeatFile());
  assert.ok(state && typeof state.ip === "string" && Number.isInteger(state.port), "no heartbeat address: the working phase never started the heartbeat, so the working sandbox was not probed");
  const verdict = await tryConnect(state.ip, state.port);
  assert.ok(!reached(verdict), `the working sandbox's heartbeat answered (${verdict})`);
});

test("positive control: the run's own Postgres IS reachable (so the silence above is not a dead network)", async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url, "the run gave this check no DATABASE_URL");
  const parsed = new URL(url);
  assert.equal(await tryConnect(parsed.hostname, Number(parsed.port || 5432)), "connected");
});
