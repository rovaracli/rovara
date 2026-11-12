// Live test of the sandbox controller (slice 4, lane W1) against a real Docker with gVisor (runsc) and lane A1's real agent with AWS's python base image, inside the Linux VM. It is NOT part of CI. How to run it (from the repo root, on the Mac):
//   1. build the bundle:   node_modules/.bin/esbuild packages/worker/src/function-runner/index.ts --bundle --platform=node --target=node18 --format=esm --outfile=scripts/function-runner-live/.build/function-runner.mjs
//   2. register runsc once, in the VM (root Docker daemon, reloadable without a restart): add {"runtimes":{"runsc":{"path":"<runsc binary>"}}} to /etc/docker/daemon.json, then `sudo systemctl reload docker`
//   3. run, in the VM only:  colima ssh -p <profile> -- bash -lc 'mkdir -p ~/w1live && cp <repo>/scripts/function-runner-live/{run-live.mjs,app.py,.build/function-runner.mjs} ~/w1live/ && (cd <local-aws repo>/runner/agent && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o ~/w1live/agent .) && cd ~/w1live && sudo node run-live.mjs'
// It pulls the AWS Lambda python base image if absent, runs app.py as the handler (the python runtime client unchanged, behind the agent), prints one PASS or FAIL line per check plus the measured numbers, and removes every container, network and
// folder it made (the image too when it pulled it). Exit code 1 when a check fails. Plain JavaScript for the VM's Node 18.
import { execFile, execFileSync } from "node:child_process";
import { setTimeout } from "node:timers";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createSandboxController, dockerRunLauncher, readCgroupMemoryPeak } from "./function-runner.mjs";

const IMAGE = process.env.LIVE_IMAGE ?? "public.ecr.aws/lambda/python:3.12-arm64";
const ROOT = `${process.cwd()}/work`;
const RUN_LABEL = "rovara.w1live";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const dockerSafe = (...args) => { try { return docker(...args); } catch (error) { return `ERR ${String(error.stderr ?? error)}`; } };
const control = {
  run: (args, options) => new Promise((resolve) => {
    execFile("docker", [...args], { timeout: options?.timeoutMs ?? 60_000, encoding: "utf8" }, (error, stdout, stderr) => resolve({ exitCode: error === null ? 0 : (typeof error.code === "number" ? error.code : -1), stdout, stderr }));
  }),
};

let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); };
const info = (name, value) => console.log(`INFO  ${name}  ${typeof value === "string" ? value : JSON.stringify(value)}`);
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const leftovers = () => docker("ps", "-a", "-q", "--filter", "label=rovara.function").trim().split("\n").filter(Boolean);

rmSync(ROOT, { recursive: true, force: true });
for (const dir of ["code", "layers", "net"]) mkdirSync(`${ROOT}/${dir}`, { recursive: true });
copyFileSync(`${process.cwd()}/app.py`, `${ROOT}/code/app.py`);
writeFileSync(`${ROOT}/layers/layer.txt`, "layer\n");
copyFileSync(`${process.cwd()}/agent`, `${ROOT}/agent`);
chmodSync(`${ROOT}/agent`, 0o755);
chmodSync(ROOT, 0o755);
const pulled = dockerSafe("image", "inspect", IMAGE).startsWith("ERR");
if (pulled) docker("pull", IMAGE);

const config = (change = {}) => ({
  runtime: "python3.12", handler: "app.handler", environment: { STAGE: "live", NEWLINE: "a --privileged -v /:/host b" }, region: "us-east-1", memoryMb: 256, timeoutSeconds: 5, ephemeralMb: 64, image: IMAGE,
  agentHostPath: `${ROOT}/agent`, codeHostPath: `${ROOT}/code`, layersHostPath: `${ROOT}/layers`, network: { mode: "none" }, maxConcurrency: 3, ...change,
});
const make = (options = {}) => createSandboxController({
  docker: control, launcher: dockerRunLauncher(), memoryBudgetMiB: 1024, scratchBaseDir: `${ROOT}/run`, labels: [{ key: RUN_LABEL, value: "1" }], readMemoryPeak: readCgroupMemoryPeak, autoReap: false, backstopMs: 500, ...options,
});
const KEY = { functionName: "live-fn", version: "1" };
const invoke = (runner, payload, extra = {}) => runner.invoke({ key: KEY, requestId: `req-${Math.random().toString(16).slice(2)}`, payload: JSON.stringify(payload), ...extra });
const body = (outcome) => (outcome.kind === "response" ? JSON.parse(outcome.payload.toString()) : undefined);

