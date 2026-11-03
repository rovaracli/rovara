"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const dns = require("node:dns").promises;
const { tryConnect } = require("../lib/attempt.js");
const { internetTargets } = require("../lib/targets.js");

test("no public IPv4 address can be reached from the sealed round", async () => {
  const reached = [];
  for (const { host, port } of internetTargets()) {
    const verdict = await tryConnect(host, port);
    if (verdict === "connected") reached.push(`${host}:${port}`);
  }
  assert.deepEqual(reached, [], "the sealed round reached the internet");
});

test("a public name does not resolve to a public address (it is the sinkhole or nothing)", async () => {
  if (process.env.ESCAPE_SKIP_DNS === "1") return;
  const name = process.env.ESCAPE_PUBLIC_NAME || "example.com";
  let addresses = [];
  try { addresses = (await dns.lookup(name, { all: true, family: 4 })).map((entry) => entry.address); } catch { addresses = []; }
  const isPrivate = (address) => /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
  assert.deepEqual(addresses.filter((address) => !isPrivate(address)), [], "a public name resolved to a public address");
});
