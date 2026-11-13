import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  SELFTEST_ALWAYS_PENDING_IDS, SELFTEST_CI_ITEM_IDS, SELFTEST_EXTRA_IDS, SELFTEST_ITEM_IDS, SELFTEST_MAX_CHARS, SELFTEST_REASONS, SELFTEST_STATES, SELFTEST_STATUSES, parseSelfTest,
} from "../../packages/worker/src/test-services-selftest.js";

// The opt-in TS-L self-test of boot-stage2.sh (`run_tsl_selftest`), run for real in bash with fake docker, iptables, ip, curl, timeout and the like on PATH and the script's system paths pointed at a temporary folder. The release gate's five
// conditions (session 89) and the Opus review's findings (2026-11-12) are each a group of tests below.
const stage2 = readFileSync(new URL("../../packages/worker/ec2/boot-stage2.sh", import.meta.url), "utf8");
const checker = readFileSync(new URL("../../scripts/linux-check-test-services.sh", import.meta.url), "utf8");
const ciScript = readFileSync(new URL("../../scripts/ci-test-services-linux.sh", import.meta.url), "utf8");
const driver = readFileSync(new URL("../../scripts/linux-check-test-services-live.ts", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../../environments/base/Dockerfile", import.meta.url), "utf8");
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const STAGING_ACCOUNT = "944937319445";
const IMAGE = `${STAGING_ACCOUNT}.dkr.ecr.us-west-2.amazonaws.com/agentx-worker@sha256:${"d".repeat(64)}`;
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

interface Setup { dir: string; bin: string; state: string; result: string; calls: string; log: string; vartmp: string; fixtures: string }

function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), "ec2-tsl-selftest-"));
  roots.push(dir);
  const s: Setup = { dir, bin: join(dir, "bin"), state: join(dir, "state"), result: join(dir, "run", "tsl-selftest"), calls: join(dir, "calls"), log: join(dir, "log"), vartmp: join(dir, "vartmp"), fixtures: join(dir, "fixtures") };
  for (const d of [s.bin, s.state, s.vartmp, s.fixtures]) mkdirSync(d);
  for (const file of [s.calls, s.log]) writeFileSync(file, "");
  for (const file of ["containers_driver", "containers_ws", "networks_ws", "volumes_ws"]) writeFileSync(join(s.state, file), "");
  writeFileSync(join(s.fixtures, "checks.sh"), [
    "#!/bin/bash",
    'echo "checks mode=${TSL_DIR:+live}${TSL_DIR:-host}" >>"$CALLS_FILE"',
    'cat "$CHECKS_OUT"',
    // A live run makes things: a container, a network and a volume carrying the throwaway key, a pulled image, a rule, a route and an interface (the fakes read these files).
    'if [[ -n "${TSL_DIR:-}" ]]; then echo c1 >>"$STATE/containers_ws"; echo n1 >>"$STATE/networks_ws"; echo v1 >>"$STATE/volumes_ws"; : >"$STATE/pulled"; : >"$STATE/rule"; : >"$STATE/iface"; [[ -z "${MAKE_REORDER:-}" ]] || : >"$STATE/reorder"; fi',
  ].join("\n"));
  writeFileSync(join(s.fixtures, "live.mjs"), "// driver\n");
  writeFileSync(join(s.fixtures, "catalog.json"), "{}\n");
  writeFileSync(join(s.fixtures, "catalog.sig.json"), "{}\n");
  writeFileSync(join(s.fixtures, "catalog-build-flavor.js"), 'export const CATALOG_BUILD_FLAVOR = "staging";\n');
  writeFileSync(join(s.fixtures, "catalog-build-flavor.release.js"), 'export const CATALOG_BUILD_FLAVOR = "release";\n');
  const tool = (name: string, body: string) => { writeFileSync(join(s.bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(s.bin, name), 0o755); };
  tool("timeout", [
    'while [[ "$1" == --* ]]; do shift; done; shift',
    // A forced timeout: the live checker never finishes (the real timeout kills it); nothing it would have made exists.
    'if [[ "${FORCE_TIMEOUT:-}" == 1 && -n "${TSL_DIR:-}" && "$*" == *s.sh* ]]; then echo "checks timed-out" >>"$CALLS_FILE"; exit 124; fi',
    'exec "$@"',
  ].join("\n"));
  tool("curl", [
    '[[ -z "${CURL_FAIL:-}" ]] || exit 22',
    'case "$*" in *api/token*) echo TOKEN ;; *instance-identity/document*) printf \'{"accountId" : "%s", "region" : "us-west-2"}\\n\' "${ACCOUNT:-944937319445}" ;; *) exit 22 ;; esac',
  ].join("\n"));
  tool("launcher", 'echo "launcher $*" >>"$CALLS_FILE"; exit "${WALLS_RC:-0}"');
  tool("docker", [
    'echo "docker $*" >>"$CALLS_FILE"',
    '[[ -z "${DOCKER_DOWN:-}" ]] || exit 1',
    '[[ -z "${DOCKER_DOWN_AFTER_RUN:-}" || ! -e "$STATE/rule" ]] || exit 1',
    // Once the labelled objects are gone, Docker has taken their rules, routes and bridge away too (unless the test leaks them).
    'settle() { [[ -s "$STATE/networks_ws" || -s "$STATE/containers_ws" || -e "$STATE/tasknet_ours" ]] || { [[ -n "${LEAK_RULE:-}" ]] || rm -f "$STATE/rule" "$STATE/reorder"; [[ -n "${LEAK_IFACE:-}" || -n "${LATE_IFACE:-}" ]] || rm -f "$STATE/iface"; }; }',
    'trap settle EXIT',
    'case "$1" in',
    '  version) echo "${DOCKER_VERSION:-25.0.18}" ;;',
    '  ps) if [[ "$*" == *rovara.tsl-selftest=1* ]]; then cat "$STATE/containers_driver"; else cat "$STATE/containers_ws"; fi ;;',
    '  rm) shift; [[ "$1" == -f ]] && shift; [[ "$1" == -v ]] && shift; if [[ "$1" == abcdef123456 ]]; then exit 0; fi; for id in "$@"; do',
    '        [[ -n "${LEAK_CONTAINER:-}" ]] && continue; sed -i.bak "/^$id\\$/d" "$STATE/containers_ws" "$STATE/containers_driver"; done ;;',
    '  network) case "$2" in',
    '    ls) if [[ "$*" == *name=* ]]; then [[ -e "$STATE/tasknet" ]] && echo tasknet; exit 0; fi',
    '        if [[ "$*" == *rovara.tsl-selftest=1* ]]; then [[ -e "$STATE/tasknet_ours" ]] && echo tasknet; exit 0; fi; cat "$STATE/networks_ws" ;;',
    '    create) [[ -z "${TASKNET_EXISTS:-}" ]] || exit 1; : >"$STATE/tasknet"; : >"$STATE/tasknet_ours" ;;',
    '    rm) shift 2; for id in "$@"; do if [[ "$id" == tasknet ]]; then [[ -n "${LEAK_TASKNET:-}" ]] || rm -f "$STATE/tasknet" "$STATE/tasknet_ours"; else [[ -n "${LEAK_NETWORK:-}" ]] || : >"$STATE/networks_ws"; fi; done ;;',
    '    esac ;;',
    '  volume) case "$2" in',
    '    ls) cat "$STATE/volumes_ws" ;;',
    '    rm) [[ -n "${LEAK_VOLUME:-}" ]] || : >"$STATE/volumes_ws" ;;',
    '    esac ;;',
    '  image) case "$2" in',
    '    ls) echo sha256:base; [[ -e "$STATE/pulled" ]] && echo sha256:pulled; exit 0 ;;',
    '    rm) [[ "$4" == sha256:pulled ]] && rm -f "$STATE/pulled"; exit 0 ;;',
    '    esac ;;',
    '  create) echo abcdef123456 ;;',
    '  cp) src=${2#*:}; dest=$3; base=$(basename "$src"); [[ -n "${NO_BUNDLE:-}" && "$base" != catalog-build-flavor.js ]] && exit 1',
    '      if [[ "$base" == catalog-build-flavor.js && "${FLAVOR:-staging}" != staging ]]; then base=catalog-build-flavor.release.js; fi',
    '      [[ "$base" == catalog-build-flavor.js && -n "${NO_FLAVOR_FILE:-}" ]] && exit 1; cp "$FIXTURES/$base" "$dest" ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join("\n"));
  tool("iptables", [
    '[[ "$*" == *"-t raw"* && -n "${NO_RAW:-}" ]] && exit 3',
    'table=filter; [[ "$1" == -t ]] && table=$2',
    'if [[ "$table" == nat ]]; then echo "-P PREROUTING ACCEPT"; exit 0; fi',
    'if [[ "$table" != filter ]]; then echo "-P PREROUTING ACCEPT"; exit 0; fi',
    'echo "-P FORWARD DROP"',
    'if [[ -e "$STATE/reorder" ]]; then echo "-A DOCKER-USER -d 10.0.0.0/8 -j RETURN"; echo "-A DOCKER-USER -i rvi+ ! -o rvi+ -j DROP"; else echo "-A DOCKER-USER -i rvi+ ! -o rvi+ -j DROP"; echo "-A DOCKER-USER -d 10.0.0.0/8 -j RETURN"; fi',
    'if [[ -e "$STATE/rule" ]]; then echo "-A DOCKER-FORWARD -i rvi1234abcd -j DROP"; fi',
  ].join("\n"));
  tool("ip", [
    'case "$*" in',
    '  *"-o link"*) echo "1: lo: <LOOPBACK> mtu 65536"; echo "2: ens5: <BROADCAST> mtu 9001"',
    '     if [[ -e "$STATE/iface" ]]; then',
    '       if [[ -n "${LATE_IFACE:-}" ]]; then n=$(cat "$STATE/linkcalls" 2>/dev/null || echo 0); n=$((n + 1)); echo $n >"$STATE/linkcalls"; if ((n >= 2)); then rm -f "$STATE/iface"; fi; fi',
    '       [[ ! -e "$STATE/iface" ]] || echo "9: rvi1234abcd: <BROADCAST> mtu 1500"',
    '     fi ;;',
    '  *"-4 route"*) echo "default via 10.0.0.1 dev ens5"; [[ ! -e "$STATE/iface" ]] || echo "172.30.0.0/24 dev rvi1234abcd" ;;',
    '  *"-6 route"*) echo "::1 dev lo" ;;',
    '  *rule*) echo "0: from all lookup local" ;;',
    'esac',
  ].join("\n"));
  tool("sleep", "exit 0");
  return s;
}

/** Runs `body` in bash with stage 2 sourced from a copy whose system paths are the test's. */
function run(s: Setup, body: string, env: Record<string, string> = {}, tweak: (text: string) => string = (text) => text) {
  const text = tweak(stage2
    .replaceAll("/var/tmp/", `${s.vartmp}/`)
    .replace("readonly TSL_RESULT_FILE=/run/agentx/tsl-selftest", `readonly TSL_RESULT_FILE=${s.result}`)
    .replace("readonly TSL_LAUNCHER=/usr/local/libexec/agentx-worker-start", `readonly TSL_LAUNCHER=${join(s.bin, "launcher")}`)
    .replace("readonly WORKER_ENV_FILE=/etc/agentx/worker.env", `readonly WORKER_ENV_FILE=${join(s.dir, "worker.env")}`));
  const file = join(s.dir, "stage2.sh");
  writeFileSync(file, text);
  const script = [
    "set -u",
    `log() { printf '%s\\n' "$*" >>"$LOG_FILE"; }`,
    `imds_once() { [[ "$1" == ami-id ]] && printf '%s\\n' "\${FAKE_AMI-ami-0d2beaff07e79c24e}"; }`,
    "BOOT_DEADLINE=$((SECONDS + ${DEADLINE_IN:-700}))",
    `source "${file}"`,
    body,
  ].join("\n");
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: `${s.bin}:/usr/bin:/bin:/usr/sbin:/sbin`, LOG_FILE: s.log, CALLS_FILE: s.calls, STATE: s.state, FIXTURES: s.fixtures, HOME: s.dir, TMPDIR: s.dir, ...env },
  });
}
const callsOf = (s: Setup) => readFileSync(s.calls, "utf8");
const logOf = (s: Setup) => readFileSync(s.log, "utf8");
const recorded = (s: Setup): string | undefined => (existsSync(s.result) ? readFileSync(s.result, "utf8").trim() : undefined);
const SELFTEST = 'run_tsl_selftest "$INSTANCE_ID"; echo "rc=$?"';
function selfTest(s: Setup, env: Record<string, string>, output = checkerOutput(), tweak?: (text: string) => string) {
  const out = join(s.dir, "checks.out");
  writeFileSync(out, output);
  return run(s, SELFTEST, { INSTANCE_ID: INSTANCE, CHECKS_OUT: out, ...env }, tweak);
}
/** The parsed result, or a failed test. */
function parsedOf(s: Setup) {
  const parsed = parseSelfTest(recorded(s));
  if (typeof parsed !== "object") throw new Error(`the result is ${parsed}: ${recorded(s) ?? "nothing recorded"}`);
  return parsed;
}

