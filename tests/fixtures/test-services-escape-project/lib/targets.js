"use strict";
// The targets of the escape attempts. Each can be replaced with an environment variable ("host:port,host:port"; an IPv6 host in brackets), so the repository's own tests can aim a test at something that IS reachable and
// check that the test then fails.
const os = require("node:os");

function parse(text) {
  return text.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const bracket = /^\[(.+)\]:(\d+)$/.exec(item);
    if (bracket) return { host: bracket[1], port: Number(bracket[2]) };
    const at = item.lastIndexOf(":");
    return { host: item.slice(0, at), port: Number(item.slice(at + 1)) };
  });
}
const fromEnv = (name, fallback) => (process.env[name] ? parse(process.env[name]) : fallback);

/** The IPv4 address of this container on its (only) network, and its /24 prefix ("172.30.5."), or undefined. */
function ownPrefix() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list || []) {
      if (entry.family === "IPv4" && !entry.internal) return { address: entry.address, prefix: entry.address.split(".").slice(0, 3).join(".") + "." };
    }
  }
  return undefined;
}

const internetTargets = () => fromEnv("ESCAPE_INTERNET_TARGETS", [{ host: "1.1.1.1", port: 443 }, { host: "8.8.8.8", port: 53 }, { host: "93.184.216.34", port: 80 }]);
const ipv6Targets = () => fromEnv("ESCAPE_IPV6_TARGETS", [{ host: "2606:4700:4700::1111", port: 443 }, { host: "2001:4860:4860::8888", port: 53 }]);
function neighbourTargets() {
  if (process.env.ESCAPE_NEIGHBOUR_TARGETS) return parse(process.env.ESCAPE_NEIGHBOUR_TARGETS);
  const own = ownPrefix();
  const targets = [{ host: "169.254.169.254", port: 80 }, { host: "169.254.169.254", port: 443 }];
  if (own) {
    // .3 is where the WORKING sandbox sits on a working-phase network; .1 is the gateway (the host).
    for (const port of [22, 80, 5432, 8080]) targets.push({ host: own.prefix + "3", port });
    for (const port of [22, 80, 443, 2375]) targets.push({ host: own.prefix + "1", port });
  }
  return targets;
}

module.exports = { internetTargets, ipv6Targets, neighbourTargets, ownPrefix };
