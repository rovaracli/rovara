"use strict";
// One TCP connection attempt, with a verdict in fixed words: "connected" | "refused" | "timeout" | "unreachable" | "error".
const net = require("node:net");

function tryConnect(host, port, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (verdict) => { if (!done) { done = true; socket.destroy(); resolve(verdict); } };
    socket.setTimeout(timeoutMs, () => finish("timeout"));
    socket.once("connect", () => finish("connected"));
    socket.once("error", (error) => {
      const code = error && error.code;
      finish(code === "ECONNREFUSED" ? "refused" : code === "ENETUNREACH" || code === "EHOSTUNREACH" || code === "ENOTFOUND" || code === "EADDRNOTAVAIL" ? "unreachable" : "error");
    });
  });
}

module.exports = { tryConnect };
