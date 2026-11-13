import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SELFTEST_ALWAYS_PENDING_IDS, SELFTEST_CI_ITEM_IDS, SELFTEST_ITEM_IDS, SELFTEST_MAX_CHARS, SELFTEST_REASONS, SELFTEST_STATES, SELFTEST_STATUSES, TEST_SERVICES_SELFTEST_ENVIRONMENT, parseSelfTest,
} from "../../packages/worker/src/test-services-selftest.js";

// The opt-in TS-L self-test of boot-stage2.sh (`run_tsl_selftest`), run for real in bash with fake docker, iptables, ip, timeout and the like on PATH and the script's system paths pointed at a temporary folder. The release gate's five
// conditions (session 89) are each a group of tests below.
const stage2 = readFileSync(new URL("../../packages/worker/ec2/boot-stage2.sh", import.meta.url), "utf8");
const checker = readFileSync(new URL("../../scripts/linux-check-test-services.sh", import.meta.url), "utf8");
const ciScript = readFileSync(new URL("../../scripts/ci-test-services-linux.sh", import.meta.url), "utf8");
const driver = readFileSync(new URL("../../scripts/linux-check-test-services-live.ts", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../../environments/base/Dockerfile", import.meta.url), "utf8");
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const IMAGE = `944937319445.dkr.ecr.us-west-2.amazonaws.com/agentx-worker@sha256:${"d".repeat(64)}`;
const BOOT2 = "b".repeat(64);
const INSTANCE = "i-08a32b24c7e3efe6c";
const STAGING: Record<string, string> = { AGENTX_TSL_SELFTEST: "1", AGENTX_ENVIRONMENT_KIND: "named", AGENTX_LOG_GROUP: "/agentx/staging/worker", AGENTX_WORKER_IMAGE: IMAGE, AGENTX_BOOT_STAGE2_SHA256: BOOT2 };

/** The checker's output as the real script prints it: one line per item, free text after the bar. */
function checkerOutput(overrides: Record<string, string> = {}, extra: string[] = []): string {
  const lines = SELFTEST_CI_ITEM_IDS.map((id) => {
    if (overrides[id] !== undefined) return `TSL ${id} ${overrides[id]}`;
    if (id === "L1.internal-drops" || id === "L5.live" || id === "L7.live" || id === "L8.live") return `TSL ${id} PENDING some-name | later: 10.0.0.5 ip-10-0-0-5.ec2.internal`;
    return `TSL ${id} PASS some-name | evidence from 172.30.0.2 on host ip-10-0-9-9 token=SECRET`;
  });
  return [...extra, ...lines, "TSL SUMMARY pass=27 fail=0 pending=4"].join("\n") + "\n";
}

interface Setup { dir: string; bin: string; state: string; env: string; calls: string; log: string; vartmp: string; fixtures: string }

function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), "ec2-tsl-selftest-"));
  roots.push(dir);
  const s: Setup = { dir, bin: join(dir, "bin"), state: join(dir, "state"), env: join(dir, "worker.env"), calls: join(dir, "calls"), log: join(dir, "log"), vartmp: join(dir, "vartmp"), fixtures: join(dir, "fixtures") };
  for (const d of [s.bin, s.state, s.vartmp, s.fixtures]) mkdirSync(d);
  for (const file of [s.env, s.calls, s.log]) writeFileSync(file, "");
  for (const file of ["containers_driver", "containers_ws", "networks_ws"]) writeFileSync(join(s.state, file), "");
  writeFileSync(join(s.fixtures, "checks.sh"), [
    "#!/bin/bash",
    'echo "checks mode=${TSL_DIR:+live}${TSL_DIR:-host}" >>"$CALLS_FILE"',
    'cat "$CHECKS_OUT"',
    // A live run makes things: a container and a network carrying the throwaway key, a pulled image, a rule and an interface (the fake iptables and ip read these files).
    'if [[ -n "${TSL_DIR:-}" ]]; then echo c1 >>"$STATE/containers_ws"; echo n1 >>"$STATE/networks_ws"; : >"$STATE/pulled"; : >"$STATE/rule"; : >"$STATE/iface"; fi',
  ].join("\n"));
  writeFileSync(join(s.fixtures, "live.mjs"), "// driver\n");
  writeFileSync(join(s.fixtures, "catalog.json"), "{}\n");
  writeFileSync(join(s.fixtures, "catalog.sig.json"), "{}\n");
  const tool = (name: string, body: string) => { writeFileSync(join(s.bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(s.bin, name), 0o755); };
  tool("timeout", [
    'while [[ "$1" == --* ]]; do shift; done; shift',
    // A forced timeout: the live checker never finishes (the real timeout kills it); nothing it would have made exists.
    'if [[ "${FORCE_TIMEOUT:-}" == 1 && -n "${TSL_DIR:-}" && "$*" == *s.sh* ]]; then echo "checks timed-out" >>"$CALLS_FILE"; exit 124; fi',
    'exec "$@"',
  ].join("\n"));
  tool("docker", [
    'echo "docker $*" >>"$CALLS_FILE"',
    '[[ -z "${DOCKER_DOWN:-}" ]] || exit 1',
    '[[ -z "${DOCKER_DOWN_AFTER_RUN:-}" || ! -e "$STATE/rule" ]] || exit 1',
    // Once the labelled containers and networks are gone, Docker has taken their rules and bridge away too (unless the test leaks them).
    'settle() { [[ -s "$STATE/networks_ws" || -s "$STATE/containers_ws" ]] || { [[ -n "${LEAK_RULE:-}" ]] || rm -f "$STATE/rule"; [[ -n "${LEAK_IFACE:-}" ]] || rm -f "$STATE/iface"; }; }',
    'trap settle EXIT',
    'case "$1" in',
    '  version) echo "${DOCKER_VERSION:-25.0.18}" ;;',
    '  ps) if [[ "$*" == *rovara.tsl-selftest=1* ]]; then cat "$STATE/containers_driver"; else cat "$STATE/containers_ws"; fi ;;',
    '  rm) shift; [[ "$1" == -f ]] && shift; [[ "$1" == -v ]] && shift; if [[ "$1" == abcdef123456 ]]; then exit 0; fi; for id in "$@"; do',
    '        [[ -n "${LEAK_CONTAINER:-}" ]] && continue; sed -i.bak "/^$id\\$/d" "$STATE/containers_ws" "$STATE/containers_driver"; done ;;',
    '  network) case "$2" in',
    '    ls) if [[ "$*" == *name=* ]]; then [[ -e "$STATE/tasknet" ]] && echo tasknet; exit 0; fi; cat "$STATE/networks_ws" ;;',
    '    create) [[ -z "${TASKNET_EXISTS:-}" ]] || exit 1; : >"$STATE/tasknet" ;;',
    '    rm) if [[ "$3" == agentx-task ]]; then [[ -n "${LEAK_TASKNET:-}" ]] || rm -f "$STATE/tasknet"; else [[ -n "${LEAK_NETWORK:-}" ]] || : >"$STATE/networks_ws"; fi ;;',
    '    esac ;;',
    '  image) case "$2" in',
    '    ls) echo sha256:base; [[ -e "$STATE/pulled" ]] && echo sha256:pulled; exit 0 ;;',
    '    rm) [[ "$4" == sha256:pulled ]] && rm -f "$STATE/pulled"; exit 0 ;;',
    '    esac ;;',
    '  create) echo abcdef123456 ;;',
    '  cp) src=${2#*:}; dest=$3; [[ -n "${NO_BUNDLE:-}" ]] && exit 1; cp "$FIXTURES/$(basename "$src")" "$dest" ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join("\n"));
  tool("iptables", [
    'if [[ "$*" == *"-t nat"* ]]; then echo "-P PREROUTING ACCEPT"; exit 0; fi',
    'echo "-P FORWARD DROP"; echo "-A DOCKER-USER -i rvi+ ! -o rvi+ -j DROP"',
    'if [[ -e "$STATE/rule" ]]; then echo "-A DOCKER-FORWARD -i rvi1234abcd -j DROP"; fi',
  ].join("\n"));
  tool("ip", [
    'echo "1: lo: <LOOPBACK> mtu 65536"; echo "2: ens5: <BROADCAST> mtu 9001"',
    'if [[ -e "$STATE/iface" ]]; then echo "9: rvi1234abcd: <BROADCAST> mtu 1500"; fi',
  ].join("\n"));
  tool("sleep", "exit 0");
  return s;
}

/** Runs `body` in bash with stage 2 sourced from a copy whose system paths are the test's. */
function run(s: Setup, body: string, env: Record<string, string> = {}, tweak: (text: string) => string = (text) => text) {
  const text = tweak(stage2
    .replaceAll("/var/tmp/", `${s.vartmp}/`)
    .replace("readonly WORKER_ENV_FILE=/etc/agentx/worker.env", `readonly WORKER_ENV_FILE=${s.env}`));
  const file = join(s.dir, "stage2.sh");
  writeFileSync(file, text);
  const script = [
    "set -u",
    `log() { printf '%s\\n' "$*" >>"$LOG_FILE"; }`,
    `imds_once() { [[ "$1" == ami-id ]] && printf '%s\\n' "\${FAKE_AMI-ami-0d2beaff07e79c24e}"; }`,
    "BOOT_DEADLINE=$((SECONDS + 400))",
    `source "${file}"`,
    body,
  ].join("\n");
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: `${s.bin}:/usr/bin:/bin:/usr/sbin:/sbin`, LOG_FILE: s.log, CALLS_FILE: s.calls, STATE: s.state, FIXTURES: s.fixtures, HOME: s.dir, TMPDIR: s.dir, ...env },
  });
}
const callsOf = (s: Setup) => readFileSync(s.calls, "utf8");
const envFileOf = (s: Setup) => readFileSync(s.env, "utf8");
const recorded = (s: Setup): string | undefined => envFileOf(s).split("\n").find((line) => line.startsWith(`${TEST_SERVICES_SELFTEST_ENVIRONMENT}=`))?.slice(TEST_SERVICES_SELFTEST_ENVIRONMENT.length + 1);
const SELFTEST = 'run_tsl_selftest "$INSTANCE_ID"; echo "rc=$?"';
function selfTest(s: Setup, env: Record<string, string>, output = checkerOutput(), tweak?: (text: string) => string) {
  const out = join(s.dir, "checks.out");
  writeFileSync(out, output);
  return run(s, SELFTEST, { INSTANCE_ID: INSTANCE, CHECKS_OUT: out, ...env }, tweak);
}

