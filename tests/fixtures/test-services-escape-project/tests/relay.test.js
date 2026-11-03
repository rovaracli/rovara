"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// tools/start-heartbeat.js (the project's setup command) leaves a detached process running in the WORKING sandbox that rewrites this file every 200 ms. During a sealed round the working sandbox is frozen, so the file
// must not change: if it does, a process left behind in the working sandbox is alive during the round and could relay workspace files out.
const file = process.env.ESCAPE_HEARTBEAT_FILE || path.join(process.cwd(), ".escape-heartbeat");

test("a process left running in the working sandbox does not run during the sealed round", async (t) => {
  if (!fs.existsSync(file)) {
    if (process.env.ESCAPE_REQUIRE_HEARTBEAT === "1") assert.fail("the heartbeat was never started: the project's setup command did not run");
    t.skip("no heartbeat file: the setup command did not run in this workspace");
    return;
  }
  const first = fs.readFileSync(file, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const second = fs.readFileSync(file, "utf8");
  assert.equal(second, first, "the heartbeat moved: the working sandbox is not frozen during the round");
});
