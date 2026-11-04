"use strict";
// Name lookups, the way the sealed round's own resolver answers them. In a real round this is the system resolver (the sealed round's only name server is its own helper). The fixture tests point it at a name server of their
// own with ESCAPE_DNS_SERVER ("127.0.0.1:port"), so the assertions are run against real DNS answers.
const dns = require("node:dns").promises;
const { setting } = require("./fixture.js");

/** The IPv4 addresses of `name`, sorted; rejects (ENOTFOUND and the like) when the name does not resolve. */
async function resolve4(name) {
  const server = setting("ESCAPE_DNS_SERVER");
  const addresses = server === undefined
    ? (await dns.lookup(name, { all: true, family: 4 })).map((entry) => entry.address)
    : await (() => { const resolver = new dns.Resolver({ timeout: 1000, tries: 1 }); resolver.setServers([server]); return resolver.resolve4(name); })();
  return [...addresses].sort();
}

module.exports = { resolve4 };
