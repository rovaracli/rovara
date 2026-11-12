// Live test of the runner/2 client (slice 4, lane W3) in the Linux VM: the REAL Rovara front and the real AWS Emulator engine inside a helper container (`docker exec -i ... runner-pipe` is the worker's pipe), the real sandbox controller
// under gVisor (runsc) with AWS's python base image and lane A1's agent, the real code store, and a numpy function created and invoked through boto3: the direct fast path, errors, a timeout, an SQS trigger through the engine's stub, a
// reset barrier, and (when an x86_64 package is given) the arm64 wheel swap from PyPI. It is NOT part of CI.
// Run (from the repo root on the Mac; the VM mounts the Mac's home, so paths are the same there):
//   1. bundle:  node_modules/.bin/esbuild scripts/function-runner-live/live-entry.mjs --bundle --platform=node --target=node22 --format=esm --outfile=scripts/function-runner-live/.build/function-runner.mjs
//   2. in the VM (profile aws-emu-spike), once: build the front (go build in rovara-local-aws s4-front `front/`) and the agent (go build in `runner/agent`, CGO_ENABLED=0) into ~/s4rc, install node 22 there, pip-install boto3 into ~/s4rc/pylib, and
//      build the packages: ~/s4rc/numpy-arm64.zip and ~/s4rc/numpy-x86_64.zip (app.py = numpy_app.py plus `pip install --target` of numpy for manylinux2014_aarch64 / x86_64, python 3.12).
//   3. run: colima ssh -p aws-emu-spike -- bash -lc 'mkdir -p ~/s4rc/live && cp <repo>/scripts/function-runner-live/{run-runner-live.mjs,drive.py,.build/function-runner.mjs} ~/s4rc/live/ && cd ~/s4rc/live && sudo -E ~/s4rc/node22/bin/node run-runner-live.mjs'
// The helper container is the front's own binary and the engine bind-mounted into a postgres:16 image (a glibc userland that is already there), on the host network and as root: a test shape, not the hardened helper. What IS the real shape: the
// read-only root, the 64 MiB tmpfs /tmp for the socket and the engine's scratch, the disk-backed store directory (runnerHelperEnv / runnerStoreMount), and `docker exec -i ... runner-pipe`. Plain JavaScript; removes everything it made.
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";

import { setTimeout } from "node:timers";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { FunctionCodeStore, chunksOf, resolveNativeCode, createPypiJsonIndex, createSandboxController, dockerExecPipeLauncher, dockerRunLauncher, readCgroupMemoryPeak, runnerHelperEnv, runnerStoreMount, startRunnerLink } from "./function-runner.mjs";

const S4 = `${homedir()}/s4rc`;
const IMAGE = process.env.LIVE_IMAGE ?? "public.ecr.aws/lambda/python:3.12-arm64";
const HELPER_IMAGE = process.env.LIVE_HELPER_IMAGE ?? "postgres:16";
const ENGINE = process.env.LIVE_ENGINE ?? "/opt/aws-emulator/bin/aws-emulator";
const HELPER = "rvrc-live-helper";
const ROOT = `${process.cwd()}/work-runner`;
const RUN_LABEL = "rovara.runnerlive";
const ARM_ZIP = process.env.LIVE_ARM_ZIP ?? `${S4}/numpy-arm64.zip`;
const X86_ZIP = process.env.LIVE_X86_ZIP ?? `${S4}/numpy-x86_64.zip`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const dockerSafe = (...args) => { try { return docker(...args); } catch (error) { return `ERR ${String(error.stderr ?? error)}`; } };
const control = { run: (args, options) => new Promise((resolve) => { execFile("docker", [...args], { timeout: options?.timeoutMs ?? 60_000, encoding: "utf8" }, (error, stdout, stderr) => resolve({ exitCode: error === null ? 0 : (typeof error.code === "number" ? error.code : -1), stdout, stderr })); }) };
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`); };
const info = (name, value) => console.log(`INFO  ${name}  ${typeof value === "string" ? value : JSON.stringify(value)}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const leftovers = () => docker("ps", "-a", "-q", "--filter", "label=rovara.function").trim().split("\n").filter(Boolean);

rmSync(ROOT, { recursive: true, force: true });
for (const dir of ["store", "helper-store", "scratch", "env"]) mkdirSync(`${ROOT}/${dir}`, { recursive: true });
chmodSync(ROOT, 0o755);
dockerSafe("rm", "-f", HELPER);
if (dockerSafe("image", "inspect", IMAGE).startsWith("ERR")) docker("pull", IMAGE);