describe("condition 1: off by default, staging only", () => {
  it("does nothing at all without the opt-in: no docker call, no file, no result", () => {
    const s = setup();
    const off = selfTest(s, { ...STAGING, AGENTX_TSL_SELFTEST: "" });
    expect(off.stdout).toContain("rc=0");
    expect(callsOf(s)).toBe("");
    expect(envFileOf(s)).toBe("");
    expect(readdirSync(s.vartmp)).toEqual([]);
    for (const value of ["0", "true", "yes", "11", " 1"]) {
      const other = setup();
      expect(selfTest(other, { ...STAGING, AGENTX_TSL_SELFTEST: value }).stdout).toContain("rc=0");
      expect(callsOf(other), value).toBe("");
      expect(envFileOf(other), value).toBe("");
    }
    // The variable is not set at all (every launch today).
    const unset = setup();
    const without = { ...STAGING };
    delete without["AGENTX_TSL_SELFTEST"];
    expect(selfTest(unset, without).stdout).toContain("rc=0");
    expect(callsOf(unset)).toBe("");
    expect(envFileOf(unset)).toBe("");
  });

  it("refuses in production, and in any environment that is not exactly staging: records `refused`, starts nothing", () => {
    for (const logGroup of ["/agentx/production/worker", "/agentx/prod/worker", "/agentx/staging2/worker", "/agentx/Staging/worker", "/agentx/staging/worker/x", "", "/agentx/staging"]) {
      const s = setup();
      const result = selfTest(s, { ...STAGING, AGENTX_LOG_GROUP: logGroup });
      expect(result.stdout, logGroup).toContain("rc=0");
      const line = recorded(s);
      expect(line, logGroup).toBeDefined();
      const parsed = parseSelfTest(line);
      expect(parsed, logGroup).not.toBe("unreadable");
      expect(parsed, logGroup).toMatchObject({ state: "refused", reason: "not_staging", items: [] });
      // Nothing was created: the only docker call is the version read for the identity.
      expect(callsOf(s).split("\n").filter((call) => call !== "" && !call.startsWith("docker version")), logGroup).toEqual([]);
      expect(readdirSync(s.vartmp)).toEqual([]);
    }
  });

  it("refuses when the environment is not a named one (the legacy production boot)", () => {
    const s = setup();
    const legacy = { ...STAGING };
    delete legacy["AGENTX_ENVIRONMENT_KIND"];
    expect(selfTest(s, legacy).stdout).toContain("rc=0");
    expect(parseSelfTest(recorded(s))).toMatchObject({ state: "refused", reason: "not_named" });
    expect(callsOf(s)).not.toContain("docker create");
  });

  it("runs on a named staging environment", () => {
    const s = setup();
    expect(selfTest(s, STAGING).stdout).toContain("rc=0");
    expect(parseSelfTest(recorded(s))).toMatchObject({ state: "ran", reason: "ok" });
  });

  it("reads the opt-in from the launch environment only: the gate names no SSM parameter, no AWS call and no file", () => {
    const gate = /^tsl_selftest_gate\(\) \{[\s\S]*?^\}$/mu.exec(stage2)?.[0] ?? "";
    expect(gate).toContain("AGENTX_TSL_SELFTEST");
    expect(gate).not.toMatch(/aws |ssm|cat |curl/u);
    // Nothing else in the repository's launch (control plane, broker, boot configuration) sets it.
    for (const file of ["../../infra/lib/control-plane.ts", "../../infra/lib/worker-settings.ts", "../../packages/broker/src/aws/session-steps.ts", "../../packages/broker/src/aws/private-address-launch.ts"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).not.toContain("AGENTX_TSL_SELFTEST");
    }
  });
});

