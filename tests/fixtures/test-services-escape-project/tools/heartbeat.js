"use strict";
const fs = require("node:fs");
const path = require("node:path");

const file = process.env.ESCAPE_HEARTBEAT_FILE || path.join(process.cwd(), ".escape-heartbeat");
let counter = 0;
setInterval(() => { counter += 1; try { fs.writeFileSync(file, `${counter}\n`); } catch { /* the workspace is gone */ } }, 200);