const port = 20_000 + Math.floor(Math.random() * 10_000);
const token = randomBytes(12).toString("hex");
const endpoint = `http://127.0.0.1:${port}`;
const envLines = [
  "HOME=/tmp", "PATH=/usr/bin:/bin", "QUARKUS_HTTP_HOST=127.0.0.1", `QUARKUS_HTTP_PORT=${port}`, "ROVARA_AWS_BASE_URL=http://aws:4566", `ROVARA_AWS_AUTH_PRESIGN_SECRET=ps${token}`, `ROVARA_AWS_SERVICES_SQS_RECEIPT_HANDLE_SECRET=rc${token}`,
  `ROVARA_AWS_CONTROL_TOKEN=${token}`, "ROVARA_AWS_DEFAULT_REGION=us-east-1", "ROVARA_AWS_HOSTNAME=aws", "ROVARA_AWS_ENGINE_BIN=/usr/local/bin/aws-emulator", "ROVARA_AWS_FRONT_WORKDIR=/tmp",
  "ROVARA_AWS_PLANNED_SERVICES=lambda,iam,sqs,s3,dynamodb,cloudwatch-logs", ...runnerHelperEnv({ store: { kind: "disk" } }),
];
writeFileSync(`${ROOT}/env/helper.env`, `${envLines.join("\n")}\n`, { mode: 0o600 });
chmodSync(`${ROOT}/helper-store`, 0o777);