describe("condition 2: never blocks the boot, never touches the worker's own walls", () => {
  it("has its own time budget: a timeout records `incomplete` and the host-only items still count", () => {
    const s = setup();
    const result = selfTest(s, { ...STAGING, FORCE_TIMEOUT: "1" });
    expect(result.stdout).toContain("rc=0");
    const parsed = parseSelfTest(recorded(s));
    expect(parsed).toMatchObject({ state: "incomplete", reason: "budget" });
    if (parsed === "absent" || parsed === "unreadable") throw new Error("unreadable");
    // The driver's items are incomplete; the read-only half ran alone on the clean host and its items are real.
    expect(parsed.items.find((item) => item.id === "L1.live")).toEqual({ id: "L1.live", status: "incomplete", reason: "budget" });
    expect(parsed.items.find((item) => item.id === "L1.walls")).toEqual({ id: "L1.walls", status: "pass", reason: "ok" });
    expect(callsOf(s)).toContain("checks mode=host");
  });

  it("does not start with too little time left before the boot deadline, and never runs past it by more than 90 s", () => {
    const s = setup();
    const result = run(s, 'BOOT_DEADLINE=$((SECONDS - 50)); tsl_budget_seconds; BOOT_DEADLINE=$((SECONDS + 400)); tsl_budget_seconds; TSL_SELFTEST_BUDGET_S=90 tsl_budget_seconds; TSL_SELFTEST_BUDGET_S=5 tsl_budget_seconds; TSL_SELFTEST_BUDGET_S=abc tsl_budget_seconds; TSL_SELFTEST_BUDGET_S=9999 tsl_budget_seconds');
    expect(result.stdout.trim().split("\n")).toEqual(["40", "170", "90", "170", "170", "170"]);
    const late = setup();
    const refused = run(late, 'BOOT_DEADLINE=$((SECONDS - 50)); run_tsl_selftest "$INSTANCE_ID"; echo "rc=$?"', { ...STAGING, INSTANCE_ID: INSTANCE });
    expect(refused.stdout).toContain("rc=0");
    expect(parseSelfTest(recorded(late))).toMatchObject({ state: "incomplete", reason: "budget", items: [] });
    expect(callsOf(late)).not.toContain("docker create");
  });

  it("a Docker that is not there, or a bundle that is not in the image, is `incomplete`, never a failed boot", () => {
    const down = setup();
    expect(selfTest(down, { ...STAGING, DOCKER_DOWN: "1" }).stdout).toContain("rc=0");
    expect(parseSelfTest(recorded(down))).toMatchObject({ state: "incomplete", reason: "docker_unavailable" });
    const old = setup();
    expect(selfTest(old, { ...STAGING, NO_BUNDLE: "1" }).stdout).toContain("rc=0");
    expect(parseSelfTest(recorded(old))).toMatchObject({ state: "incomplete", reason: "bundle_missing" });
    expect(readdirSync(old.vartmp)).toEqual([]);
    expect(readFileSync(join(old.state, "containers_driver"), "utf8")).toBe("");
  });

  it("is bounded as a whole: past its hard deadline no Docker command runs, so a wedged daemon cannot hold the boot, and what cannot be read back stops the worker", () => {
    const s = setup();
    const result = run(s, 'TSL_HARD_DEADLINE=$((SECONDS - 1)); tsl_dk version; echo "late=$?"; TSL_HARD_DEADLINE=$((SECONDS + 100)); tsl_dk version; echo "inside=$?"; TSL_HARD_DEADLINE=$((SECONDS - 1)); TSL_SNAPSHOT_BEFORE=$(mktemp); tsl_snapshot "$TSL_SNAPSHOT_BEFORE"; tsl_readback; echo "readback=$?"');
    expect(result.stdout).toContain("late=124");
    expect(result.stdout).toContain("inside=0");
    expect(result.stdout).toContain("readback=1");
    // Only the one call inside the deadline reached Docker.
    expect(callsOf(s).trim().split("\n")).toEqual(["docker version"]);
  });

  it("every command in it is bounded, and the block never writes the worker's walls, units, daemon settings or launcher", () => {
    const block = stage2.slice(stage2.indexOf("readonly TSL_SELFTEST_VARIABLE"), stage2.indexOf("# What boot.sh's main did after the worker image was pulled"));
    expect(block.length).toBeGreaterThan(5_000);
    // No rule is ever added, inserted, deleted, flushed or created; only read (`-S`).
    expect(block).not.toMatch(/ip6?tables [^\n]*(?:-[IADFXNRZP]\b| -C )/u);
    expect(block).not.toMatch(/systemctl|daemon\.json|write_worker|write_private|block_imds|wall_|withhold_|install_run_walls|rovara-private-allow|rovara-container-firewall/u);
    // Docker only through the bounded wrapper (the one `docker` word in a command position is inside it).
    const outsideWrapper = block.replace(/^tsl_dk\(\) \{.*\}$/mu, "").split("\n").filter((line) => /(?:^|[\s;(|&])docker (?!version\b)(?:ps|rm|network|image|create|cp|run|pull|login)\b/u.test(line) && !line.trimStart().startsWith("#"));
    expect(outsideWrapper).toEqual([]);
    // The checks run under one timeout that kills the process group (no --foreground: that would signal only the script).
    const runChecks = /^tsl_run_checks\(\) \{[\s\S]*?^\}$/mu.exec(block)?.[0] ?? "";
    expect(runChecks).toContain("timeout --kill-after=10s");
    expect(runChecks).not.toContain("--foreground");
  });

  it("is called after every wall and the worker's unit is written, and BEFORE the unit is started; the return code is the only thing that can fail the boot", () => {
    const main = /^stage2_main\(\) \{\n([\s\S]*?)^\}$/mu.exec(stage2)?.[1] ?? "";
    const at = (text: string) => main.indexOf(text);
    expect(at("run_tsl_selftest")).toBeGreaterThan(at("write_private_addresses"));
    expect(at("run_tsl_selftest")).toBeGreaterThan(at("write_worker_unit"));
    expect(at("run_tsl_selftest")).toBeLessThan(at('systemctl enable --now "$WORKER_UNIT"'));
    expect(main).toContain('run_tsl_selftest "$instance_id" || tsl_status=$?');
    expect(main).toMatch(/\(\(tsl_status == 0\)\) \|\| fail "the TS-L self-test left test objects/u);
    // The call sits inside the named-environment guard.
    expect(main.slice(at("if [[ ${AGENTX_ENVIRONMENT_KIND:-} == named ]]; then\n    tsl_status=0"), at("run_tsl_selftest"))).toContain("tsl_status=0");
    expect(spawnSync("bash", ["-n"], { input: stage2, encoding: "utf8" }).status).toBe(0);
  });
});

describe("condition 3: clean-up is proven before the worker takes work", () => {
  it("a run that leaves nothing behind: everything it made is removed and read back, and the boot goes on (rc 0)", () => {
    const s = setup();
    const result = selfTest(s, STAGING);
    expect(result.stdout).toContain("rc=0");
    expect(parseSelfTest(recorded(s))).toMatchObject({ state: "ran", reason: "ok" });
    // The checks made a container, a network, an image, a rule and an interface; all are gone.
    for (const file of ["containers_ws", "networks_ws", "containers_driver"]) expect(readFileSync(join(s.state, file), "utf8").trim(), file).toBe("");
    for (const file of ["pulled", "rule", "iface", "tasknet"]) expect(existsSync(join(s.state, file)), file).toBe(false);
    expect(readdirSync(s.vartmp)).toEqual([]);
    // The working sandbox's network was made for the checks and removed; it is the worker's to make later.
    expect(callsOf(s)).toContain("docker network create --driver bridge --opt com.docker.network.bridge.name=rvbtask --opt com.docker.network.bridge.enable_icc=false");
    expect(callsOf(s)).toContain("docker network rm agentx-task");
    // Images the checks pulled are removed, and only those.
    expect(callsOf(s)).toContain("docker image rm -f sha256:pulled");
    expect(callsOf(s)).not.toContain("sha256:base");
  });

  it("leaves a network that was there before the self-test alone (the worker's own agentx-task after a reboot)", () => {
    const s = setup();
    writeFileSync(join(s.state, "tasknet"), "");
    const result = selfTest(s, STAGING, checkerOutput(), undefined);
    expect(result.stdout).toContain("rc=0");
    expect(callsOf(s)).not.toContain("docker network rm agentx-task");
    expect(existsSync(join(s.state, "tasknet"))).toBe(true);
  });

  const LEAKS: Array<[string, Record<string, string>]> = [
    ["a container that cannot be removed", { LEAK_CONTAINER: "1" }],
    ["a network that cannot be removed", { LEAK_NETWORK: "1" }],
    ["the working sandbox's network", { LEAK_TASKNET: "1" }],
    ["an iptables rule the checks added", { LEAK_RULE: "1" }],
    ["a bridge interface", { LEAK_IFACE: "1" }],
    ["a Docker that stops answering after the checks (nothing can be read back)", { DOCKER_DOWN_AFTER_RUN: "1" }],
  ];
  for (const [name, leak] of LEAKS) {
    it(`NOT gone (${name}): rc 75, recorded as unusable, and the boot fails before the worker can start`, () => {
      const s = setup();
      const result = selfTest(s, { ...STAGING, ...leak });
      expect(result.stdout).toContain("rc=75");
      expect(parseSelfTest(recorded(s))).toMatchObject({ state: "unusable", reason: "cleanup_failed" });
      // It tried to clean up twice before it gave up.
      expect(callsOf(s).match(/docker rm -f -v|docker network rm/gu)?.length ?? 0).toBeGreaterThanOrEqual(0);
    });
  }

  it("the read-back decision itself: gone continues (0), anything not gone terminates (1), and a look that fails is not gone", () => {
    const s = setup();
    const decide = (extra: string, env: Record<string, string> = {}) => run(s, `TSL_SNAPSHOT_BEFORE=$(mktemp); tsl_snapshot "$TSL_SNAPSHOT_BEFORE"; ${extra}; tsl_readback; echo "decision=$?"`, env).stdout.trim();
    expect(decide(":")).toBe("decision=0");
    expect(decide('echo c1 >>"$STATE/containers_ws"')).toBe("decision=1");
    expect(decide('echo c1 >>"$STATE/containers_driver"')).toBe("decision=1");
    expect(decide('echo n1 >>"$STATE/networks_ws"')).toBe("decision=1");
    expect(decide(': >"$STATE/rule"')).toBe("decision=1");
    expect(decide(': >"$STATE/iface"')).toBe("decision=1");
    expect(decide('mkdir "' + join(s.vartmp, "tsl-work.abc123") + '"')).toBe("decision=1");
    expect(decide(":", { DOCKER_DOWN: "1" })).toBe("decision=1");
    // Created by the self-test and still there: not gone.
    expect(decide('TSL_CREATED_TASK_NETWORK=1; : >"$STATE/tasknet"')).toBe("decision=1");
    for (const file of ["containers_ws", "containers_driver", "networks_ws"]) writeFileSync(join(s.state, file), "");
    rmSync(join(s.vartmp, "tsl-work.abc123"), { recursive: true, force: true });
    rmSync(join(s.state, "tasknet"), { force: true });
    rmSync(join(s.state, "rule"), { force: true });
    rmSync(join(s.state, "iface"), { force: true });
  });

  it("a timed-out run is cleaned up and read back all the same", () => {
    const s = setup();
    selfTest(s, { ...STAGING, FORCE_TIMEOUT: "1" });
    for (const file of ["containers_ws", "networks_ws", "containers_driver"]) expect(readFileSync(join(s.state, file), "utf8").trim(), file).toBe("");
    expect(readdirSync(s.vartmp)).toEqual([]);
    const leaky = setup();
    expect(selfTest(leaky, { ...STAGING, FORCE_TIMEOUT: "1", LEAK_TASKNET: "1" }).stdout).toContain("rc=75");
  });

  it("the boot is stopped through the existing path: `fail` (a reason on /ping, the provisioner stops the session) and the worker unit is not started", () => {
    const main = /^stage2_main\(\) \{\n([\s\S]*?)^\}$/mu.exec(stage2)?.[1] ?? "";
    expect(main).toMatch(/fail "the TS-L self-test left test objects on this worker and it is unusable/u);
    expect(main.indexOf("run_tsl_selftest")).toBeLessThan(main.indexOf('systemctl enable --now "$WORKER_UNIT"'));
    // The failure reason is fixed words and carries no address.
    expect(/fail "the TS-L self-test[^"]*"/u.exec(main)?.[0]).not.toMatch(/[0-9]+\.[0-9]+\.[0-9]+/u);
    const boot = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
    expect(boot).toContain('"status": "BootFailed"');
  });
});

describe("condition 4: the output is fixed ids, fixed codes and the four identity values", () => {
  it("carries the AMI id, boot-stage2 SHA-256, Docker version and instance id, and nothing the checker printed", () => {
    const s = setup();
    selfTest(s, STAGING);
    const line = recorded(s) ?? "";
    expect(line.length).toBeLessThanOrEqual(SELFTEST_MAX_CHARS);
    const parsed = parseSelfTest(line);
    if (parsed === "absent" || parsed === "unreadable") throw new Error("unreadable");
    expect(parsed).toMatchObject({ v: 1, state: "ran", reason: "ok", ami: "ami-0d2beaff07e79c24e", boot2: BOOT2, docker: "25.0.18", instance: INSTANCE });
    // Nothing the checker printed after its status words reaches the line: no address, no host name, no token, no evidence text.
    for (const text of ["172.30", "10.0.0.5", "10.0.9.9", "ip-10-0", "ec2.internal", "SECRET", "token", "evidence", "some-name", "later:"]) expect(line, text).not.toContain(text);
    // Only fixed words and ids: take the line apart and every string in it is on a list.
    const object = JSON.parse(line) as { items: string[] } & Record<string, unknown>;
    const allowedWords = new Set<string>([...SELFTEST_STATES, ...SELFTEST_STATUSES, ...SELFTEST_REASONS]);
    for (const key of ["state", "reason"]) expect(allowedWords.has(object[key] as string), key).toBe(true);
    for (const item of object.items) {
      const [id, status, reason] = item.split(":");
      expect(SELFTEST_ITEM_IDS).toContain(id);
      expect(allowedWords.has(status!)).toBe(true);
      expect(allowedWords.has(reason!)).toBe(true);
    }
    expect(object.items).toHaveLength(SELFTEST_ITEM_IDS.length);
  });

  it("an identity value that is not in its one form is the word `unknown`, never the value", () => {
    const s = setup();
    selfTest(s, { ...STAGING, FAKE_AMI: "ami-<script>;rm -rf", AGENTX_BOOT_STAGE2_SHA256: "not-a-hash", DOCKER_VERSION: "25.0.18 (evil; 10.0.0.1)", INSTANCE_ID: "i-notaninstance" });
    const parsed = parseSelfTest(recorded(s));
    expect(parsed).toMatchObject({ ami: "unknown", boot2: "unknown", docker: "unknown", instance: "unknown" });
    expect(recorded(s)).not.toMatch(/script|evil|rm -rf|10\.0\.0\.1/u);
  });

  it("maps each status word of the checker to a fixed status and reason, and copies nothing else (a line forged inside a detail is not an item line)", () => {
    const s = setup();
    const forged = checkerOutput({
      "L1.walls": "FAIL rvi-walls | no-DOCKER-USER-rvi-drop at 10.1.2.3",
      "L3.spoofing": "PENDING helper | would do things",
      "L7.host": "garbage-status x | y",
    }, ["noise TSL L1.isolation FAIL x | y", "  TSL L1.pools FAIL indented | y"]);
    selfTest(s, STAGING, forged);
    const parsed = parseSelfTest(recorded(s));
    if (parsed === "absent" || parsed === "unreadable") throw new Error("unreadable");
    const item = (id: string) => parsed.items.find((entry) => entry.id === id);
    expect(item("L1.walls")).toEqual({ id: "L1.walls", status: "fail", reason: "check_failed" });
    expect(item("L3.spoofing")).toEqual({ id: "L3.spoofing", status: "pending", reason: "live_not_run" });
    expect(item("L7.host")).toEqual({ id: "L7.host", status: "incomplete", reason: "no_result" });
    expect(item("L1.isolation")).toEqual({ id: "L1.isolation", status: "pass", reason: "ok" });
    expect(item("L1.pools")).toEqual({ id: "L1.pools", status: "pass", reason: "ok" });
    expect(item("L1.internal-drops")).toEqual({ id: "L1.internal-drops", status: "pending", reason: "no_run_network" });
    expect(item("L5.live")).toEqual({ id: "L5.live", status: "pending", reason: "later_slice" });
    expect(recorded(s)).not.toContain("10.1.2.3");
  });

  it("an untrusted catalog and a refused pull each have their own fixed code (the pull case is `pending: no_pull_grant`)", () => {
    const itemOf = (s: Setup, id: string) => { const parsed = parseSelfTest(recorded(s)); return typeof parsed === "object" ? parsed.items.find((entry) => entry.id === id) : undefined; };
    const blocked = setup();
    selfTest(blocked, STAGING, checkerOutput({ "L4.live": "FAIL x | y", "L4.template-db": "FAIL x | y" }, ["TSL BLOCKED the catalog is not signed by a trusted key"]));
    expect(itemOf(blocked, "L4.live")).toEqual({ id: "L4.live", status: "fail", reason: "catalog_untrusted" });
    const pull = setup();
    selfTest(pull, STAGING, checkerOutput({ "L4.live": "FAIL x | y", "L4.template-db": "FAIL x | y", "L1.walls": "FAIL x | y" }, [`TSL ERROR the pull of ${IMAGE.split("@")[0]}/rovara-catalog/staging/svc/postgres@sha256:aa failed`]));
    expect(itemOf(pull, "L4.live")).toEqual({ id: "L4.live", status: "pending", reason: "no_pull_grant" });
    expect(itemOf(pull, "L4.template-db")).toEqual({ id: "L4.template-db", status: "pending", reason: "no_pull_grant" });
    expect(itemOf(pull, "L1.walls")).toEqual({ id: "L1.walls", status: "fail", reason: "check_failed" });
    expect(recorded(pull)).not.toMatch(/944937319445|rovara-catalog|postgres/u);
    const error = setup();
    selfTest(error, STAGING, checkerOutput({ "L3.live": "FAIL x | y" }, ["TSL ERROR pull-list: something broke"]));
    expect(itemOf(error, "L3.live")).toEqual({ id: "L3.live", status: "fail", reason: "driver_error" });
  });

  it("TS-RUN-3 and the egress capture are always pending, with a fixed reason (Redis has no pinned digest in the catalog: `no_pin`)", () => {
    const s = setup();
    selfTest(s, STAGING);
    const parsed = parseSelfTest(recorded(s));
    if (parsed === "absent" || parsed === "unreadable") throw new Error("unreadable");
    expect(parsed.items.filter((entry) => (SELFTEST_ALWAYS_PENDING_IDS as readonly string[]).includes(entry.id))).toEqual([
      { id: "L3.egress-capture", status: "pending", reason: "no_capture" },
      { id: "RUN3.redis-flush", status: "pending", reason: "no_pin" },
      { id: "RUN3.http-reset", status: "pending", reason: "later_slice" },
    ]);
  });

  it("is size-capped: a result that would not fit is recorded as `incomplete: too_large` with no items", () => {
    const s = setup();
    selfTest(s, STAGING, checkerOutput(), (text) => text.replace("readonly TSL_RESULT_MAX_CHARS=3000", "readonly TSL_RESULT_MAX_CHARS=400"));
    const parsed = parseSelfTest(recorded(s));
    expect(parsed).toMatchObject({ state: "incomplete", reason: "too_large", items: [] });
    // And at the real cap, the real result is well inside it.
    const full = setup();
    selfTest(full, STAGING);
    expect((recorded(full) ?? "").length).toBeLessThan(SELFTEST_MAX_CHARS - 500);
  });

  it("the encoder refuses any word that is not on its lists", () => {
    const s = setup();
    const encode = (results: string, state = "ran", reason = "ok") => run(s, `TSL_RESULTS=$'${results}'; tsl_encode ${state} ${reason} 5; echo "rc=$?"`).stdout;
    expect(encode("L1.walls pass ok\\n")).toContain('"items":["L1.walls:pass:ok"]');
    expect(encode("L1.walls pass ok\\n")).toContain("rc=0");
    for (const bad of ["L1.walls pass free_text_here\\n", "L9.nope pass ok\\n", "L1.walls great ok\\n", "L1.walls pass 10.0.0.1\\n"]) expect(encode(bad), bad).toContain("rc=1");
    expect(encode("L1.walls pass ok\\n", "ran", "because")).toContain("rc=1");
    expect(encode("L1.walls pass ok\\n", "done", "ok")).toContain("rc=1");
  });
});

describe("condition 5: the item ids are CI's TS-L ids", () => {
  const first = (text: string, pattern: RegExp) => pattern.exec(text)?.[1] ?? "";
  const shellList = (name: string) => first(stage2, new RegExp(`^readonly ${name}="([^"]*)"$`, "mu")).split(" ");

  it("the ids the checker script prints, in its order, are the ones the boot and the worker list", () => {
    const printed: string[] = [];
    for (const match of checker.matchAll(/\b(?:verdict|pending|live_line|emit) (L[0-9]\.[a-z0-9-]+)/gu)) if (!printed.includes(match[1]!)) printed.push(match[1]!);
    expect(printed).toEqual([...SELFTEST_CI_ITEM_IDS].sort((a, b) => printed.indexOf(a) - printed.indexOf(b)));
    expect(new Set(printed)).toEqual(new Set(SELFTEST_CI_ITEM_IDS));
    expect(shellList("TSL_ITEM_IDS")).toEqual([...SELFTEST_CI_ITEM_IDS]);
    expect(shellList("TSL_PENDING_IDS")).toEqual([...SELFTEST_ALWAYS_PENDING_IDS]);
  });

  it("the live ids are CI's LIVE_IDS; the throwaway workspace key and labels are the script's, the CI script's and the driver's", () => {
    expect(shellList("TSL_LIVE_IDS")).toEqual(first(ciScript, /^readonly LIVE_IDS="([^"]*)"$/mu).split(" "));
    const key = first(stage2, /^readonly TSL_WORKSPACE_KEY=([0-9a-f]+)$/mu);
    expect(key).toHaveLength(16);
    expect(first(checker, /^TSL_WORKSPACE_KEY=([0-9a-f]+)$/mu)).toBe(key);
    expect(first(ciScript, /^readonly TSL_WORKSPACE_KEY=([0-9a-f]+)$/mu)).toBe(key);
    expect(first(driver, /^export const TSL_WORKSPACE = "([0-9a-f]+)";$/mu)).toBe(key);
    expect(first(checker, /^FAMILY_LABEL=(\S+)$/mu)).toBe(first(stage2, /^readonly TSL_FAMILY_LABEL=(\S+)$/mu));
    // The driver containers carry the label the clean-up looks for.
    expect(first(stage2, /^readonly TSL_DRIVER_LABEL=(\S+)$/mu)).toBe("rovara.tsl-selftest");
    expect(checker).toContain("--label rovara.tsl-selftest=1");
    // The working sandbox's network is made as the worker makes it.
    const network = readFileSync(new URL("../../packages/worker/src/task-network.ts", import.meta.url), "utf8");
    expect(network).toContain('TASK_SANDBOX_BRIDGE = "rvbtask"');
    expect(network).toContain('TASK_SANDBOX_NETWORK = "agentx-task"');
    expect(ciScript).toContain("com.docker.network.bridge.name=rvbtask --opt com.docker.network.bridge.enable_icc=false agentx-task");
  });

  it("the boot's states, statuses and reason codes are the worker's lists, word for word", () => {
    expect(shellList("TSL_STATES")).toEqual([...SELFTEST_STATES]);
    expect(shellList("TSL_STATUSES")).toEqual([...SELFTEST_STATUSES]);
    expect(shellList("TSL_REASONS")).toEqual([...SELFTEST_REASONS]);
    expect(first(stage2, /^readonly TSL_RESULT_VARIABLE=(\S+)$/mu)).toBe(TEST_SERVICES_SELFTEST_ENVIRONMENT);
    expect(first(stage2, /^readonly TSL_RESULT_MAX_CHARS=(\d+)$/mu)).toBe(String(SELFTEST_MAX_CHARS));
    // Every reason word the boot records on its own is on the list.
    for (const word of stage2.matchAll(/tsl_record (?:incomplete|unusable|refused) ([a-z_]+)/gu)) expect(SELFTEST_REASONS as readonly string[], word[1]).toContain(word[1]);
  });

  it("the image carries the checker and the built driver where the boot reads them (inside packages/worker, which the image already copies), built before esbuild is pruned", () => {
    expect(first(stage2, /^readonly TSL_BUNDLE_DIR=(\S+)$/mu)).toBe("/opt/agentx/packages/worker/ec2/tsl");
    expect(first(stage2, /^readonly TSL_CATALOG_DIR=(\S+)$/mu)).toBe("/opt/agentx/packages/worker/service-catalog");
    expect(dockerfile).toContain("COPY packages/worker packages/worker");
    expect(dockerfile).toContain("COPY --from=build /opt/agentx/packages/worker ./packages/worker");
    const build = "node_modules/.bin/esbuild --loader:.txt=ts --format=esm --platform=node --target=node22 --log-level=warning --outfile=packages/worker/ec2/tsl/live.mjs packages/worker/ec2/tsl/live-driver.ts.txt";
    expect(dockerfile).toContain(build);
    expect(dockerfile.indexOf(build)).toBeGreaterThan(dockerfile.indexOf("RUN npx tsc -b packages/cloud-contracts packages/verifier packages/worker"));
    expect(dockerfile.indexOf(build)).toBeLessThan(dockerfile.indexOf("RUN npm prune --omit=dev --workspaces"));
    // The boot copies exactly these two files out of the image.
    expect(stage2).toContain('"$id:$TSL_BUNDLE_DIR/checks.sh" "$dir/s.sh"');
    expect(stage2).toContain('"$id:$TSL_BUNDLE_DIR/live.mjs" "$dir/live.mjs"');
  });

  it("the copies in packages/worker/ec2/tsl are byte for byte the scripts CI runs (so the self-test runs CI's checks, and the item ids are CI's)", () => {
    // They are mirrors only so the worker image's inputs and the release pipeline's trigger paths already cover them (scripts/ is neither). Update them together: cp scripts/linux-check-test-services.sh packages/worker/ec2/tsl/checks.sh
    // and cp scripts/linux-check-test-services-live.ts packages/worker/ec2/tsl/live-driver.ts.txt.
    expect(readFileSync(new URL("../../packages/worker/ec2/tsl/checks.sh", import.meta.url), "utf8")).toBe(checker);
    expect(readFileSync(new URL("../../packages/worker/ec2/tsl/live-driver.ts.txt", import.meta.url), "utf8")).toBe(driver);
  });
});

describe("what the self-test pulls", () => {
  it("only the driver pulls, and only the images the signed catalog pins by digest (Postgres); the boot's own code pulls nothing", () => {
    const block = stage2.slice(stage2.indexOf("readonly TSL_SELFTEST_VARIABLE"), stage2.indexOf("# What boot.sh's main did after the worker image was pulled"));
    expect(block).not.toMatch(/docker (?:pull|login)|ecr get-login|\$\{?TSL_DOCKER_CONFIG/u);
    // The checker's own pull is by digest under the worker role's catalog repositories, with a Docker config of its own.
    expect(checker).toMatch(/\^\$reg\/rovara-catalog\/\$TSL_ENV\/svc\/\(\[a-z0-9\._-\]\+\)@sha256:/u);
    expect(checker).toContain('DOCKER_CONFIG="$TSL_DOCKER_CONFIG"');
  });

  it("the worker role's existing catalog grant covers the repositories of both check images (svc/postgres and svc/redis); Redis has no pinned digest to pull", () => {
    const settings = readFileSync(new URL("../../infra/lib/worker-settings.ts", import.meta.url), "utf8");
    expect(settings).toContain('Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]');
    expect(settings).toContain("repository/${CATALOG_REGISTRY_ROOT}/${env}/svc/*");
    const catalog = JSON.parse(readFileSync(new URL("../../environments/service-catalog/catalog.json", import.meta.url), "utf8")) as { entries: Array<{ id: string; image: { repository: string; digest?: string } }> };
    const redis = catalog.entries.filter((entry) => entry.image.repository === "svc/redis");
    const postgres = catalog.entries.filter((entry) => entry.image.repository === "svc/postgres" && entry.image.digest !== undefined);
    expect(postgres.length).toBeGreaterThan(0);
    expect(redis.length).toBeGreaterThan(0);
    expect(redis.every((entry) => entry.image.digest === undefined)).toBe(true);
  });
});
