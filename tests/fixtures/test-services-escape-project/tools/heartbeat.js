"use strict";
// The detached process the working phase leaves behind. It (1) LISTENS on a port of the working sandbox's address, so the sealed round's neighbour test has a real service to fail to reach, and (2) rewrites its state file every
// 200 ms with a counter and a timestamp, so the sealed round can tell it was alive in the working phase (a dead heartbeat FAILS the round) and that it does not move while the working sandbox is frozen.
const fs = require("node:fs");
const net = require("node:net");
const { heartbeatFile } = require("../lib/state.js");
const { ownPrefix } = require("../lib/targets.js");

const file = heartbeatFile();
const server = net.createServer((socket) => socket.destroy());
server.on("error", () => process.exit(1));
server.listen(0, "0.0.0.0", () => {
  const port = server.address().port;
  const ip = (ownPrefix() || { address: "127.0.0.1" }).address;
  const startedAt = Date.now();
  let ticks = 0;
  const write = () => {
    ticks += 1;
    try {
      fs.writeFileSync(file + ".tmp", JSON.stringify({ pid: process.pid, startedAt, ticks, lastTick: Date.now(), ip, port }) + "\n");
      fs.renameSync(file + ".tmp", file);
    } catch { /* the workspace is gone */ }
  };
  write();
  setInterval(write, 200);
});
