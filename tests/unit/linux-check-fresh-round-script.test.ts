// TE-B1-fresh: scripts/linux-check-fresh-round.sh, hermetically. A fake `docker` plays a daemon; `nft`, `ip6tables`, `ip` and `iptables` are fakes that fail loudly if the script ever calls them. The `docker run` arguments the script uses must
// pass the very allow-list the worker's round is judged by (freshSandboxArgProblems), so the Linux check and the code cannot drift apart. The live proof is the script run on a real Linux daemon (the report names it).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshSandboxArgProblems } from "../../packages/worker/src/fresh-check-sandbox.js";

const NODE_DIR = dirname(process.execPath);
const SCRIPT = new URL("../../scripts/linux-check-fresh-round.sh", import.meta.url).pathname;
let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "fresh-script-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Fake tools in `dir/bin`. `docker` logs its arguments (one JSON array a line) and answers by verb; `visible` makes `docker exec ... test -e <path>` succeed (a sandbox that can see the working root). */
function fakeTools(options: { visible?: boolean; rootUid?: string } = {}) {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "docker.log");
  const forbidden = join(dir, "forbidden.log");
  for (const tool of ["nft", "ip6tables", "ip", "iptables"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho ${tool} >> '${forbidden}'\nexit 99\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const verb = args[0];
const out = (text, code = 0) => { process.stdout.write(text); process.exit(code); };
if (verb === "network" && args[1] === "inspect") { if (args.includes("--format")) out("false\\n"); out("[]\\n"); }
if (verb === "network") out("");
if (verb === "inspect") out(args.join(" ").includes("IPAddress") ? (args.some((a) => a.endsWith("-open-a")) ? "172.30.9.2\\n" : "172.30.0.2\\n") : args.some((a) => a.includes("range")) ? "agentx-task\\n" : "");
if (verb === "container" && args[1] === "inspect") process.exit(1);
if (verb === "exec") {
  const text = args.join(" ");
  if (args.includes("--detach")) out("");
  if (text.includes("id -u")) out(${JSON.stringify(options.rootUid ?? "1000")} + "\\n");
  if (text.includes("CapEff")) out("CapEff:0000000000000000\\n");
  if (text.includes("NoNewPrivs")) out("NoNewPrivs:1\\n");
  if (/ test -e /.test(text)) process.exit(${options.visible === true ? 0 : 1});
  if (/ ls -A /.test(text)) out("repo\\n");
  if (/ cat /.test(text)) out("committed\\n");
  if (/ pwd/.test(text)) out(args[args.length - 1] === "pwd" ? process.env.FAKE_ROOT + "\\n" : "");
  if (text.includes(".connect(") && text.includes("127.0.0.1")) out("CONNECTED\\n");
  if (text.includes(".connect(") && text.includes("172.30.0.2")) { process.stdout.write(""); process.exit(0); }
  if (text.includes(".connect(") && text.includes("172.30.9.2")) out("CONNECTED\\n");
  if (text.includes(".connect(")) out("");
  out("");
}
out("");
`);
  chmodSync(join(bin, "docker"), 0o755);
  return { bin, log, forbidden };
}

function run(tools: ReturnType<typeof fakeTools>, extra: Record<string, string> = {}) {
  const base = join(dir, "base");
  mkdirSync(base);
  const result = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { PATH: `${tools.bin}:${NODE_DIR}:/usr/bin:/bin`, FRESH_IMAGE: "worker:img", FRESH_BASE: base, FAKE_ROOT: join(base, "workspace"), FRESH_SETTLE_SECONDS: "0", HOME: dir, ...extra } });
  return { ...result, base };
}
const dockerCalls = (log: string): string[][] => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);

describe("scripts/linux-check-fresh-round.sh", () => {
  it("never calls nft, ip6tables, ip or iptables, makes only docker calls, and its `docker run` passes the worker's allow-list", () => {
    const tools = fakeTools();
    const result = run(tools);
    expect(existsSync(tools.forbidden)).toBe(false);
    const runs = dockerCalls(tools.log).filter((args) => args[0] === "run" && args.includes("rovara.check-round=fresh"));
    expect(runs).toHaveLength(1);
    const args = runs[0]!;
    const value = (flag: string) => args[args.indexOf(flag) + 1]!;
    const [source, target] = value("--volume").split(":") as [string, string];
    expect(freshSandboxArgProblems(args, { name: value("--name"), taskId: "linuxcheck", image: "worker:img", rootPath: target, exportDirectory: source, environment: {} })).toEqual([]);
    expect(result.stdout).toContain("FRESH SUMMARY");
  });
  it("every line passes when the sandbox sees only the export", () => {
    const result = run(fakeTools());
    expect(result.stdout.split("\n").filter((line) => line.startsWith("FRESH FR")).map((line) => line.split(" ").slice(1, 3).join(" "))).toEqual(["FR1 PASS", "FR2 PASS", "FR3 PASS", "FR4 PASS", "FR5 PASS", "FR6 PASS"]);
    expect(result.status).toBe(0);
  });
  it("FAILS (exit 1) when the sandbox can see the working root", () => {
    const result = run(fakeTools({ visible: true }));
    expect(result.stdout).toMatch(/FRESH FR2 FAIL/u);
    expect(result.status).toBe(1);
  });
  it("FAILS when the sandbox runs as root", () => {
    const result = run(fakeTools({ rootUid: "0" }));
    expect(result.stdout).toMatch(/FRESH FR1 FAIL/u);
    expect(result.status).toBe(1);
  });
  it("refuses to run without an image, and removes its scratch directory", () => {
    const tools = fakeTools();
    const noImage = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { PATH: `${tools.bin}:${NODE_DIR}:/usr/bin:/bin`, HOME: dir } });
    expect(noImage.status).toBe(2);
    const result = run(tools);
    expect(existsSync(join(result.base, "workspace"))).toBe(false);
  });
});
