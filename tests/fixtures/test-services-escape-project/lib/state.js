"use strict";
// Where the working phase leaves its marks for the sealed round to find (both are plain files in the workspace, which the sealed round sees):
//   .escape-heartbeat.json   written by tools/heartbeat.js every 200 ms: { pid, startedAt, ticks, lastTick, ip, port }. The heartbeat also LISTENS on `port` of `ip` (the working sandbox's address on its working-phase network).
//   .escape-plant.json       written by tools/plant.js: { at, objects } what the working phase planted in the working-phase Postgres.
const fs = require("node:fs");
const path = require("node:path");
const { setting } = require("./fixture.js");

const heartbeatFile = () => setting("ESCAPE_HEARTBEAT_FILE") || path.join(process.cwd(), ".escape-heartbeat.json");
const plantFile = () => setting("ESCAPE_PLANT_FILE") || path.join(process.cwd(), ".escape-plant.json");

/** The parsed file, or undefined when it is missing or not JSON. */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
}

module.exports = { heartbeatFile, plantFile, readJson };