let link;
const sessions = [];
const pylib = `${S4}/pylib`;
try {
  docker("run", "-d", "--name", HELPER, "--label", `${RUN_LABEL}=1`, "--pull=never", "--network", "host", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m", "--user", "0:0",
    "--memory", "1024m", "--memory-swap", "1024m", "-v", `${S4}/rovara-aws-front:/usr/local/bin/rovara-aws-front:ro`, "-v", `${ENGINE}:/usr/local/bin/aws-emulator:ro`, ...runnerStoreMount(`${ROOT}/helper-store`),
    "--env-file", `${ROOT}/env/helper.env`, "--entrypoint", "/usr/local/bin/rovara-aws-front", HELPER_IMAGE);
  let healthy = false;
  for (let i = 0; i < 300 && !healthy; i += 1) { try { healthy = (await fetch(`${endpoint}/_rovara/health`, { signal: globalThis.AbortSignal.timeout(1000) })).ok; } catch { await wait(200); } }
  if (!healthy) { console.log(docker("logs", HELPER)); }
  check("the front and the engine are up in the helper container (read-only root, tmpfs /tmp, disk store)", healthy);
  if (!healthy) throw new Error("front did not start");

  const store = new FunctionCodeStore({ root: `${ROOT}/store` });
  await store.sweepStale();
  let dial = 0;
  const wheelIndex = createPypiJsonIndex({ fetch: globalThis.fetch });
  link = startRunnerLink({
    helperContainer: HELPER, launcher: dockerExecPipeLauncher(), workerVersion: "live", runtimes: ["python3.12"], retryBaseMs: 200,
    log: (event) => { if (event.event !== "ignored_frame") info("runner event", event); },
    onRegistered: (r) => info("registration", { name: r.name, ok: r.ok, errorType: r.errorType, swapped: r.swapped, arch: r.native?.arch }),
    openSession: async () => {
      dial += 1;
      const code = await store.openRun(`live-${dial}`);
      const controller = createSandboxController({ docker: control, launcher: dockerRunLauncher(), memoryBudgetMiB: 2048, scratchBaseDir: `${ROOT}/scratch/${dial}`, labels: [{ key: RUN_LABEL, value: "1" }], readMemoryPeak: readCgroupMemoryPeak, backstopMs: 500, log: (event) => { if (process.env.LIVE_VERBOSE) info("sandbox event", event); } });
      sessions.push(controller);
      return { controller, code, wheelIndex, settings: { imageForRuntime: (runtime) => (runtime === "python3.12" ? IMAGE : undefined), agentHostPath: `${S4}/agent`, network: { mode: "none" }, maxConcurrency: 4 }, close: () => code.close() };
    },
  });
  let connected = false;
  for (let i = 0; i < 150 && !connected; i += 1) { try { connected = (await (await fetch(`${endpoint}/_rovara/lambda/heavy`, { headers: { "x-rovara-control-token": token } })).json()).runner === "connected"; } catch { /* retry */ } if (!connected) await wait(200); }
  check("the worker's runner client is connected to the front through `docker exec -i ... runner-pipe`", connected && link.state === "connected", link.state);

  const args = ["drive.py", endpoint, token, ARM_ZIP, ...(existsSync(X86_ZIP) ? [X86_ZIP] : [])];
  const driver = spawn("python3", args, { env: { ...process.env, PYTHONPATH: pylib }, stdio: ["ignore", "pipe", "inherit"] });
  driver.stdout.on("data", (chunk) => { process.stdout.write(chunk); });
  const driverCode = await new Promise((resolve) => { driver.on("close", resolve); });
  check("the boto3 driver finished with no failed check", driverCode === 0, driverCode);

  const metrics = sessions.map((controller) => controller.metrics().total);
  info("controller metrics (per connection)", metrics);
  check("the controller ran the calls: cold starts, warm hits, the timeout, no crashes", metrics.reduce((n, m) => n + m.invocations, 0) >= 20 && metrics.reduce((n, m) => n + m.timeouts, 0) >= 1 && metrics.reduce((n, m) => n + m.crashes, 0) === 0, metrics);
  info("sandbox cold start ms (docker run to runtime ready), last", metrics.map((m) => m.lastColdStartMs));
  info("helper store (front's package copies, bytes on disk)", execFileSync("du", ["-sb", `${ROOT}/helper-store`], { encoding: "utf8" }).trim());

  // ---- worker side only: the arm64 wheel swap with the real PyPI index, then the swapped package under gVisor (the front does not forward x86-64 packages to the worker yet)
  if (existsSync(X86_ZIP)) {
    const bytes = readFileSync(X86_ZIP);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const code = await store.openRun("live-swap");
    const swapController = createSandboxController({ docker: control, launcher: dockerRunLauncher(), memoryBudgetMiB: 2048, scratchBaseDir: `${ROOT}/scratch/swap`, labels: [{ key: RUN_LABEL, value: "1" }], readMemoryPeak: readCgroupMemoryPeak, backstopMs: 500 });
    try {
      await code.receive({ kind: "function", sha256: sha, sizeBytes: bytes.length }, chunksOf(bytes));
      const materialized = await code.materialize("swap", { packageSha256: sha, layerSha256s: [] });
      check("the classifier calls the x86_64 numpy package x86_64 (needs the swap)", materialized.native.arch === "x86_64" && materialized.needsArchAction, materialized.native.arch);
      const t0 = Date.now();
      const outcome = await resolveNativeCode(materialized, { runtime: "python3.12", wheelIndex });
      info("arm64 swap from PyPI ms (list, download, verify every RECORD hash, replace, re-classify)", Date.now() - t0);
      check("the swap replaced numpy with the same version's aarch64 wheel and the package is arm64 now", outcome.swapped === true && outcome.native.arch === "arm64" && outcome.swap.every((r) => r.status === "swapped"), outcome.swap.map((r) => `${r.name} ${r.version} ${r.status} ${r.wheel ?? ""}`));
      const key = { functionName: "np-x86", version: "1" };
      await swapController.register(key, { runtime: "python3.12", handler: "app.handler", environment: {}, region: "us-east-1", memoryMb: 512, timeoutSeconds: 20, ephemeralMb: 512, image: IMAGE, agentHostPath: `${S4}/agent`, codeHostPath: materialized.taskDir, layersHostPath: materialized.optDir, network: { mode: "none" }, maxConcurrency: 2 });
      const out = await swapController.invoke({ key, requestId: "swap-1", payload: JSON.stringify({ x: 86 }) });
      const body = out.kind === "response" ? JSON.parse(out.payload.toString()) : undefined;
      check("the swapped x86_64 package runs numpy under gVisor on arm64", body?.sum === 45 && body?.arch === "aarch64", out.kind === "response" ? body : out);
      info("swapped package cold call ms", out.kind === "response" ? out.wallMs : -1);
    } finally {
      await swapController.stopAll();
      await code.close();
    }
  }
} catch (error) {
  failures += 1;
  console.log(`FAIL  harness  ${String(error?.stack ?? error)}`);
} finally {
  if (link !== undefined) await link.close();
  check("closing the link stopped every sandbox: no function container is left", leftovers().length === 0, leftovers());
  check("the link ended stopped", link === undefined || link.state === "stopped", link?.state);
  dockerSafe("rm", "-f", HELPER);
  rmSync(ROOT, { recursive: true, force: true });
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
