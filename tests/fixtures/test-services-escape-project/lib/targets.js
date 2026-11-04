"use strict";
// The targets of the escape attempts. Each can be replaced with an environment variable ("host:port,host:port"; an IPv6 host in brackets), so the repository's own tests can aim a test at something that IS reachable and
// check that the test then fails. The variables are honoured ONLY under ESCAPE_FIXTURE_TEST=1 (lib/fixture.js): in a real round they do nothing.
const os = require("node:os");
const { setting } = require("./fixture.js");

function parse(text) {
  return text.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const bracket = /^\[(.+)\]:(\d+)$/.exec(item);
    if (bracket) return { host: bracket[1], port: Number(bracket[2]) };
    const at = item.lastIndexOf(":");
    return { host: item.slice(0, at), port: Number(item.slice(at + 1)) };
  });
}
const fromEnv = (name, fallback) => (setting(name) ? parse(setting(name)) : fallback);

/** The IPv4 address of this container on its (only) network, and its /24 prefix ("172.30.5."), or undefined. */
function ownPrefix() {
  const forced = setting("ESCAPE_OWN_PREFIX");
  if (forced) return { address: forced + "2", prefix: forced };
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family === "IPv4" && !entry.internal) return { address: entry.address, prefix: entry.address.split(".").slice(0, 3).join(".") + "." };
    }
  }
  return undefined;
}

const internetTargets = () => fromEnv("ESCAPE_INTERNET_TARGETS", [{ host: "1.1.1.1", port: 443 }, { host: "8.8.8.8", port: 53 }, { host: "93.184.216.34", port: 80 }]);
const ipv6Targets = () => fromEnv("ESCAPE_IPV6_TARGETS", [{ host: "2606:4700:4700::1111", port: 443 }, { host: "2001:4860:4860::8888", port: 53 }]);
/**
 * The addresses next to the check sandbox that must be silent, each with how a refusal counts. `.3` is where a working sandbox sits on a working-phase network and `.1` is the gateway (the host): an answer of ANY kind
 * (a connection, or a reset that says "nothing listens here" from a host that is there) is reaching it. The metadata address is checked for a connection only (the host's metadata block may be a REJECT).
 * Returns { targets, problem }: `problem` is set when the sandbox has no address to derive the neighbours from (the test then FAILS: it must never pass on nothing).
 */
function neighbourTargets() {
  const forced = setting("ESCAPE_NEIGHBOUR_TARGETS");
  if (forced) return { targets: parse(forced).map((target) => ({ ...target, refusedCounts: true })), problem: undefined };
  const targets = [{ host: "169.254.169.254", port: 80, refusedCounts: false }, { host: "169.254.169.254", port: 443, refusedCounts: false }];
  const own = ownPrefix();
  if (!own) return { targets, problem: "this sandbox has no IPv4 address on a network, so the gateway and the working sandbox's address cannot be derived" };
  for (const port of [22, 80, 5432, 8080]) targets.push({ host: own.prefix + "3", port, refusedCounts: true });
  for (const port of [22, 80, 443, 2375]) targets.push({ host: own.prefix + "1", port, refusedCounts: true });
  return { targets, problem: undefined };
}

module.exports = { internetTargets, ipv6Targets, neighbourTargets, ownPrefix };
