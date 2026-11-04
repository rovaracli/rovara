"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { tryConnect, connected } = require("../lib/attempt.js");
const { internetTargets, ownPrefix } = require("../lib/targets.js");
const { resolve4 } = require("../lib/resolve.js");
const { setting } = require("../lib/fixture.js");

test("no public IPv4 address can be reached from the sealed round", async () => {
  const reachedTargets = [];
  for (const { host, port } of internetTargets()) {
    if (connected(await tryConnect(host, port))) reachedTargets.push(`${host}:${port}`);
  }
  assert.deepEqual(reachedTargets, [], "the sealed round reached the internet");
});

// The sealed round's only name server is its own helper: it answers the round's own names (the dependencies and "sinkhole") and answers EVERY other name with the sinkhole's address, which counts the name. So a public name must
// resolve to exactly the sinkhole's address, inside this run's network. A lookup that fails, or that returns anything else, is wrong: failing is not passing.
const within = (addresses, prefix) => addresses.length > 0 && addresses.every((address) => address.startsWith(prefix));

test("DNS: a public name and an unknown name both resolve to the sinkhole's address, and nothing else", async () => {
  const own = ownPrefix();
  assert.ok(own, "this sandbox has no IPv4 address on a network");
  const sinkhole = await resolve4("sinkhole").catch((error) => assert.fail(`the run's own sinkhole name does not resolve: ${String(error && error.code)}`));
  assert.ok(within(sinkhole, own.prefix), `the sinkhole name resolved outside the run's network: ${sinkhole.join(",")}`);
  const unknown = `unknown-${Math.random().toString(36).slice(2, 10)}.example.net`;
  for (const name of [setting("ESCAPE_PUBLIC_NAME") || "example.com", unknown]) {
    const addresses = await resolve4(name).catch((error) => assert.fail(`${name} did not resolve (${String(error && error.code)}): the round's resolver should answer every name with the sinkhole`));
    assert.deepEqual(addresses, sinkhole, `${name} did not resolve to the sinkhole`);
  }
});

test("DNS positive control: the round's own dependency name resolves to a helper in this run's network (so the resolver works, and the sinkhole above is a choice, not a dead resolver)", async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url, "the run gave this check no DATABASE_URL");
  const host = new URL(url).hostname;
  assert.ok(!/^[0-9.]+$/u.test(host), "DATABASE_URL names the database by address; the control needs its alias");
  const own = ownPrefix();
  assert.ok(own, "this sandbox has no IPv4 address on a network");
  const addresses = await resolve4(host).catch((error) => assert.fail(`the round's own alias ${host} does not resolve (${String(error && error.code)})`));
  assert.ok(within(addresses, own.prefix), `${host} resolved outside the run's network: ${addresses.join(",")}`);
  const sinkhole = await resolve4("sinkhole").catch(() => []);
  assert.notDeepEqual(addresses, sinkhole, `${host} resolved to the sinkhole: the table has no entry for the dependency`);
});
