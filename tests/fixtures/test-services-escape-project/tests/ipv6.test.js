"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { tryConnect } = require("../lib/attempt.js");
const { ipv6Targets } = require("../lib/targets.js");

test("no public IPv6 address can be reached", async () => {
  const reached = [];
  for (const { host, port } of ipv6Targets()) {
    if ((await tryConnect(host, port)) === "connected") reached.push(`[${host}]:${port}`);
  }
  assert.deepEqual(reached, []);
});

test("no global IPv6 address is configured on any interface", () => {
  if (process.env.ESCAPE_SKIP_IFACES === "1") return;
  const global = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family === "IPv6" && !entry.internal && !entry.address.toLowerCase().startsWith("fe80:")) global.push(name);
    }
  }
  assert.deepEqual(global, []);
});