try {
  // ---- 1. cold, warm, what the sandbox looks like from the inside
  {
    const runner = make();
    await runner.register(KEY, config());
    const cold = await invoke(runner, { op: "echo", n: 1 });
    check("cold invoke answers through gVisor", cold.kind === "response" && body(cold).echo.n === 1, cold.kind === "response" ? { coldStartMs: cold.coldStartMs, wallMs: cold.wallMs } : cold);
    check("function runs as uid 993 with its environment (hostile text and all), and the reserved variables", body(cold)?.uid === 993 && body(cold)?.stage === "live" && body(cold)?.newline === "a --privileged -v /:/host b" && body(cold)?.memory === "256" && body(cold)?.function === "live-fn" && body(cold)?.handler === "app.handler", body(cold));
    check("the agent's log (START, output, END, REPORT) and report arrive", cold.kind === "response" && /START RequestId: req-/.test(cold.logTail) && cold.logTail.includes("op=echo") && /REPORT RequestId/.test(cold.logTail) && typeof cold.report?.durationMs === "number" && typeof cold.report?.initDurationMs === "number" && typeof cold.initLogTail === "string", cold.kind === "response" ? { report: cold.report, init: cold.initLogTail } : cold);
    const raised = await invoke(runner, { op: "raise" });
    check("a raised exception is a function error and the sandbox stays warm", raised.kind === "error" && raised.errorType === "ValueError" && raised.cold === false && raised.environmentId === cold.environmentId, raised.kind === "error" ? { errorType: raised.errorType, errorMessage: raised.errorMessage } : raised);
    check("cgroup peak memory is read host-side", cold.kind === "response" && typeof cold.maxMemoryUsedBytes === "number" && cold.maxMemoryUsedBytes > 1_000_000, cold.maxMemoryUsedBytes);
    const warmTimes = [];
    let allWarm = true;
    for (let i = 0; i < 20; i += 1) { const w = await invoke(runner, { op: "echo", n: i }); allWarm &&= w.kind === "response" && w.cold === false && w.environmentId === cold.environmentId; warmTimes.push(w.wallMs); }
    check("20 warm invokes reuse the same sandbox", allWarm);
    info("warm wall ms (median, max)", [median(warmTimes), Math.max(...warmTimes)]);
    const probe = body(await invoke(runner, { op: "probe" }));
    info("probe", probe);
    check("rootfs, /var/task, /opt and the agent are read-only", probe.write_root !== true && probe.write_var_task !== true && probe.write_opt !== true && probe.write_agent !== true, [probe.write_root, probe.write_var_task, probe.write_opt, probe.write_agent]);
    check("/tmp is a disk-backed folder, not a tmpfs (the default)", typeof probe.tmpMount === "string" && !/^tmpfs/.test(probe.tmpMount), probe.tmpMount);
    const psLines = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" }).split("\n").filter((line) => line.includes("docker run"));
    check("the function's variables are not in any docker client's arguments (ps)", psLines.length > 0 && psLines.every((line) => !line.includes("STAGE=live") && !line.includes("NEWLINE") && line.includes("--env-file")), psLines.map((line) => line.slice(0, 80)));
    check("/tmp is writable and executable", probe.write_tmp === true && probe.exec_tmp === true, [probe.write_tmp, probe.exec_tmp]);
    check("--network none: no interface but lo, no internet, no DNS", JSON.stringify(probe.interfaces) === JSON.stringify(["lo"]) && probe.connect_internet !== true && probe.dns !== true, [probe.interfaces, probe.connect_internet, probe.dns]);
    const capEff = probe.caps.find((c) => c.startsWith("CapEff:"));
    check("no capabilities and no-new-privileges", capEff !== undefined && /^0+$/.test(capEff.split(/\s+/)[1]) && probe.caps.some((c) => /NoNewPrivs:\s+1/.test(c)), probe.caps);
    const id = docker("ps", "-q", "--filter", "label=rovara.function").trim().split("\n")[0];
    const host = JSON.parse(docker("inspect", "--format", "{{json .HostConfig}}", id));
    check("docker holds runtime runsc, memory=swap=256m, pids 256, read-only, log none", host.Runtime === "runsc" && host.Memory === 256 * 1048576 && host.MemorySwap === 256 * 1048576 && host.PidsLimit === 256 && host.ReadonlyRootfs === true && host.LogConfig.Type === "none", { runtime: host.Runtime, memory: host.Memory, pids: host.PidsLimit, nanoCpus: host.NanoCpus });
    const forged = await invoke(runner, { op: "forge" });
    info("a function writing a frame onto the agent's stdout (/proc/1/fd/1)", forged.kind === "response" ? body(forged) : { kind: forged.kind, reason: forged.reason });
    check("a forged frame ends the sandbox as a protocol error, or the write is refused", (forged.kind === "unavailable" && forged.reason === "protocol_error") || (forged.kind === "response" && body(forged).forged !== true), forged.kind);
    const cold2 = await invoke(runner, { op: "echo" });
    check("the sandbox after that still works (warm, or cold if the forged frame ended it)", cold2.kind === "response");
    check("a stop is a barrier: nothing is left", (await runner.stopFunction(KEY)) === true && leftovers().length === 0 && runner.stats().reservedMiB === 0);
  }

  // ---- 2. cold start numbers
  {
    const times = [];
    for (let i = 0; i < 5; i += 1) {
      const runner = make();
      await runner.register(KEY, config());
      const out = await invoke(runner, { op: "echo" });
      times.push(out.kind === "response" ? [out.coldStartMs, out.wallMs] : [-1, -1]);
      await runner.stopFunction(KEY);
    }
    info("cold start ms (docker run to ready), wall ms (call incl. start), median of 5", { coldStartMs: median(times.map((t) => t[0])), wallMs: median(times.map((t) => t[1])), all: times });
  }

  // ---- 3. /tmp: tmpfs cap and what it costs in memory; then a host directory
  {
    const runner = make({ scratchKind: "tmpfs" });
    await runner.register(KEY, config({ ephemeralMb: 64, memoryMb: 512 }));
    const baseline = (await invoke(runner, { op: "echo" })).maxMemoryUsedBytes;
    const under = body(await invoke(runner, { op: "tmpwrite", mb: 32 }));
    check("tmpfs /tmp takes a file under its cap", under?.ok === true, under);
    const peakAfter32 = (await invoke(runner, { op: "echo" })).maxMemoryUsedBytes;
    const over = body(await invoke(runner, { op: "tmpwrite", mb: 100 }));
    check("tmpfs /tmp refuses a file over its cap (ENOSPC)", over?.ok === false && over.errno === 28, over);
    info("tmpfs: container peak memory before and after writing 32 MB of /tmp (bytes)", [baseline, peakAfter32]);
    await runner.stopFunction(KEY);
    const dirRunner = make();
    await dirRunner.register(KEY, config({ ephemeralMb: 64, memoryMb: 512 }));
    const warm = await invoke(dirRunner, { op: "echo" });
    const dirBaseline = warm.maxMemoryUsedBytes;
    const wrote = body(await invoke(dirRunner, { op: "tmpwrite", mb: 100 }));
    const peak = (await invoke(dirRunner, { op: "echo" })).maxMemoryUsedBytes;
    const files = readdirSync(`${ROOT}/run/tmp`);
    const onDisk = files.length === 1 && existsSync(`${ROOT}/run/tmp/${files[0]}/big`) ? statSync(`${ROOT}/run/tmp/${files[0]}/big`).size : -1;
    const leaf = statSync(`${ROOT}/run/tmp/${files[0]}`);
    check("scratch folders: parents 0700, the leaf 0700 and owned by uid 993", (statSync(`${ROOT}/run`).mode & 0o7777) === 0o700 && (statSync(`${ROOT}/run/tmp`).mode & 0o7777) === 0o700 && (leaf.mode & 0o7777) === 0o700 && leaf.uid === 993, { run: (statSync(`${ROOT}/run`).mode & 0o7777).toString(8), tmp: (statSync(`${ROOT}/run/tmp`).mode & 0o7777).toString(8), leafMode: (leaf.mode & 0o7777).toString(8), leafUid: leaf.uid });
    check("the environment files are gone once the sandboxes are up", readdirSync(`${ROOT}/run/env`).length === 0 || readdirSync(`${ROOT}/run/env`).every((f) => f.length === 0));
    check("host-dir /tmp is disk-backed: 100 MB lands in the folder", wrote?.ok === true && onDisk === 100 * 1048576, { wrote, onDisk });
    info("host-dir: peak memory before and after writing 100 MB of /tmp (bytes)", [dirBaseline, peak]);
    info("host-dir: peak memory grows with the written file (gVisor page cache), so the cgroup limit may still bite", { grewBytes: peak - dirBaseline });
    await dirRunner.stopFunction(KEY);
    // Does a 128 MB limit stop a 300 MB write to the disk-backed /tmp? (It would, if the page cache were pinned.)
    const smallRunner = make();
    await smallRunner.register(KEY, config({ ephemeralMb: 512, memoryMb: 128 }));
    const big = await invoke(smallRunner, { op: "tmpwrite", mb: 300 });
    info("host-dir: 300 MB written under a 128 MB memory limit", big.kind === "response" ? body(big) : { kind: big.kind, oomKilled: big.oomKilled, exitCode: big.exitCode });
    check("a disk-backed /tmp larger than the memory limit works (the cache is reclaimable, not pinned)", big.kind === "response" && body(big).ok === true, big.kind);
    await smallRunner.stopFunction(KEY);
    const tmpfsSmall = make({ scratchKind: "tmpfs" });
    await tmpfsSmall.register(KEY, config({ ephemeralMb: 512, memoryMb: 128 }));
    const tmpfsBig = await invoke(tmpfsSmall, { op: "tmpwrite", mb: 300 });
    info("tmpfs: 300 MB written under a 128 MB memory limit", tmpfsBig.kind === "response" ? body(tmpfsBig) : { kind: tmpfsBig.kind, oomKilled: tmpfsBig.oomKilled, exitCode: tmpfsBig.exitCode });
    await tmpfsSmall.stopFunction(KEY);
    await dirRunner.stopFunction(KEY);
    check("the scratch folder is removed with the sandbox", readdirSync(`${ROOT}/run/tmp`).length === 0);
  }

  // ---- 4. deadlines, crashes, OOM
  {
    const runner = make();
    // M1: a short Timeout on a COLD start is not eaten by the runtime's start (the agent's init takes several hundred ms).
    const coldShort = make();
    await coldShort.register(KEY, config({ timeoutSeconds: 1, memoryMb: 128 }));
    const shortCold = await invoke(coldShort, { op: "echo" }, { timeoutMs: 150 });
    check("a cold start with a 150 ms Timeout still answers (the first invoke waits for ready)", shortCold.kind === "response" && shortCold.cold === true && shortCold.coldStartMs > 150, shortCold.kind === "response" ? { coldStartMs: shortCold.coldStartMs } : shortCold);
    await coldShort.stopAll();
    await runner.register(KEY, config({ timeoutSeconds: 2, memoryMb: 128 }));
    await invoke(runner, { op: "echo" }); // a warm sandbox first, so the numbers below are the deadline's alone
    const t0 = Date.now();
    const slow = await invoke(runner, { op: "sleep", seconds: 30 }, { timeoutMs: 1000 });
    check("the deadline (the agent's, then the sandbox's removal) reports timeout", slow.kind === "timeout" && slow.errorType === "Sandbox.Timedout" && Date.now() - t0 < 4000 && leftovers().length === 0, { kind: slow.kind, ms: Date.now() - t0 });
    const crash = await invoke(runner, { op: "exit", code: 3 });
    check("a runtime crash is reported, and the sandbox is removed", crash.kind === "crash" && crash.errorType === "Runtime.ExitError" && leftovers().length === 0 && runner.stats().reservedMiB === 0, crash.kind === "crash" ? { exitCode: crash.exitCode, errorType: crash.errorType, errorMessage: crash.errorMessage } : crash);
    const oom = await invoke(runner, { op: "alloc", mb: 600 });
    info("OOM outcome (128 MB limit, 600 MB allocation)", oom.kind === "crash" ? { kind: oom.kind, exitCode: oom.exitCode, oomKilled: oom.oomKilled, errorType: oom.errorType } : { kind: oom.kind });
    check("an OOM-killed function is a crash, the sandbox is gone, memory is freed", oom.kind === "crash" && leftovers().length === 0 && runner.stats().reservedMiB === 0);
    const after = await invoke(runner, { op: "echo" });
    check("the next call starts cold and works", after.kind === "response" && after.cold === true);
    await runner.stopAll();
  }

  // ---- 5. concurrency, eviction, idle reaping
  {
    const runner = make({ memoryBudgetMiB: 300, idleTimeoutMs: 200 });
    await runner.register(KEY, config({ memoryMb: 128, maxConcurrency: 2 }));
    const [a, b, c] = await Promise.all([invoke(runner, { op: "sleep", seconds: 1 }), invoke(runner, { op: "sleep", seconds: 1 }), invoke(runner, { op: "echo" })]);
    check("two run at once in two sandboxes, the third is throttled", a.kind === "response" && b.kind === "response" && a.environmentId !== b.environmentId && c.kind === "throttled" && c.reason === "concurrency", [a.kind, b.kind, c.kind]);
    check("the memory budget holds 2 x 128 MiB", runner.stats().reservedMiB === 256, runner.stats());
    const other = { functionName: "other-fn", version: "1" };
    await runner.register(other, config({ memoryMb: 128 }));
    const evicting = await runner.invoke({ key: other, requestId: "r-evict", payload: "{}" });
    check("a start that does not fit evicts an idle sandbox", evicting.kind === "response" && runner.stats().reservedMiB === 256 && leftovers().length === 2, { kind: evicting.kind, stats: runner.stats(), containers: leftovers().length });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const reaped = await runner.reap();
    check("the reaper ends idle sandboxes and frees their memory", reaped === 2 && leftovers().length === 0 && runner.stats().reservedMiB === 0, { reaped, stats: runner.stats() });
    await runner.stopAll();
  }

  // ---- 6. start failures
  {
    const runner = make();
    await runner.register(KEY, config({ image: "localhost/rovara-w1-no-such-image:1" }));
    const missing = await invoke(runner, { op: "echo" });
    check("a missing image is an unavailable start with docker's reason", missing.kind === "unavailable" && missing.reason === "start_failed" && typeof missing.detail === "string", missing);
    check("a failed start leaves nothing and frees the memory", leftovers().length === 0 && runner.stats().reservedMiB === 0);
    await runner.stopAll();
  }

  // ---- 7. the services network mode (fixed address, hosts file, empty resolv.conf)
  {
    const NET = "rovara-w1live-net";
    dockerSafe("network", "rm", NET);
    docker("network", "create", "--internal", "--subnet", "10.77.0.0/24", NET);
    writeFileSync(`${ROOT}/net/hosts`, "127.0.0.1 localhost\n10.77.0.70 function\n10.77.0.9 aws\n");
    writeFileSync(`${ROOT}/net/resolv.conf`, "options ndots:0 timeout:1 attempts:1\n");
    chmodSync(`${ROOT}/net`, 0o755);
    try {
      const runner = make();
      await runner.register(KEY, config({ network: { mode: "services", name: NET, ip: "10.77.0.70", hostsFile: `${ROOT}/net/hosts`, resolvConf: `${ROOT}/net/resolv.conf` } }));
      const out = await invoke(runner, { op: "probe" });
      const probe = body(out);
      info("services-network probe", probe === undefined ? out : { interfaces: probe.interfaces, internet: probe.connect_internet, dns: probe.dns, route: probe.route });
      check("services mode: an interface besides lo, no internet", probe !== undefined && probe.interfaces.length === 2 && probe.connect_internet !== true, probe?.interfaces);
      await runner.stopAll();
      // M2: a network that is not internal, and addresses outside .64 to .127, are refused at register.
      const OPEN = "rovara-w1live-open";
      dockerSafe("network", "rm", OPEN);
      docker("network", "create", "--subnet", "10.78.0.0/24", OPEN);
      try {
        const net = (name, ip) => ({ mode: "services", name, ip, hostsFile: `${ROOT}/net/hosts`, resolvConf: `${ROOT}/net/resolv.conf` });
        const refused = async (network) => { try { await runner.register(KEY, config({ network })); return false; } catch (error) { return error instanceof RangeError; } };
        check("register refuses a network that is not internal", await refused(net(OPEN, "10.78.0.70")));
        check("register refuses an address outside .64 to .127, or outside the subnet", (await refused(net(NET, "10.77.0.5"))) && (await refused(net(NET, "10.77.0.200"))) && (await refused(net(NET, "10.99.0.70"))));
        check("register refuses a network that does not exist, and host/bridge", (await refused(net("rovara-w1live-nope", "10.77.0.70"))) && (await refused(net("host", "10.77.0.70"))) && (await refused(net("bridge", "172.17.0.70"))));
      } finally { dockerSafe("network", "rm", OPEN); }
    } finally { dockerSafe("network", "rm", NET); }
  }
} finally {
  const strays = leftovers();
  if (strays.length > 0) { info("removing stray containers", strays); dockerSafe("rm", "-f", "--volumes", ...strays); }
  rmSync(ROOT, { recursive: true, force: true });
  if (pulled) dockerSafe("rmi", IMAGE);
  check("nothing of the live test is left behind", leftovers().length === 0);
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