const block = stage2.slice(stage2.indexOf("# TS-L worker self-test (OPT-IN"), stage2.indexOf("# What boot.sh's main did after the worker image was pulled"));
const stage2Main = /^stage2_main\(\) \{\n([\s\S]*?)^\}$/mu.exec(stage2)?.[1] ?? "";
const launcher = /<<'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/u.exec(stage2)?.[1] ?? "";

describe("condition 1: off by default, staging only, and only on a build and an account a launch cannot fake", () => {
  it("does nothing at all without the opt-in: no docker call, no curl, no file, no result", () => {
    const s = setup();
    const off = selfTest(s, { ...STAGING, AGENTX_TSL_SELFTEST: "" });
    expect(off.stdout).toContain("rc=0");
    expect(callsOf(s)).toBe("");
    expect(recorded(s)).toBeUndefined();
    expect(readdirSync(s.vartmp)).toEqual([]);
    for (const value of ["0", "true", "yes", "11", " 1"]) {
      const other = setup();
      expect(selfTest(other, { ...STAGING, AGENTX_TSL_SELFTEST: value }).stdout).toContain("rc=0");
      expect(callsOf(other), value).toBe("");
      expect(recorded(other), value).toBeUndefined();
    }
    const unset = setup();
    const without = { ...STAGING };
    delete without["AGENTX_TSL_SELFTEST"];
    expect(selfTest(unset, without).stdout).toContain("rc=0");
    expect(callsOf(unset)).toBe("");
    expect(recorded(unset)).toBeUndefined();
  });

  it("refuses in production, and in any environment that is not exactly staging: records `refused`, starts nothing", () => {
    for (const logGroup of ["/agentx/production/worker", "/agentx/prod/worker", "/agentx/staging2/worker", "/agentx/Staging/worker", "/agentx/staging/worker/x", "", "/agentx/staging"]) {
      const s = setup();
      expect(selfTest(s, { ...STAGING, AGENTX_LOG_GROUP: logGroup }).stdout, logGroup).toContain("rc=0");
      expect(parsedOf(s), logGroup).toMatchObject({ state: "refused", reason: "not_staging", items: [], extra: [] });
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
    expect(parsedOf(s)).toMatchObject({ state: "refused", reason: "not_named" });
    expect(callsOf(s)).not.toContain("docker create");
  });

  it("refuses on an account that is not the staging account: the image's registry account, the instance identity document's, or an identity document that cannot be read (M2)", () => {
    for (const [name, env] of [
      ["the identity document names another account", { ACCOUNT: "111122223333" }],
      ["the image is from another account", { AGENTX_WORKER_IMAGE: IMAGE.replace(STAGING_ACCOUNT, "111122223333") }],
      ["the identity document cannot be read", { CURL_FAIL: "1" }],
    ] as const) {
      const s = setup();
      expect(selfTest(s, { ...STAGING, ...env }).stdout, name).toContain("rc=0");
      expect(parsedOf(s), name).toMatchObject({ state: "refused", reason: "wrong_account", items: [] });
      expect(callsOf(s), name).not.toContain("docker create");
      expect(callsOf(s), name).not.toContain("launcher");
    }
  });

  it("refuses an image that is not a staging build (the flavor file says release, or is not there), and cleans up what it made to look (M2)", () => {
    for (const env of [{ FLAVOR: "release" }, { NO_FLAVOR_FILE: "1" }]) {
      const s = setup();
      expect(selfTest(s, { ...STAGING, ...env }).stdout).toContain("rc=0");
      expect(parsedOf(s)).toMatchObject({ state: "refused", reason: "not_staging_image", items: [] });
      // No check ran, and the container the boot made to read the flavor is gone.
      expect(callsOf(s)).not.toContain("checks mode");
      expect(readFileSync(join(s.state, "containers_driver"), "utf8").trim()).toBe("");
      expect(readdirSync(s.vartmp)).toEqual([]);
    }
  });

  it("runs on a named staging environment, on a staging build, in the staging account", () => {
    const s = setup();
    expect(selfTest(s, STAGING).stdout).toContain("rc=0");
    expect(parsedOf(s)).toMatchObject({ state: "ran", reason: "ok" });
  });

  it("the account is the staging account the contracts name, the flavor file is the one the image build writes, and a release image carries no checks at all", () => {
    expect(stage2).toContain(`readonly TSL_ALLOWED_ACCOUNT=${/CATALOG_STAGING_ACCOUNT_ID = "(\d{12})"/u.exec(readFileSync(new URL("../../packages/cloud-contracts/src/catalog-trust-core.ts", import.meta.url), "utf8"))?.[1] ?? "?"}`);
    expect(stage2).toContain("readonly TSL_FLAVOR_FILE=/opt/agentx/packages/cloud-contracts/dist/catalog-build-flavor.js");
    expect(dockerfile).toContain('grep -q "CATALOG_BUILD_FLAVOR = \\"$CATALOG_FLAVOR\\";" packages/cloud-contracts/dist/catalog-build-flavor.js');
    expect(block).toContain('CATALOG_BUILD_FLAVOR = "staging";');
    expect(dockerfile).toMatch(/RUN if \[ "\$CATALOG_FLAVOR" = staging \]; then \\\n[\s\S]*?else rm -rf packages\/worker\/ec2\/tsl; fi/u);
  });

  it("reads the opt-in from the launch environment only: the gate names no SSM parameter, no AWS call and no file", () => {
    const gate = /^tsl_selftest_gate\(\) \{[\s\S]*?^\}$/mu.exec(stage2)?.[0] ?? "";
    expect(gate).toContain("AGENTX_TSL_SELFTEST");
    expect(gate).not.toMatch(/aws |ssm|cat |curl/u);
    // Nothing else in the repository's launch (control plane, broker, boot configuration) sets it (the M1 owner decision: packages/worker/ec2/README.md).
    for (const file of ["../../infra/lib/control-plane.ts", "../../infra/lib/worker-settings.ts", "../../packages/broker/src/aws/session-steps.ts", "../../packages/broker/src/aws/private-address-launch.ts"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).not.toContain("AGENTX_TSL_SELFTEST");
    }
  });
});

describe("condition 2: never blocks the boot (the WHOLE self-test ends before the boot deadline), never touches the worker's own walls", () => {
  it("has its own time budget: a timeout records `incomplete` and the host-only items still count", () => {
    const s = setup();
    expect(selfTest(s, { ...STAGING, FORCE_TIMEOUT: "1" }).stdout).toContain("rc=0");
    const parsed = parsedOf(s);
    expect(parsed).toMatchObject({ state: "incomplete", reason: "budget" });
    expect(parsed.items.find((item) => item.id === "L1.live")).toEqual({ id: "L1.live", status: "incomplete", reason: "budget" });
    expect(parsed.items.find((item) => item.id === "L1.walls")).toEqual({ id: "L1.walls", status: "pass", reason: "ok" });
    expect(callsOf(s)).toContain("checks mode=host");
  });

  it("the checks plus the reserve for everything after them always fit before the boot deadline (H1): the budget shrinks with the time left, and under 45 s nothing starts", () => {
    const s = setup();
    const budgets = (deadlines: number[], extra = "") => run(s, deadlines.map((d) => `BOOT_DEADLINE=$((SECONDS + ${d})); ${extra} tsl_budget_seconds`).join("; ")).stdout.trim().split("\n").map(Number);
    expect(budgets([700, 400, 300, 250, 195, 194, 100, -5])).toEqual([170, 170, 150, 100, 45, 44, -50, -155]);
    expect(budgets([700, 400], "TSL_SELFTEST_BUDGET_S=90;")).toEqual([90, 90]);
    expect(budgets([700], "TSL_SELFTEST_BUDGET_S=5;")).toEqual([170]);
    expect(budgets([700], "TSL_SELFTEST_BUDGET_S=abc;")).toEqual([170]);
    expect(budgets([700], "TSL_SELFTEST_BUDGET_S=9999;")).toEqual([170]);
    // For every deadline the whole thing (budget, then the reserve) ends no later than the deadline.
    for (const d of [195, 230, 300, 480]) {
      const [budget] = budgets([d]);
      expect(budget! + 150, `deadline in ${d}`).toBeLessThanOrEqual(d);
    }
    expect(stage2).toContain("readonly TSL_RESERVE_S=150");
  });

  it("does not start when it would not fit: `incomplete: no_time`, and nothing is created or touched", () => {
    const late = setup();
    const refused = selfTest(late, { ...STAGING, DEADLINE_IN: "180" });
    expect(refused.stdout).toContain("rc=0");
    expect(parsedOf(late)).toMatchObject({ state: "incomplete", reason: "no_time", items: [], extra: [] });
    expect(callsOf(late)).not.toContain("docker create");
    expect(callsOf(late)).not.toContain("launcher");
    expect(readdirSync(late.vartmp)).toEqual([]);
    // With the time, the same launch runs.
    const roomy = setup();
    selfTest(roomy, { ...STAGING, DEADLINE_IN: "400" });
    expect(parsedOf(roomy)).toMatchObject({ state: "ran" });
  });

  it("the checks never run into the time kept for what follows them: if the steps before them used it up, nothing runs, the clean-up is proven, and the result is `incomplete: no_time`", () => {
    const s = setup();
    expect(selfTest(s, STAGING, checkerOutput(), (text) => text.replace("readonly TSL_AFTER_CHECKS_S=100", "readonly TSL_AFTER_CHECKS_S=9999")).stdout).toContain("rc=0");
    expect(parsedOf(s)).toMatchObject({ state: "incomplete", reason: "no_time", items: [], extra: [] });
    expect(callsOf(s)).not.toContain("checks mode");
    expect(readdirSync(s.vartmp)).toEqual([]);
    for (const file of ["containers_ws", "containers_driver", "networks_ws"]) expect(readFileSync(join(s.state, file), "utf8").trim(), file).toBe("");
    expect(block).toContain('tsl_run_checks live "$run_s"');
  });

  it("skips the extra read-only pass when too little of its time is left, and says `no_time` for every item", () => {
    const s = setup();
    // A timeout late in the self-test's own time (made here by raising what the extra pass needs) leaves too little for it.
    selfTest(s, { ...STAGING, FORCE_TIMEOUT: "1" }, checkerOutput(), (text) => text.replace("readonly TSL_HOST_PASS_NEEDS_S=90", "readonly TSL_HOST_PASS_NEEDS_S=9999"));
    expect(parsedOf(s)).toMatchObject({ state: "incomplete", reason: "budget" });
    expect(parsedOf(s).items.filter((item) => (SELFTEST_CI_ITEM_IDS as readonly string[]).includes(item.id)).every((item) => item.status === "incomplete" && item.reason === "no_time")).toBe(true);
    expect(callsOf(s)).not.toContain("checks mode=host");
  });

  it("a Docker that is not there, or a bundle that is not in the image, is `incomplete`, never a failed boot", () => {
    const down = setup();
    expect(selfTest(down, { ...STAGING, DOCKER_DOWN: "1" }).stdout).toContain("rc=0");
    expect(parsedOf(down)).toMatchObject({ state: "incomplete", reason: "docker_unavailable" });
    const old = setup();
    expect(selfTest(old, { ...STAGING, NO_BUNDLE: "1" }).stdout).toContain("rc=0");
    expect(parsedOf(old)).toMatchObject({ state: "incomplete", reason: "bundle_missing" });
    expect(readdirSync(old.vartmp)).toEqual([]);
    expect(readFileSync(join(old.state, "containers_driver"), "utf8")).toBe("");
  });

  it("is bounded as a whole: past its hard deadline no Docker command runs and no snapshot is taken, so a wedged daemon cannot hold the boot, and what cannot be read back stops the worker", () => {
    const s = setup();
    const result = run(s, 'TSL_HARD_DEADLINE=$((SECONDS - 1)); tsl_dk version; echo "late=$?"; TSL_HARD_DEADLINE=$((SECONDS + 100)); tsl_dk version; echo "inside=$?"; TSL_HARD_DEADLINE=$((SECONDS - 1)); TSL_SNAPSHOT_BEFORE=$(mktemp); tsl_snapshot "$TSL_SNAPSHOT_BEFORE"; echo "snapshot=$?"; tsl_readback; echo "readback=$?"; tsl_readback_settled; echo "settled=$?"');
    expect(result.stdout).toContain("late=124");
    expect(result.stdout).toContain("inside=0");
    expect(result.stdout).toContain("snapshot=1");
    expect(result.stdout).toContain("readback=1");
    expect(result.stdout).toContain("settled=1");
    expect(callsOf(s).trim().split("\n")).toEqual(["docker version"]);
    // The hard deadline is the checks' budget plus the reserve, so it is never after the boot deadline.
    expect(block).toContain("TSL_HARD_DEADLINE=$((SECONDS + budget + TSL_RESERVE_S))");
  });

  it("validates its one tuning seam: a Docker command timeout that is not 1 to 999 seconds is the default (L5)", () => {
    const s = setup();
    for (const bad of ["abc", "0", "-3", "1000", ""]) {
      const result = run(s, 'tsl_dk version; echo "rc=$?"', { TSL_COMMAND_TIMEOUT_S: bad });
      expect(result.stdout, bad).toContain("rc=0");
    }
    expect(selfTest(setup(), { ...STAGING, TSL_COMMAND_TIMEOUT_S: "abc" }).stdout).toContain("rc=0");
  });

  it("every Docker command goes through the bounded wrapper, and the block never writes the worker's walls, units, daemon settings or launcher", () => {
    expect(block.length).toBeGreaterThan(5_000);
    // No rule is ever added, inserted, deleted, flushed or created; only read (`-S`).
    expect(block).not.toMatch(/ip6?tables [^\n]*(?:-[IADFXNRZP]\b| -C )/u);
    expect(block).not.toMatch(/systemctl|daemon\.json|write_worker|write_private|block_imds|wall_|withhold_|install_run_walls|rovara-private-allow|rovara-container-firewall/u);
    const outsideWrapper = block.replace(/^tsl_dk\(\) \{[\s\S]*?^\}$/mu, "").split("\n").filter((line) => /(?:^|[\s;(|&])docker (?!version\b)(?:ps|rm|network|image|create|cp|run|pull|login|volume)\b/u.test(line) && !line.trimStart().startsWith("#"));
    expect(outsideWrapper).toEqual([]);
    // The checks run under one timeout that kills the process group (no --foreground: that would signal only the script).
    const runChecks = /^tsl_run_checks\(\) \{[\s\S]*?^\}$/mu.exec(block)?.[0] ?? "";
    expect(runChecks).toContain("timeout --kill-after=10s");
    expect(runChecks).not.toContain("--foreground");
  });

  it("the worker's walls (metadata, setup, internal-address) are applied BEFORE the checks, by the launcher's own steps, so the checks and the `before` snapshot see the firewall tasks get (M5)", () => {
    const s = setup();
    selfTest(s, STAGING);
    const calls = callsOf(s).split("\n");
    const at = (prefix: string) => calls.findIndex((call) => call.startsWith(prefix));
    expect(at("launcher --walls-only")).toBeGreaterThan(-1);
    expect(at("launcher --walls-only")).toBeLessThan(at("docker create"));
    expect(at("launcher --walls-only")).toBeLessThan(at("checks mode=live"));
    // The launcher stops there: right after the internal-address step and before anything that prepares or starts a worker.
    const stop = launcher.indexOf('[[ "${1:-}" != --walls-only ]] || exit 0');
    expect(stop).toBeGreaterThan(launcher.indexOf("block_imds ||"));
    expect(stop).toBeGreaterThan(launcher.indexOf("/usr/local/libexec/rovara-private-allow ||"));
    expect(stop).toBeLessThan(launcher.indexOf("prepare_test_services_run_dir() {"));
    expect(stop).toBeLessThan(launcher.indexOf('exec "$docker" "${args[@]}"'));
    // If the walls cannot be applied nothing runs.
    const broken = setup();
    expect(selfTest(broken, { ...STAGING, WALLS_RC: "1" }).stdout).toContain("rc=0");
    expect(parsedOf(broken)).toMatchObject({ state: "incomplete", reason: "walls_failed" });
    expect(callsOf(broken)).not.toContain("docker create");
  });

  it("is called after every wall step and the worker's unit is written, and BEFORE the unit is started; the return code is the only thing that can fail the boot", () => {
    const at = (text: string) => stage2Main.indexOf(text);
    expect(at("run_tsl_selftest")).toBeGreaterThan(at("write_private_addresses"));
    expect(at("run_tsl_selftest")).toBeGreaterThan(at("install_run_walls_unit"));
    expect(at("run_tsl_selftest")).toBeGreaterThan(at("write_worker_unit"));
    expect(at("run_tsl_selftest")).toBeLessThan(at('systemctl enable --now "$WORKER_UNIT"'));
    expect(stage2Main).toContain('run_tsl_selftest "$instance_id" || tsl_status=$?');
    expect(stage2Main).toMatch(/\(\(tsl_status == 0\)\) \|\| fail "the TS-L self-test left test objects/u);
    expect(spawnSync("bash", ["-n"], { input: stage2, encoding: "utf8" }).status).toBe(0);
    // The comment says what is true: the launcher's wall steps are applied first by the self-test itself.
    expect(stage2Main).not.toContain("after every wall and before");
    expect(stage2Main).toContain("it applies the launcher's own wall steps first");
  });
});

describe("condition 3: clean-up is proven before the worker takes work", () => {
  it("a run that leaves nothing behind: everything it made is removed and read back, and the boot goes on (rc 0)", () => {
    const s = setup();
    expect(selfTest(s, STAGING).stdout).toContain("rc=0");
    expect(parsedOf(s)).toMatchObject({ state: "ran", reason: "ok" });
    // The checks made a container, a network, a volume, an image, a rule, a route and an interface; all are gone.
    for (const file of ["containers_ws", "networks_ws", "containers_driver", "volumes_ws"]) expect(readFileSync(join(s.state, file), "utf8").trim(), file).toBe("");
    for (const file of ["pulled", "rule", "iface", "tasknet", "tasknet_ours"]) expect(existsSync(join(s.state, file)), file).toBe(false);
    expect(readdirSync(s.vartmp)).toEqual([]);
    // The working sandbox's network was made for the checks, with the fixed label, and removed; it is the worker's to make later.
    expect(callsOf(s)).toContain("docker network create --driver bridge --opt com.docker.network.bridge.name=rvbtask --opt com.docker.network.bridge.enable_icc=false --label rovara.tsl-selftest=1 agentx-task");
    expect(callsOf(s)).toContain("docker network rm tasknet");
    expect(callsOf(s)).toContain("docker image rm -f sha256:pulled");
    expect(callsOf(s)).not.toContain("sha256:base");
  });

  it("leaves a network that was there before the self-test alone (the worker's own agentx-task after a reboot carries no self-test label)", () => {
    const s = setup();
    writeFileSync(join(s.state, "tasknet"), "");
    expect(selfTest(s, STAGING).stdout).toContain("rc=0");
    expect(callsOf(s)).not.toContain("docker network rm tasknet");
    expect(existsSync(join(s.state, "tasknet"))).toBe(true);
  });

  const LEAKS: Array<[string, Record<string, string>, string]> = [
    ["a container that cannot be removed", { LEAK_CONTAINER: "1" }, "containers"],
    ["a network that cannot be removed", { LEAK_NETWORK: "1" }, "networks"],
    ["a volume that cannot be removed", { LEAK_VOLUME: "1" }, "volumes"],
    ["the working sandbox's network (found by its label, not by a flag)", { LEAK_TASKNET: "1" }, "networks"],
    ["an iptables rule the checks added", { LEAK_RULE: "1" }, "rules"],
    ["a bridge interface and its route", { LEAK_IFACE: "1" }, "routes"],
    ["rules that came back in another ORDER (nothing was added or removed)", { MAKE_REORDER: "1", LEAK_RULE: "1" }, "rules"],
    ["a Docker that stops answering after the checks (nothing can be read back)", { DOCKER_DOWN_AFTER_RUN: "1" }, "docker"],
  ];
  for (const [name, leak, part] of LEAKS) {
    it(`NOT gone (${name}): rc 75, recorded as unusable, the part is logged as a fixed word, and the boot fails before the worker can start`, () => {
      const s = setup();
      expect(selfTest(s, { ...STAGING, ...leak }).stdout).toContain("rc=75");
      expect(parsedOf(s)).toMatchObject({ state: "unusable", reason: "cleanup_failed" });
      expect(logOf(s)).toContain(`the clean-up could not be read back (${part})`);
      // It tried a second round of clean-up before it gave up.
      expect((callsOf(s).match(/docker ps -a -q --filter label=rovara\.tsl-selftest=1/gu) ?? []).length).toBeGreaterThanOrEqual(4);
      // The temporary files of the self-test are tidied on this path too (L6).
      expect(readdirSync(s.dir).filter((entry) => entry.startsWith("tmp.") || entry.startsWith("tsl"))).toEqual([]);
    });
  }

  it("the read-back is compared IN ORDER, not sorted: a rule moved is a difference (M3)", () => {
    const snapshot = /^tsl_snapshot\(\) \{[\s\S]*?^\}$/mu.exec(block)?.[0] ?? "";
    expect(snapshot).not.toMatch(/\bsort\b/u);
    const s = setup();
    const result = run(s, 'a=$(mktemp); b=$(mktemp); tsl_snapshot "$a"; : >"$STATE/reorder"; tsl_snapshot "$b"; cmp -s "$a" "$b"; echo "same=$?"; sort "$a" | cmp -s - <(sort "$b"); echo "sortedsame=$?"');
    expect(result.stdout).toContain("same=1");
    expect(result.stdout).toContain("sortedsame=0");
  });

  it("the snapshot covers filter, nat, mangle and raw for IPv4 and IPv6, the nft ruleset, routes of every table, ip rules and interfaces (M3)", () => {
    const snapshot = /^tsl_snapshot\(\) \{[\s\S]*?^\}$/mu.exec(block)?.[0] ?? "";
    expect(snapshot).toContain("for table in filter nat mangle raw");
    expect(snapshot).toContain("for tool in iptables ip6tables");
    expect(snapshot).toContain("nft -s list ruleset");
    expect(snapshot).toContain("ip -4 route show table all");
    expect(snapshot).toContain("ip -6 route show table all");
    expect(snapshot).toContain("ip rule show");
    expect(snapshot).toContain("ip -o link show");
    const s = setup();
    const out = join(s.dir, "snap");
    run(s, `tsl_snapshot "${out}"`);
    const text = readFileSync(out, "utf8");
    for (const part of ["iptables:filter ", "iptables:nat ", "iptables:mangle ", "iptables:raw ", "route4 ", "route6 ", "rule ", "link "]) expect(text, part).toContain(part);
    // A table the kernel does not have (raw loads on demand) is recorded as unreadable rather than failing the self-test; filter and nat must be readable.
    const noRaw = setup();
    expect(selfTest(noRaw, { ...STAGING, NO_RAW: "1" }).stdout).toContain("rc=0");
    expect(parsedOf(noRaw)).toMatchObject({ state: "ran" });
  });

  it("a bridge that goes a moment late is not a failure: the read-back is polled, and a second round of clean-up follows before it gives up (M4)", () => {
    const s = setup();
    expect(selfTest(s, { ...STAGING, LATE_IFACE: "1" }).stdout).toContain("rc=0");
    expect(parsedOf(s)).toMatchObject({ state: "ran", reason: "ok" });
    expect(stage2).toMatch(/tsl_readback_settled\(\) \{[\s\S]*?\(\(i == 10#\$tries\)\) \|\| sleep 1/u);
    expect(stage2).toContain("TSL_SETTLE_TRIES:-15");
    // Two rounds: clean-up, settle poll, a pause, clean-up again, settle poll.
    const main = /^run_tsl_selftest\(\) \{[\s\S]*?^\}$/mu.exec(block)?.[0] ?? "";
    expect(main).toMatch(/tsl_readback_settled; then\n\s+# One settle, then a second round[\s\S]*?sleep 2\n\s+tsl_cleanup\n\s+if ! tsl_readback_settled/u);
  });

  it("the read-back decision itself: gone continues (0), anything not gone terminates (1), and a look that fails is not gone", () => {
    const s = setup();
    const clear = () => {
      for (const file of ["containers_ws", "containers_driver", "networks_ws", "volumes_ws"]) writeFileSync(join(s.state, file), "");
      for (const file of ["tasknet_ours", "rule", "iface", "reorder"]) rmSync(join(s.state, file), { force: true });
      rmSync(join(s.vartmp, "tsl-work.abc123"), { recursive: true, force: true });
    };
    const decide = (extra: string, env: Record<string, string> = {}) => {
      clear();
      return run(s, `TSL_SNAPSHOT_BEFORE=$(mktemp); tsl_snapshot "$TSL_SNAPSHOT_BEFORE"; ${extra}; tsl_readback; echo "decision=$? $TSL_DIFF"`, env).stdout.trim();
    };
    expect(decide(":")).toBe("decision=0");
    expect(decide('echo c1 >>"$STATE/containers_ws"')).toBe("decision=1 containers");
    expect(decide('echo c1 >>"$STATE/containers_driver"')).toBe("decision=1 containers");
    expect(decide('echo n1 >>"$STATE/networks_ws"')).toBe("decision=1 networks");
    expect(decide('echo v1 >>"$STATE/volumes_ws"')).toBe("decision=1 volumes");
    expect(decide(': >"$STATE/tasknet_ours"')).toBe("decision=1 networks");
    // (The fake Docker takes a network's rules and bridge away with its objects, as Docker does, unless the test says they are leaked.)
    expect(decide(': >"$STATE/rule"', { LEAK_RULE: "1" })).toBe("decision=1 rules");
    expect(decide(': >"$STATE/iface"', { LEAK_IFACE: "1" })).toBe("decision=1 routes");
    expect(decide(': >"$STATE/reorder"', { LEAK_RULE: "1" })).toBe("decision=1 rules");
    expect(decide('mkdir "' + join(s.vartmp, "tsl-work.abc123") + '"')).toBe("decision=1 dirs");
    expect(decide(":", { DOCKER_DOWN: "1" })).toBe("decision=1 docker");
    clear();
  });

  it("a timed-out run is cleaned up and read back all the same", () => {
    const s = setup();
    selfTest(s, { ...STAGING, FORCE_TIMEOUT: "1" });
    for (const file of ["containers_ws", "networks_ws", "containers_driver"]) expect(readFileSync(join(s.state, file), "utf8").trim(), file).toBe("");
    expect(readdirSync(s.vartmp)).toEqual([]);
    // A leak is found on this path too (the working sandbox's network is found by its label).
    expect(selfTest(setup(), { ...STAGING, FORCE_TIMEOUT: "1", LEAK_TASKNET: "1" }).stdout).toContain("rc=75");
  });

  it("the boot is stopped through the existing path: `fail` (a reason on /ping, the provisioner stops the session) and the worker unit is not started", () => {
    expect(stage2Main).toMatch(/fail "the TS-L self-test left test objects on this worker and it is unusable/u);
    expect(stage2Main.indexOf("run_tsl_selftest")).toBeLessThan(stage2Main.indexOf('systemctl enable --now "$WORKER_UNIT"'));
    expect(/fail "the TS-L self-test[^"]*"/u.exec(stage2Main)?.[0]).not.toMatch(/[0-9]+\.[0-9]+\.[0-9]+/u);
    expect(readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8")).toContain('"status": "BootFailed"');
  });
});

describe("condition 3, across launches (H2): Docker's data root is on the workspace volume, so EVERY named boot first removes what the self-test could have left", () => {
  it("removes containers, networks and volumes carrying either fixed label, and reads that back", () => {
    const s = setup();
    writeFileSync(join(s.state, "containers_driver"), "x1\n");
    writeFileSync(join(s.state, "containers_ws"), "c9\n");
    writeFileSync(join(s.state, "networks_ws"), "n9\n");
    writeFileSync(join(s.state, "volumes_ws"), "v9\n");
    writeFileSync(join(s.state, "tasknet_ours"), "");
    writeFileSync(join(s.state, "tasknet"), "");
    // The self-test is OFF here: the sweep does not depend on the opt-in.
    const result = run(s, 'tsl_sweep_leftovers; echo "sweep=$?"', { AGENTX_ENVIRONMENT_KIND: "named" });
    expect(result.stdout).toContain("sweep=0");
    for (const file of ["containers_driver", "containers_ws", "networks_ws", "volumes_ws"]) expect(readFileSync(join(s.state, file), "utf8").trim(), file).toBe("");
    expect(existsSync(join(s.state, "tasknet"))).toBe(false);
    for (const label of ["label=rovara.tsl-selftest=1", "label=rovara.run-network.workspace=7e57c4ec7e57c4ec"]) {
      expect(callsOf(s), label).toContain(`docker ps -a -q --filter ${label}`);
      expect(callsOf(s), label).toContain(`docker network ls -q --filter ${label}`);
      expect(callsOf(s), label).toContain(`docker volume ls -q --filter ${label}`);
    }
    // It takes no snapshot and runs no check: it only looks at Docker.
    expect(callsOf(s)).not.toContain("checks mode");
    expect(callsOf(s)).not.toContain("docker create");
  });

  it("does nothing when there is nothing to remove, and fails (returns 1, with a fixed word in the log) when something cannot be removed", () => {
    const clean = setup();
    expect(run(clean, 'tsl_sweep_leftovers; echo "sweep=$?"').stdout).toContain("sweep=0");
    expect(callsOf(clean)).not.toContain("docker rm");
    expect(callsOf(clean)).not.toContain("docker network rm");
    for (const [leak, part] of [["LEAK_CONTAINER", "containers"], ["LEAK_NETWORK", "networks"], ["LEAK_VOLUME", "volumes"]] as const) {
      const s = setup();
      const seed = part === "containers" ? "containers_ws" : part === "networks" ? "networks_ws" : "volumes_ws";
      writeFileSync(join(s.state, seed), "left\n");
      expect(run(s, 'tsl_sweep_leftovers; echo "sweep=$?"', { [leak]: "1" }).stdout, leak).toContain("sweep=1");
      expect(logOf(s), leak).toContain(`could not be removed from the workspace volume (${part})`);
    }
    expect(run(setup(), 'tsl_sweep_leftovers; echo "sweep=$?"', { DOCKER_DOWN: "1" }).stdout).toContain("sweep=1");
  });

  it("is the FIRST thing in the named block of stage2_main, before the function runner, the pulls, the walls and the self-test, and a failure fails the boot", () => {
    const named = stage2Main.slice(stage2Main.indexOf("if [[ ${AGENTX_ENVIRONMENT_KIND:-} == named ]]; then\n    # FIRST"));
    expect(named.startsWith("if [[ ${AGENTX_ENVIRONMENT_KIND:-} == named ]]; then\n    # FIRST")).toBe(true);
    const at = (text: string) => stage2Main.indexOf(text);
    expect(at("tsl_sweep_leftovers")).toBeGreaterThan(-1);
    expect(at("tsl_sweep_leftovers")).toBeLessThan(at("install_function_runner_runsc"));
    expect(at("tsl_sweep_leftovers")).toBeLessThan(at("pull_catalog_images"));
    expect(at("tsl_sweep_leftovers")).toBeLessThan(at("set_docker_address_pools"));
    expect(stage2Main).toMatch(/tsl_sweep_leftovers \|\| fail "TS-L self-test leftovers on the workspace volume could not be removed/u);
  });

  it("everything the self-test creates carries one of the two fixed labels: the bundle container, the working sandbox's network and the checker's driver containers have the driver label; the driver's run objects have the throwaway workspace key", () => {
    expect(block).toContain('tsl_dk create --label "$TSL_DRIVER_LABEL=1"');
    expect(block).toContain('--label "$TSL_DRIVER_LABEL=1" "$TSL_TASK_NETWORK"');
    expect(checker).toContain("--label rovara.tsl-selftest=1");
    expect(driver).toContain('export const TSL_WORKSPACE = "7e57c4ec7e57c4ec";');
  });
});

describe("condition 4: the output is fixed ids, fixed codes and the four identity values", () => {
  it("carries the AMI id, boot-stage2 SHA-256, Docker version and instance id, and nothing the checker printed", () => {
    const s = setup();
    selfTest(s, STAGING);
    const line = recorded(s) ?? "";
    expect(line.length).toBeLessThanOrEqual(SELFTEST_MAX_CHARS);
    const parsed = parsedOf(s);
    expect(parsed).toMatchObject({ v: 1, state: "ran", reason: "ok", ami: "ami-0d2beaff07e79c24e", boot2: BOOT2, docker: "25.0.18", instance: INSTANCE });
    for (const text of ["172.30", "10.0.0.5", "10.0.9.9", "ip-10-0", "ec2.internal", "SECRET", "token", "evidence", "some-name", "later:"]) expect(line, text).not.toContain(text);
    const object = JSON.parse(line) as { items: string[]; extra: string[] } & Record<string, unknown>;
    const allowedWords = new Set<string>([...SELFTEST_STATES, ...SELFTEST_STATUSES, ...SELFTEST_REASONS]);
    for (const key of ["state", "reason"]) expect(allowedWords.has(object[key] as string), key).toBe(true);
    for (const item of [...object.items, ...object.extra]) {
      const [id, status, reason] = item.split(":");
      expect([...SELFTEST_ITEM_IDS, ...SELFTEST_EXTRA_IDS]).toContain(id);
      expect(allowedWords.has(status!)).toBe(true);
      expect(allowedWords.has(reason!)).toBe(true);
    }
    expect(object.items).toHaveLength(SELFTEST_ITEM_IDS.length);
    expect(object.extra).toHaveLength(SELFTEST_EXTRA_IDS.length);
  });

  it("is written under /run (a reboot empties it), never into the worker's environment file, and the launcher passes it only when it is there and in its one form, so no old result is replayed (L1)", () => {
    const s = setup();
    selfTest(s, STAGING);
    expect(existsSync(join(s.dir, "worker.env"))).toBe(false);
    expect(stage2).toContain("readonly TSL_RESULT_FILE=/run/agentx/tsl-selftest");
    expect(launcher).toContain("/run/agentx/tsl-selftest");
    expect(launcher).toContain('--env "AGENTX_TEST_SERVICES_SELFTEST=$tsl_selftest_result"');
    expect(launcher).toMatch(/\$\{#tsl_selftest_result\} -le 3000 && "\$tsl_selftest_result" == '\{"v":1,'\*/u);
    expect(block).not.toMatch(/>>"?\$\{?WORKER_ENV_FILE/u);
    expect(launcher.indexOf("tsl_selftest_result=")).toBeLessThan(launcher.indexOf('exec "$docker" "${args[@]}"'));
  });

  it("an identity value that is not in its one form is the word `unknown`, never the value", () => {
    const s = setup();
    selfTest(s, { ...STAGING, FAKE_AMI: "ami-<script>;rm -rf", AGENTX_BOOT_STAGE2_SHA256: "not-a-hash", DOCKER_VERSION: "25.0.18 (evil; 10.0.0.1)", INSTANCE_ID: "i-notaninstance" });
    expect(parsedOf(s)).toMatchObject({ ami: "unknown", boot2: "unknown", docker: "unknown", instance: "unknown" });
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
    const parsed = parsedOf(s);
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

  it("the LAST line for an item is its verdict: a raw driver line the checker echoed before it cannot turn a failed host check into a pass (L4)", () => {
    const s = setup();
    const out = checkerOutput({ "L3.ipv6": "FAIL no-ipv6 | host drop missing" }, ["TSL L3.ipv6 PASS driver-said-pass | raw driver line"]);
    selfTest(s, STAGING, out);
    expect(parsedOf(s).items.find((entry) => entry.id === "L3.ipv6")).toEqual({ id: "L3.ipv6", status: "fail", reason: "check_failed" });
  });

  it("an untrusted catalog, a registry login or manifest read that failed, and a pull that failed each have their own fixed code (the first two are `pending: no_pull_grant`, the pull `pending: pull_failed`)", () => {
    const itemOf = (s: Setup, id: string) => parsedOf(s).items.find((entry) => entry.id === id);
    const live = { "L4.live": "FAIL x | y", "L4.template-db": "FAIL x | y", "L1.walls": "FAIL x | y" };
    const blocked = setup();
    selfTest(blocked, STAGING, checkerOutput(live, ["TSL BLOCKED the catalog is not signed by a trusted key"]));
    expect(itemOf(blocked, "L4.live")).toEqual({ id: "L4.live", status: "fail", reason: "catalog_untrusted" });
    for (const line of ["TSL ERROR the registry login failed", `TSL ERROR the manifest of ${IMAGE.split("@")[0]}/rovara-catalog/staging/svc/postgres@sha256:aa could not be read`]) {
      const s = setup();
      selfTest(s, STAGING, checkerOutput(live, [line]));
      expect(itemOf(s, "L4.live")).toEqual({ id: "L4.live", status: "pending", reason: "no_pull_grant" });
      expect(itemOf(s, "L4.template-db")).toEqual({ id: "L4.template-db", status: "pending", reason: "no_pull_grant" });
      expect(itemOf(s, "L1.walls")).toEqual({ id: "L1.walls", status: "fail", reason: "check_failed" });
      expect(recorded(s)).not.toMatch(/944937319445|rovara-catalog|postgres/u);
    }
    const pull = setup();
    selfTest(pull, STAGING, checkerOutput(live, [`TSL ERROR the pull of ${IMAGE.split("@")[0]}/rovara-catalog/staging/svc/postgres@sha256:aa failed`]));
    expect(itemOf(pull, "L4.live")).toEqual({ id: "L4.live", status: "pending", reason: "pull_failed" });
    const error = setup();
    selfTest(error, STAGING, checkerOutput({ "L3.live": "FAIL x | y" }, ["TSL ERROR pull-list: something broke"]));
    expect(itemOf(error, "L3.live")).toEqual({ id: "L3.live", status: "fail", reason: "driver_error" });
  });

  it("CI's optional egress capture is an always-pending ITEM (`no_capture`); TS-RUN-3's two cases have no CI id, so they are `extra.*` in their own list, always pending (M6)", () => {
    const s = setup();
    selfTest(s, STAGING);
    const parsed = parsedOf(s);
    expect(parsed.items.filter((entry) => (SELFTEST_ALWAYS_PENDING_IDS as readonly string[]).includes(entry.id))).toEqual([{ id: "L3.egress-capture", status: "pending", reason: "no_capture" }]);
    expect(parsed.items.some((entry) => entry.id.startsWith("extra.") || entry.id.startsWith("RUN3"))).toBe(false);
    expect(parsed.extra).toEqual([
      { id: "extra.redis-flush", status: "pending", reason: "no_pin" },
      { id: "extra.http-reset", status: "pending", reason: "later_slice" },
    ]);
  });

  it("is size-capped: a result that would not fit is recorded as `incomplete: too_large` with no items", () => {
    const s = setup();
    selfTest(s, STAGING, checkerOutput(), (text) => text.replace("readonly TSL_RESULT_MAX_CHARS=3000", "readonly TSL_RESULT_MAX_CHARS=400"));
    expect(parsedOf(s)).toMatchObject({ state: "incomplete", reason: "too_large", items: [], extra: [] });
    const full = setup();
    selfTest(full, STAGING);
    expect((recorded(full) ?? "").length).toBeLessThan(SELFTEST_MAX_CHARS - 500);
  });

  it("the encoder refuses any word that is not on its lists", () => {
    const s = setup();
    const encode = (results: string, state = "ran", reason = "ok") => run(s, `TSL_RESULTS=$'${results}'; tsl_encode ${state} ${reason} 5; echo "rc=$?"`).stdout;
    expect(encode("L1.walls pass ok\\n")).toContain('"items":["L1.walls:pass:ok"],"extra":[]');
    expect(encode("L1.walls pass ok\\nextra.redis-flush pending no_pin\\n")).toContain('"extra":["extra.redis-flush:pending:no_pin"]');
    expect(encode("L1.walls pass ok\\n")).toContain("rc=0");
    for (const bad of ["L1.walls pass free_text_here\\n", "L9.nope pass ok\\n", "L1.walls great ok\\n", "L1.walls pass 10.0.0.1\\n", "RUN3.redis-flush pending no_pin\\n"]) expect(encode(bad), bad).toContain("rc=1");
    expect(encode("L1.walls pass ok\\n", "ran", "because")).toContain("rc=1");
    expect(encode("L1.walls pass ok\\n", "done", "ok")).toContain("rc=1");
  });
});

describe("condition 5: the item ids are CI's TS-L ids", () => {
  const first = (text: string, pattern: RegExp) => pattern.exec(text)?.[1] ?? "";
  const shellList = (name: string) => first(stage2, new RegExp(`^readonly ${name}="([^"]*)"$`, "mu")).split(" ");

  it("the ids the checker script prints, in its order, are the ones the boot and the worker list; the extras are NOT items", () => {
    const printed: string[] = [];
    for (const match of checker.matchAll(/\b(?:verdict|pending|live_line|emit) (L[0-9]\.[a-z0-9-]+)/gu)) if (!printed.includes(match[1]!)) printed.push(match[1]!);
    expect(printed).toEqual([...SELFTEST_CI_ITEM_IDS].sort((a, b) => printed.indexOf(a) - printed.indexOf(b)));
    expect(new Set(printed)).toEqual(new Set(SELFTEST_CI_ITEM_IDS));
    expect(shellList("TSL_ITEM_IDS")).toEqual([...SELFTEST_CI_ITEM_IDS]);
    expect(shellList("TSL_PENDING_IDS")).toEqual([...SELFTEST_ALWAYS_PENDING_IDS]);
    expect(shellList("TSL_EXTRA_IDS")).toEqual([...SELFTEST_EXTRA_IDS]);
    // Every id in `items` is a TS-L id CI prints or one CI's egress capture prints; the extras are clearly named and CI has no such id.
    expect(ciScript + readFileSync(new URL("../../scripts/ci-egress-capture.sh", import.meta.url), "utf8")).toContain("L3.egress-capture");
    for (const id of SELFTEST_EXTRA_IDS) { expect(id).toMatch(/^extra\./u); expect(checker + ciScript).not.toContain(id); }
  });

  it("the live ids are CI's LIVE_IDS; the throwaway workspace key and labels are the script's, the CI script's and the driver's", () => {
    expect(shellList("TSL_LIVE_IDS")).toEqual(first(ciScript, /^readonly LIVE_IDS="([^"]*)"$/mu).split(" "));
    const key = first(stage2, /^readonly TSL_WORKSPACE_KEY=([0-9a-f]+)$/mu);
    expect(key).toHaveLength(16);
    expect(first(checker, /^TSL_WORKSPACE_KEY=([0-9a-f]+)$/mu)).toBe(key);
    expect(first(ciScript, /^readonly TSL_WORKSPACE_KEY=([0-9a-f]+)$/mu)).toBe(key);
    expect(first(driver, /^export const TSL_WORKSPACE = "([0-9a-f]+)";$/mu)).toBe(key);
    expect(first(checker, /^FAMILY_LABEL=(\S+)$/mu)).toBe(first(stage2, /^readonly TSL_FAMILY_LABEL=(\S+)$/mu));
    expect(first(stage2, /^readonly TSL_DRIVER_LABEL=(\S+)$/mu)).toBe("rovara.tsl-selftest");
    expect(checker).toContain("--label rovara.tsl-selftest=1");
    const network = readFileSync(new URL("../../packages/worker/src/task-network.ts", import.meta.url), "utf8");
    expect(network).toContain('TASK_SANDBOX_BRIDGE = "rvbtask"');
    expect(network).toContain('TASK_SANDBOX_NETWORK = "agentx-task"');
    expect(ciScript).toContain("com.docker.network.bridge.name=rvbtask --opt com.docker.network.bridge.enable_icc=false agentx-task");
  });

  it("the boot's states, statuses and reason codes are the worker's lists, word for word", () => {
    expect(shellList("TSL_STATES")).toEqual([...SELFTEST_STATES]);
    expect(shellList("TSL_STATUSES")).toEqual([...SELFTEST_STATUSES]);
    expect(shellList("TSL_REASONS")).toEqual([...SELFTEST_REASONS]);
    expect(first(stage2, /^readonly TSL_RESULT_VARIABLE=(\S+)$/mu)).toBe("AGENTX_TEST_SERVICES_SELFTEST");
    expect(first(stage2, /^readonly TSL_RESULT_MAX_CHARS=(\d+)$/mu)).toBe(String(SELFTEST_MAX_CHARS));
    for (const word of stage2.matchAll(/tsl_(?:record|finish_early) (?:incomplete|unusable|refused) ([a-z_]+)/gu)) expect(SELFTEST_REASONS as readonly string[], word[1]).toContain(word[1]);
    for (const word of block.matchAll(/tsl_item "\$id" (?:pass|fail|pending|incomplete) ([a-z_]+)/gu)) expect(SELFTEST_REASONS as readonly string[], word[1]).toContain(word[1]);
  });

  it("the image carries the checker and the built driver where the boot reads them (inside packages/worker, which the image already copies), built before esbuild is pruned, in a staging build only", () => {
    expect(first(stage2, /^readonly TSL_BUNDLE_DIR=(\S+)$/mu)).toBe("/opt/agentx/packages/worker/ec2/tsl");
    expect(first(stage2, /^readonly TSL_CATALOG_DIR=(\S+)$/mu)).toBe("/opt/agentx/packages/worker/service-catalog");
    expect(dockerfile).toContain("COPY packages/worker packages/worker");
    expect(dockerfile).toContain("COPY --from=build /opt/agentx/packages/worker ./packages/worker");
    const build = "node_modules/.bin/esbuild --loader:.txt=ts --format=esm --platform=node --target=node22 --log-level=warning --outfile=packages/worker/ec2/tsl/live.mjs packages/worker/ec2/tsl/live-driver.ts.txt";
    expect(dockerfile).toContain(build);
    expect(dockerfile.indexOf(build)).toBeGreaterThan(dockerfile.indexOf("RUN npx tsc -b packages/cloud-contracts packages/verifier packages/worker"));
    expect(dockerfile.indexOf(build)).toBeLessThan(dockerfile.indexOf("RUN npm prune --omit=dev --workspaces"));
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
    expect(block).not.toMatch(/docker (?:pull|login)|ecr get-login|\$\{?TSL_DOCKER_CONFIG/u);
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
