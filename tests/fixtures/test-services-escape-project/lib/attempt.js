"use strict";
// One TCP connection attempt, with a verdict in fixed words: "connected" | "refused" | "timeout" | "unreachable" | "error".
// "refused" means something ANSWERED (a reset came back from the address), so for an address that must be silent it counts as REACHED: `reached(verdict)`. For a public address a refusal cannot come from the real host, so the
// internet and IPv6 tests keep to "connected" alone (`connected(verdict)`).
const net = require("node:net");
const { setting } = require("./fixture.js");

function tryConnect(host, port, { timeoutMs } = {}) {
  const limit = timeoutMs ?? (Number(setting("ESCAPE_CONNECT_TIMEOUT_MS")) || 3000);
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (verdict) => { if (!done) { done = true; socket.destroy(); resolve(verdict); } };
    socket.setTimeout(limit, () => finish("timeout"));
    socket.once("connect", () => finish("connected"));
    socket.once("error", (error) => {
      const code = error && error.code;
      finish(code === "ECONNREFUSED" ? "refused" : code === "ENETUNREACH" || code === "EHOSTUNREACH" || code === "ENOTFOUND" || code === "EADDRNOTAVAIL" ? "unreachable" : "error");
    });
  });
}
const connected = (verdict) => verdict === "connected";
const reached = (verdict) => verdict === "connected" || verdict === "refused";

module.exports = { tryConnect, connected, reached };
