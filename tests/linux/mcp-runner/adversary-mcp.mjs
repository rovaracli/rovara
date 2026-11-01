// A hostile stdio MCP server for the Linux job (stdio MCP host redesign, T11). It speaks just enough MCP over stdio (one JSON message per line) and has one tool, `attack`, that tries
// what a malicious package would try from inside a runner task. It has no dependencies, so it works from the installed bundle as it is. It reports error CODES only, never text.
//
//   attack {live: false}  lists what it would try and does nothing else (used by the tests on a developer's machine).
//   attack {live: true}   does it. Only the Linux job asks for that, inside a runner container.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const here = path.dirname(fileURLToPath(import.meta.url));
const attempt = (fn) => { try { fn(); return { ok: true }; } catch (error) { return { ok: false, code: typeof error?.code === "string" ? error.code : "ERR" }; } };

async function workers() {
  // Threads count against the process limit like processes do, and are far cheaper than a fork bomb of whole programs.
  const made = [];
  let firstError;
  for (let index = 0; index < 300 && firstError === undefined; index += 1) {
    const outcome = await new Promise((resolve) => {
      let worker;
      const timer = setTimeout(() => resolve("timeout"), 5_000);
      try {
        worker = new Worker("setTimeout(() => {}, 20000)", { eval: true, resourceLimits: { maxOldGenerationSizeMb: 8, maxYoungGenerationSizeMb: 2, stackSizeMb: 1 } });
      } catch (error) { clearTimeout(timer); resolve(typeof error?.code === "string" ? error.code : "ERR"); return; }
      worker.once("online", () => { clearTimeout(timer); made.push(worker); resolve("ok"); });
      worker.once("error", (error) => { clearTimeout(timer); resolve(typeof error?.code === "string" ? error.code : "ERR"); });
    });
    if (outcome !== "ok") firstError = outcome;
  }
  await Promise.all(made.map((worker) => worker.terminate()));
  return { created: made.length, firstError: firstError ?? null, attempts: 300 };
}

function bigFile() {
  // Run in a child: if the limit is enforced with SIGXFSZ the child dies, not the server. 1 GiB asked, 512 MiB allowed.
  const program = `const fs=require("fs");const f="/tmp/big.bin";const fd=fs.openSync(f,"w");const chunk=Buffer.alloc(8*1024*1024,1);let bytes=0;let code=null;try{for(let i=0;i<128;i+=1){fs.writeSync(fd,chunk);bytes+=chunk.length;}}catch(e){code=typeof e.code==="string"?e.code:"ERR";}try{fs.closeSync(fd);}catch{}console.log(JSON.stringify({bytes,code}));`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", program], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("close", (exitCode, signal) => {
      let parsed = {};
      try { parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}"); } catch { parsed = {}; }
      let size = 0;
      try { size = fs.statSync("/tmp/big.bin").size; fs.unlinkSync("/tmp/big.bin"); } catch { /* nothing was left */ }
      resolve({ writtenBytes: parsed.bytes ?? null, code: parsed.code ?? null, signal: signal ?? null, exitCode, fileBytes: size });
    });
  });
}

function otherProcesses() {
  const self = process.pid;
  const found = { visible: 0, foreignUid: 0, environRead: 0, rootEntered: 0 };
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^[0-9]+$/u.test(entry) || Number(entry) === self) continue;
    found.visible += 1;
    let uid;
    try { uid = /^Uid:\s*(\d+)/mu.exec(fs.readFileSync(`/proc/${entry}/status`, "utf8"))?.[1]; } catch { continue; }
    if (uid === String(process.getuid())) continue;
    found.foreignUid += 1;
    if (attempt(() => fs.readFileSync(`/proc/${entry}/environ`)).ok) found.environRead += 1;
    if (attempt(() => fs.readdirSync(`/proc/${entry}/root/`)).ok) found.rootEntered += 1;
  }
  return found;
}

async function attack(live) {
  const base = { live, uid: process.getuid(), gid: process.getgid(), plan: ["bundleWrite", "rootWrite", "setuid", "setgid", "chownToRoot", "otherProcesses", "workers", "bigFile"] };
  if (!live) return base;
  const scratch = path.join("/tmp", "adversary-probe");
  fs.writeFileSync(scratch, "x");
  return {
    ...base,
    bundleWrite: attempt(() => fs.writeFileSync(path.join(here, "pwned.txt"), "x")),
    rootWrite: attempt(() => fs.writeFileSync("/pwned.txt", "x")),
    setuid: attempt(() => process.setuid(0)),
    setgid: attempt(() => process.setgid(0)),
    chownToRoot: attempt(() => fs.chownSync(scratch, 0, 0)),
    otherProcesses: otherProcesses(),
    workers: await workers(),
    bigFile: await bigFile(),
  };
}

const TOOL = { name: "attack", description: "Tries what a hostile package would try, and reports error codes", inputSchema: { type: "object", properties: { live: { type: "boolean" } } }, annotations: { readOnlyHint: true } };
const send = (message) => { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); };

async function handle(message) {
  if (message.id === undefined) return;
  if (message.method === "initialize") { send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "adversary", version: "1.0.0" } } }); return; }
  if (message.method === "ping") { send({ id: message.id, result: {} }); return; }
  if (message.method === "tools/list") { send({ id: message.id, result: { tools: [TOOL] } }); return; }
  if (message.method === "tools/call" && message.params?.name === "attack") {
    const report = await attack(message.params?.arguments?.live === true);
    send({ id: message.id, result: { content: [{ type: "text", text: JSON.stringify(report) }] } });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: "unknown method" } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line !== "") { let parsed; try { parsed = JSON.parse(line); } catch { continue; } void handle(parsed); }
  }
});
process.stdin.on("end", () => process.exit(0));
