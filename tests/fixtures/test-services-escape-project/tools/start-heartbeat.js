"use strict";
// The project's setup command: leaves a detached process running in the working sandbox, as an agent or a seed could, and waits until it is really up (it fails if the heartbeat never starts, so a run that skipped this
// cannot look fine). The sealed round's tests then check that it was alive, is listening, and is frozen while the round runs.
const { spawn } = require("node:child_process");
const path = require("node:path");
const { heartbeatFile, readJson } = require("../lib/state.js");

const child = spawn(process.execPath, [path.join(__dirname, "heartbeat.js")], { detached: true, stdio: "ignore", cwd: process.cwd(), env: process.env });
child.unref();
const deadline = Date.now() + 10_000;
const wait = () => {
  const state = readJson(heartbeatFile());
  if (state && state.ticks >= 2 && Number.isInteger(state.port)) { console.log(`OK heartbeat up, listening on ${state.ip}:${state.port}`); process.exit(0); }
  if (Date.now() > deadline) { console.error("the heartbeat did not start"); process.exit(1); }
  setTimeout(wait, 100);
};
wait();
