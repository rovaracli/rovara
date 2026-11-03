"use strict";
// The project's setup command: leaves a detached process running in the working sandbox, as an agent or a seed could. The sealed round's relay test checks that it is frozen while the round runs.
const { spawn } = require("node:child_process");
const path = require("node:path");

const child = spawn(process.execPath, [path.join(__dirname, "heartbeat.js")], { detached: true, stdio: "ignore", cwd: process.cwd(), env: process.env });
child.unref();
