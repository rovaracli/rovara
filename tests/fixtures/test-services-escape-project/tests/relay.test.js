"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { heartbeatFile, readJson } = require("../lib/state.js");
const { setting } = require("../lib/fixture.js");

// tools/start-heartbeat.js (the project's setup command, run in the WORKING phase) leaves a detached process running in the working sandbox that rewrites its state file every 200 ms. During a sealed round the working
// sandbox is frozen, so (1) the heartbeat must have been alive and ticking up to just before the round (a heartbeat that never started, or died, is a FAILURE, not a pass: otherwise "frozen" is true of a dead process),
// and (2) the file must not change while the round runs: if it does, a process left behind in the working sandbox is running during the round and could relay workspace files out.
const MAX_AGE_MS = Number(setting("ESCAPE_HEARTBEAT_MAX_AGE_MS")) || 5 * 60 * 1000;

test("liveness control: the heartbeat was alive in the working phase, up to just before the round", () => {
  const state = readJson(heartbeatFile());
  assert.ok(state, "no heartbeat state: the working phase never ran `npm run setup`, or the heartbeat died");
  assert.ok(Number.isInteger(state.ticks) && state.ticks >= 5, `the heartbeat only ticked ${String(state.ticks)} time(s): it was not alive in the working phase`);
  assert.ok(Number.isInteger(state.port) && state.port > 0, "the heartbeat is not listening on a port");
  const age = Date.now() - state.lastTick;
  assert.ok(age >= 0 && age <= MAX_AGE_MS, `the heartbeat's last tick is ${String(Math.round(age / 1000))}s old: it died before the round (a frozen process would have ticked a moment ago)`);
});

test("a process left running in the working sandbox does not run during the sealed round", async () => {
  const file = heartbeatFile();
  assert.ok(fs.existsSync(file), "no heartbeat file: the working phase never started the heartbeat");
  const first = fs.readFileSync(file, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const second = fs.readFileSync(file, "utf8");
  assert.equal(second, first, "the heartbeat moved: the working sandbox is not frozen during the round");
});
