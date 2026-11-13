import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// SU-1 boot path, real bash with fake host tools and translated system paths.
// Linux/GNU signal proof is separate from this portable harness.
const stage2 = readFileSync(process.env.SU1_BOOT_TEST_SOURCE ?? new URL("../../packages/worker/ec2/boot-stage2.sh", import.meta.url), "utf8");
function requiredTmpdir(): string { if (!process.env.TMPDIR) throw new Error("TMPDIR is required"); return process.env.TMPDIR; }
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const STAGING_ACCOUNT = "944937319445";
const IMAGE = `${STAGING_ACCOUNT}.dkr.ecr.us-west-2.amazonaws.com/agentx-worker@sha256:${"d".repeat(64)}`;
const BOOT2 = "b".repeat(64);
const INSTANCE = "i-08a32b24c7e3efe6c";
const STAGING: Record<string, string> = { AGENTX_SU1_CHECK: "1", AGENTX_ENVIRONMENT_KIND: "named", AGENTX_LOG_GROUP: "/agentx/staging/worker", AGENTX_WORKER_IMAGE: IMAGE, AGENTX_BOOT_STAGE2_SHA256: BOOT2 };

/** Evidence is deliberately hostile; only the number and fixed status may survive. */
function checkerOutput(overrides: Record<string, string> = {}): string {
  return Array.from({ length: 11 }, (_, i) => `${i + 1}`).map((id) => overrides[id] === "missing" ? "" : `SU1 ${id} ${overrides[id] ?? "PASS"} some_name | host=private.example address=10.0.0.5 token=DO_NOT_FORWARD`).join("\n");
}

interface Setup { dir: string; bin: string; state: string; result: string; marker: string; calls: string; log: string; vartmp: string; fixtures: string }

function setup(): Setup {
  const dir = mkdtempSync(join(requiredTmpdir(), "su1-boot-check-"));
  roots.push(dir);
  const s: Setup = { dir, bin: join(dir, "bin"), state: join(dir, "state"), result: join(dir, "run", "tsl-selftest"), marker: join(dir, "volume", "tsl-selftest-marker"), calls: join(dir, "calls"), log: join(dir, "log"), vartmp: join(dir, "vartmp"), fixtures: join(dir, "fixtures") };
  for (const d of [s.bin, s.state, s.vartmp, s.fixtures, join(dir, "volume")]) mkdirSync(d);
  for (const file of [s.calls, s.log]) writeFileSync(file, "");
  for (const file of ["containers_driver", "containers_ws", "networks_ws", "volumes_ws"]) writeFileSync(join(s.state, file), "");
  writeFileSync(join(s.fixtures, "setup-agent-su1.sh"), [
    "#!/bin/bash",
    'echo "checks mode=${SU1_TIMEOUT_SECONDS:+live}${SU1_TIMEOUT_SECONDS:-host}" >>"$CALLS_FILE"',
    'cat "$CHECKS_OUT"',
    'touch "$SU1_LOCK"',
    // A live run makes things: a container, a network and a volume carrying the throwaway key, a pulled image, a rule, a route and an interface (the fakes read these files).
    'if [[ -n "${SU1_TIMEOUT_SECONDS:-}" ]]; then echo c1 >>"$STATE/containers_ws"; echo n1 >>"$STATE/networks_ws"; echo v1 >>"$STATE/volumes_ws"; : >"$STATE/pulled"; : >"$STATE/rule"; : >"$STATE/iface"; [[ -z "${MAKE_REORDER:-}" ]] || : >"$STATE/reorder"; fi',
  ].join("\n"));
  writeFileSync(join(s.fixtures, "live.mjs"), "// driver\n");
  writeFileSync(join(s.fixtures, "catalog.json"), "{}\n");
  writeFileSync(join(s.fixtures, "catalog.sig.json"), "{}\n");
  writeFileSync(join(s.fixtures, "catalog-build-flavor.js"), 'export const CATALOG_BUILD_FLAVOR = "staging";\n');
  writeFileSync(join(s.fixtures, "catalog-build-flavor.release.js"), 'export const CATALOG_BUILD_FLAVOR = "release";\n');
  const tool = (name: string, body: string) => { writeFileSync(join(s.bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(s.bin, name), 0o755); };
  tool("timeout", [
    'if [[ "$1" == --version ]]; then [[ "${NO_GNU_TIMEOUT:-}" != 1 ]] || exit 127; echo "timeout (GNU coreutils) fixture"; exit 0; fi',
    'printf "%s\\n" "$*" >>"$STATE/timeouts"',
    'while [[ "$1" == --* ]]; do shift; done; shift',
    // A forced timeout: the live checker never finishes (the real timeout kills it); nothing it would have made exists.
    'if [[ "${FORCE_TIMEOUT:-}" == 1 && -n "${SU1_TIMEOUT_SECONDS:-}" && "$*" == *s.sh* ]]; then echo "checks timed-out" >>"$CALLS_FILE"; exit 124; fi',
    'exec "$@"',
  ].join("\n"));
  tool("curl", [
    '[[ -z "${CURL_FAIL:-}" ]] || exit 22',
    'case "$*" in *api/token*) echo TOKEN ;; *instance-identity/document*) printf \'{"accountId" : "%s", "region" : "us-west-2"}\\n\' "${ACCOUNT:-944937319445}" ;; *) exit 22 ;; esac',
  ].join("\n"));
  tool("launcher", 'echo "launcher $*" >>"$CALLS_FILE"; exit "${WALLS_RC:-0}"');
  tool("systemctl", 'echo "systemctl $*" >>"$CALLS_FILE"');
  tool("docker", [
    'echo "docker $*" >>"$CALLS_FILE"',
    // What exists when Docker is asked to MAKE something: the marker must already be on the volume (F1).
    'if [[ "$1" == create || ( "$1" == network && "$2" == create ) ]]; then if [[ -e "$MARKER_FILE" ]]; then echo "$1 $2" >>"$STATE/made_with_marker"; else echo "$1 $2" >>"$STATE/made_without_marker"; fi; fi',
    '[[ -z "${DOCKER_DOWN:-}" ]] || exit 1',
    '[[ -z "${DOCKER_DOWN_AFTER_RUN:-}" || ! -e "$STATE/rule" ]] || exit 1',
    '[[ -z "${DOCKER_DOWN_AFTER_RM:-}" || ! -e "$STATE/rm_asked" ]] || exit 1',
    '[[ "$1" != rm ]] || : >"$STATE/rm_asked"',
    // Once the labelled objects are gone, Docker has taken their rules, routes and bridge away too (unless the test leaks them).
    'settle() { [[ -s "$STATE/networks_ws" || -s "$STATE/containers_ws" || -e "$STATE/tasknet_ours" ]] || { [[ -n "${LEAK_RULE:-}" ]] || rm -f "$STATE/rule" "$STATE/reorder"; [[ -n "${LEAK_IFACE:-}" || -n "${LATE_IFACE:-}" ]] || rm -f "$STATE/iface"; }; }',
    'trap settle EXIT',
    'case "$1" in',
    '  version) echo "${DOCKER_VERSION:-25.0.18}" ;;',
    '  ps) [[ "$*" == *"--filter label=agentx.su1-check" ]] || exit 1; cat "$STATE/containers_driver" "$STATE/containers_ws" ;;',
    '  rm) shift; [[ "$1" == -f ]] && shift; [[ "$1" == -v ]] && shift; for id in "$@"; do',
    '        [[ -n "${LEAK_CONTAINER:-}" ]] && continue; sed -i.bak "/^$id\\$/d" "$STATE/containers_ws" "$STATE/containers_driver"; done ;;',
    '  network) case "$2" in',
    '    ls) if [[ "$*" == *name=* ]]; then [[ -e "$STATE/tasknet" ]] && echo tasknet; exit 0; fi',
    '        [[ "$*" == *"--filter label=agentx.su1-check" ]] || exit 1; cat "$STATE/networks_ws" ;;',
    '    create) [[ -z "${TASKNET_EXISTS:-}" ]] || exit 1; : >"$STATE/tasknet"; : >"$STATE/tasknet_ours" ;;',
    '    rm) shift 2; for id in "$@"; do if [[ "$id" == tasknet ]]; then [[ -n "${LEAK_TASKNET:-}" ]] || rm -f "$STATE/tasknet" "$STATE/tasknet_ours"; else [[ -n "${LEAK_NETWORK:-}" ]] || : >"$STATE/networks_ws"; fi; done ;;',
    '    esac ;;',
    '  volume) case "$2" in',
    '    ls) [[ "$*" == *"--filter label=agentx.su1-check" ]] || exit 1; cat "$STATE/volumes_ws" ;;',
    '    rm) [[ -n "${LEAK_VOLUME:-}" ]] || : >"$STATE/volumes_ws" ;;',
    '    esac ;;',
    '  image) case "$2" in',
    '    ls) echo sha256:base; [[ -e "$STATE/pulled" ]] && echo sha256:pulled; exit 0 ;;',
    '    rm) [[ "$4" == sha256:pulled ]] && rm -f "$STATE/pulled"; exit 0 ;;',
    '    esac ;;',
    '  create) [[ "$*" == *"--label agentx.su1-check=boot "* ]] || exit 1; echo abcdef123456 >>"$STATE/containers_driver"; echo abcdef123456 ;;',
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
    '  *"-6 route"*) echo "::1 dev lo"; if [[ -n "${RA_ROUTE:-}" ]]; then n=$(cat "$STATE/racalls" 2>/dev/null || echo 0); n=$((n + 7)); echo $n >"$STATE/racalls"; echo "default via fe80::1 dev ens5 proto ra metric 1024 expires $((1800 - n))sec hoplimit 64 pref medium"; echo "2600:1f13::/64 dev ens5 proto ra metric 256 expires $((86400 - n))sec pref medium"; fi ;;',
    '  *"addr"*) exit 0 ;;',
    '  *rule*) echo "0: from all lookup local" ;;',
    'esac',
  ].join("\n"));
  tool("sleep", "exit 0");
  tool("sync", "exit 0");
  tool("mktemp", [
    'n=$(cat "$STATE/mktemps" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$STATE/mktemps"',
    '[[ "$n" != "${FAIL_MKTEMP_AT:-}" ]] || exit 1',
    'exec /usr/bin/mktemp "$@"',
  ].join("\n"));
  // The snapshot reads nft and ip6tables when they are on the PATH. A real runner (Linux CI) has both under /usr/sbin and the test is not root, so the real ones would fail and the snapshot with them: the fakes keep the test hermetic
  // (an empty ruleset, and an ip6tables that is not usable, which the snapshot skips, as on a host without IPv6 tables).
  tool("nft", "exit 0");
  tool("ip6tables", "exit 1");
  return s;
}

/** Runs `body` in bash with stage 2 sourced from a copy whose system paths are the test's. */
function run(s: Setup, body: string, env: Record<string, string> = {}, tweak: (text: string) => string = (text) => text) {
  const text = tweak(stage2
    .replace("readonly SU1_LOCK_FILE=/run/lock/agentx-su1-check.lock", "# lock path set by harness")
    .replaceAll("/var/tmp/", `${s.vartmp}/`)
    .replace("readonly SU1_RESULT_FILE=/run/agentx/su1-check", `readonly SU1_RESULT_FILE=${s.result}`)
    .replace("readonly SU1_MARKER_FILE=/mnt/workspace/.agentx-su1-check-running", `readonly SU1_MARKER_FILE=${s.marker}`)
    .replace("readonly TSL_LAUNCHER=/usr/local/libexec/agentx-worker-start", `readonly TSL_LAUNCHER=${join(s.bin, "launcher")}`)
    .replace("readonly WORKER_ENV_FILE=/etc/agentx/worker.env", `readonly WORKER_ENV_FILE=${join(s.dir, "worker.env")}`));
  const file = join(s.dir, "stage2.sh");
  writeFileSync(file, text);
  const script = [
    "set -u",
    `readonly SU1_LOCK_FILE="${join(s.dir, "su1.lock")}"`,
    `log() { printf '%s\\n' "$*" >>"$LOG_FILE"; }`,
    `imds_once() { [[ "$1" == ami-id ]] && printf '%s\\n' "\${FAKE_AMI-ami-0d2beaff07e79c24e}"; }`,
    "BOOT_DEADLINE=$((SECONDS + ${DEADLINE_IN:-700}))",
    `source "${file}"`,
    body,
  ].join("\n");
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: `${s.bin}:/usr/bin:/bin:/usr/sbin:/sbin`, LOG_FILE: s.log, CALLS_FILE: s.calls, MARKER_FILE: s.marker, SU1_LOCK: join(s.dir, "su1.lock"), STATE: s.state, FIXTURES: s.fixtures, HOME: s.dir, TMPDIR: s.dir, ...env },
  });
}
const callsOf = (s: Setup) => readFileSync(s.calls, "utf8");
const recorded = (s: Setup): string | undefined => (existsSync(s.result) ? readFileSync(s.result, "utf8").trim() : undefined);
const SELFTEST = 'run_su1_check "$INSTANCE_ID"; echo "rc=$?"';
function selfTest(s: Setup, env: Record<string, string>, output = checkerOutput(), tweak?: (text: string) => string) {
  const out = join(s.dir, "checks.out");
  writeFileSync(out, output);
  return run(s, SELFTEST, { INSTANCE_ID: INSTANCE, CHECKS_OUT: out, ...env }, tweak);
}
/** The parsed result, or a failed test. */
function parsedOf(s: Setup) {
  const parsed = JSON.parse(recorded(s) ?? "null") as { state: string; reason: string; items: string[] } | null;
  if (parsed === null) throw new Error(`no result: ${recorded(s) ?? "nothing recorded"}`);
  return parsed;
}


describe("SU-1 boot, real bash with hermetic host tools", () => {
  it("control: a clean run records ran, nine passes, two pending, and erases its objects", () => {
    const s = setup();
    expect(selfTest(s, STAGING).stdout).toContain("rc=0");
    expect(parsedOf(s)).toMatchObject({ state: "ran", reason: "ok" });
    expect(parsedOf(s).items).toHaveLength(11);
    expect(parsedOf(s).items.filter(row => row.includes(":pass:"))).toHaveLength(9);
    expect(parsedOf(s).items).toContain("9:pending:needs_model_run");
    expect(parsedOf(s).items).toContain("10:pending:needs_model_run");
    expect(parsedOf(s)).toHaveProperty("secs", expect.any(Number));
    expect(existsSync(join(s.state, "made_without_marker"))).toBe(false);
    expect(existsSync(join(s.state, "made_with_marker"))).toBe(true);
    expect(existsSync(s.marker)).toBe(false);
    expect(existsSync(join(s.dir, "su1.lock"))).toBe(false);
    expect(readdirSync(s.vartmp)).toEqual([]);
    expect(readFileSync(join(s.state, "containers_driver"), "utf8")).toBe("");
    expect(callsOf(s)).toContain("checks mode=");
  });
  it("off creates no result and runs nothing", () => {
    for (const value of ["", "0", "true", " 1"]) {
      const s = setup();
      expect(selfTest(s, { ...STAGING, AGENTX_SU1_CHECK: value, AGENTX_TSL_SELFTEST: "1" }).stdout).toContain("rc=0");
      expect(recorded(s)).toBeUndefined(); expect(callsOf(s)).toBe("");
    }
  });
  it("requires GNU timeout before any host operation and reports a fixed failure", () => {
    const s = setup();
    expect(selfTest(s, { ...STAGING, NO_GNU_TIMEOUT: "1" }).stdout).toContain("rc=0");
    expect(parsedOf(s)).toMatchObject({ state: "incomplete", reason: "timeout_unavailable" });
    expect(callsOf(s)).toBe("");
    expect(readFileSync(s.log, "utf8")).toContain("GNU timeout is required");
  });
  it.each([
    [{ AGENTX_ENVIRONMENT_KIND: "legacy" }, "not_named"],
    [{ AGENTX_LOG_GROUP: "/agentx/production/worker" }, "not_staging"],
    [{ AGENTX_LOG_GROUP: "/agentx/staging/worker/extra" }, "not_staging"],
    [{ AGENTX_WORKER_IMAGE: IMAGE.replace(STAGING_ACCOUNT, "111122223333") }, "wrong_account"],
    [{ ACCOUNT: "111122223333" }, "wrong_account"],
    [{ CURL_FAIL: "1" }, "wrong_account"],
    [{ FLAVOR: "release" }, "not_staging_image"],
  ])("refuses %j with %s", (env, reason) => {
    const s = setup(); expect(selfTest(s, { ...STAGING, ...env }).stdout).toContain("rc=0");
    expect(parsedOf(s)).toMatchObject({ state: "refused", reason });
    expect(callsOf(s)).not.toContain("checks mode=");
  });
  it("declines when the deadline cannot fit minimum and reserve, including after TS-L", () => {
    const s = setup(); expect(selfTest(s, { ...STAGING, DEADLINE_IN: "10" }).stdout).toContain("rc=0");
    expect(parsedOf(s)).toMatchObject({ state: "incomplete", reason: "no_time" });
    expect(callsOf(s)).not.toContain("docker create");
    const used = setup();
    run(used, 'SECONDS=$((SECONDS + 690)); run_su1_check "$INSTANCE_ID"', { ...STAGING, INSTANCE_ID: INSTANCE });
    expect(parsedOf(used)).toMatchObject({ state: "incomplete", reason: "no_time" });
  });
  it("retains failed and missing check statuses but never evidence, and forces 9/10 pending", () => {
    const s = setup(); selfTest(s, STAGING, checkerOutput({ "1": "FAIL", "3": "missing", "9": "PASS", "10": "FAIL" }));
    const result = parsedOf(s);
    expect(result.items).toContain("1:fail:check_failed"); expect(result.items).toContain("3:incomplete:no_result");
    expect(result.items).toContain("9:pending:needs_model_run"); expect(result.items).toContain("10:pending:needs_model_run");
    expect(recorded(s)).not.toMatch(/private.example|10.0.0.5|DO_NOT_FORWARD|some_name/);
    expect(recorded(s)!.length).toBeLessThan(3000);
  });
  it("timeout is incomplete, never ran, and cleanup is read back", () => {
    const s = setup(); expect(selfTest(s, { ...STAGING, FORCE_TIMEOUT: "1" }).stdout).toContain("rc=0");
    expect(parsedOf(s)).toMatchObject({ state: "incomplete", reason: "budget" });
    expect(existsSync(s.marker)).toBe(false);
  });
  it("duplicate checker rows cannot create a pass", () => {
    const s = setup(); selfTest(s, STAGING, checkerOutput() + "\nSU1 1 PASS duplicate | ignored");
    expect(parsedOf(s).items).toContain("1:incomplete:no_result");
  });
  it.each(["LEAK_CONTAINER", "LEAK_NETWORK", "LEAK_VOLUME", "LEAK_RULE", "LEAK_IFACE", "MAKE_REORDER"])("fails closed on %s after cleanup", (name) => {
    const s = setup();
    const env: Record<string, string> = { ...STAGING, [name]: "1", SU1_SETTLE_TRIES: "1" };
    if (name === "MAKE_REORDER") env.LEAK_RULE = "1";
    expect(selfTest(s, env).stdout).toContain("rc=75");
    expect(parsedOf(s)).toMatchObject({ state: "unusable", reason: "cleanup_failed" }); expect(existsSync(s.marker)).toBe(true);
  });
  it("sweeps labelled leftovers with the switch off", () => {
    const s = setup(); writeFileSync(join(s.state, "containers_ws"), "c1\n");
    expect(run(s, 'su1_sweep_leftovers; echo "rc=$?"', { ...STAGING, AGENTX_SU1_CHECK: "" }).stdout).toContain("rc=0");
    expect(readFileSync(join(s.state, "containers_ws"), "utf8")).toBe(""); expect(recorded(s)).toBeUndefined();
  });
  it("a crash marker makes Docker errors strict; no marker makes a transient look nonfatal", () => {
    const s = setup();
    expect(run(s, 'su1_sweep_leftovers; echo "rc=$?"', { DOCKER_DOWN: "1" }).stdout).toContain("rc=0");
    writeFileSync(s.marker, "running");
    expect(run(s, 'su1_sweep_leftovers; echo "rc=$?"', { DOCKER_DOWN: "1" }).stdout).toContain("rc=1");
    expect(existsSync(s.marker)).toBe(true);
  });
  it("erases and reads back the lock even on a transient Docker error without a marker", () => {
    const s = setup(); writeFileSync(join(s.dir, "su1.lock"), "");
    expect(run(s, 'su1_sweep_leftovers; echo "rc=$?"', { DOCKER_DOWN: "1" }).stdout).toContain("rc=0");
    expect(existsSync(join(s.dir, "su1.lock"))).toBe(false);
  });
  it("an empty image bundle is incomplete, never an executed check", () => {
    const s = setup(); writeFileSync(join(s.fixtures, "setup-agent-su1.sh"), "");
    expect(selfTest(s, STAGING).stdout).toContain("rc=0");
    expect(parsedOf(s)).toMatchObject({ state: "incomplete", reason: "bundle_missing" });
    expect(existsSync(s.marker)).toBe(false);
  });
  it.each(["2", "3"])("clears partially created snapshot files when mktemp %s fails", (at) => {
    const s = setup();
    expect(selfTest(s, { ...STAGING, FAIL_MKTEMP_AT: at }).stdout).toContain("rc=0");
    expect(parsedOf(s)).toMatchObject({ state: "incomplete", reason: "snapshot_failed" });
    expect(readdirSync(s.dir).filter(name => name.startsWith("tmp."))).toEqual([]);
    expect(callsOf(s)).not.toContain("docker create");
  });
  it("never runs Docker past the hard deadline", () => {
    const s = setup();
    expect(run(s, 'SU1_HARD_DEADLINE=$SECONDS; su1_dk version; echo "rc=$?"').stdout).toContain("rc=124");
    expect(callsOf(s)).toBe("");
  });
  it("caps each command at remaining time with a KILL reserve", () => {
    const s = setup();
    expect(run(s, 'SU1_HARD_DEADLINE=$((SECONDS + 5)); su1_dk version').status).toBe(0);
    expect(readFileSync(join(s.state, "timeouts"), "utf8").trim()).toBe("--kill-after=2s 3s docker version");
  });
  it("runs the checker under a whole-group TERM/KILL timeout and passes the inner budget", () => {
    const s = setup();
    writeFileSync(join(s.dir, "s.sh"), 'echo "${SU1_TIMEOUT_SECONDS}:${SU1_DOCKER_TIMEOUT_SECONDS}"');
    expect(run(s, 'su1_run_checks 10 "$HOME" "$HOME/output"').status).toBe(0);
    expect(readFileSync(join(s.dir, "output"), "utf8")).toBe("10:15\n");
    expect(readFileSync(join(s.state, "timeouts"), "utf8").trim()).toBe(`--kill-after=2s 10s bash ${s.dir}/s.sh`);
  });
});

describe("SU-1 boot integration contracts", () => {
  const mainStubs = [
    'CONTAINED_RUNTIME_AVAILABLE_BOOT=false; WORKER_UNIT=fixture-worker.service',
    'fail() { echo "$*"; exit 75; }',
    // Keep the real SU-1 route, sweep and stage2_main. Stand in for the other
    // boot stages: none of these tests may touch a real host service or file.
    ...["pull_executor_image", "write_worker_environment", "tsl_sweep_leftovers", "install_function_runner_runsc", "pull_catalog_images", "write_test_services_environment", "set_docker_address_pools", "metadata_blocked", "wall_between_run_networks", "wall_ipv6_into_host", "install_run_walls_unit", "finish_function_runner", "write_test_services_boot_facts", "write_private_addresses", "write_worker_launcher", "write_worker_unit", "start_e2e_qualification"].map(name => `${name}() { :; }`),
  ].join("\n");
  it("the real main recomputes SU-1 time after TS-L and still starts the worker", () => {
    const s = setup();
    const result = run(s, `${mainStubs}\nrun_tsl_selftest() { SECONDS=$((BOOT_DEADLINE - 10)); }\nstage2_main region "$INSTANCE_ID"`, { ...STAGING, INSTANCE_ID: INSTANCE });
    expect(result.status, result.stderr).toBe(0);
    expect(parsedOf(s)).toMatchObject({ state: "incomplete", reason: "no_time" });
    expect(callsOf(s)).toContain("systemctl enable --now");
    expect(callsOf(s)).not.toContain("checks mode=");
  });
  it("the real main fails with su1_leftover before enabling a worker after failed cleanup", () => {
    const s = setup(); const out = join(s.dir, "checks.out"); writeFileSync(out, checkerOutput());
    const result = run(s, `${mainStubs}\nrun_tsl_selftest() { :; }\nstage2_main region "$INSTANCE_ID"`, { ...STAGING, INSTANCE_ID: INSTANCE, CHECKS_OUT: out, LEAK_CONTAINER: "1", SU1_SETTLE_TRIES: "1" });
    expect(result.status, result.stderr).toBe(75);
    expect(result.stdout).toContain("su1_leftover:");
    expect(parsedOf(s)).toMatchObject({ state: "unusable", reason: "cleanup_failed" });
    expect(callsOf(s)).not.toContain("systemctl enable");
  });
  it("starts after TS-L and before enabling the worker, and sweeps on every named boot", () => {
    const main = stage2.slice(stage2.indexOf("stage2_main()"));
    expect(main.indexOf("su1_sweep_leftovers")).toBeLessThan(main.indexOf("run_tsl_selftest"));
    expect(main.indexOf("run_su1_check")).toBeGreaterThan(main.indexOf("run_tsl_selftest"));
    expect(main.indexOf("run_su1_check")).toBeLessThan(main.indexOf("systemctl enable --now"));
    expect(main).toContain('fail "su1_leftover:');
    expect(stage2).toContain('args+=(--env "AGENTX_SU1_CHECK_RESULT=$su1_result")');
  });
  it("bounds requested budgets, remaining time and every Docker command", () => {
    const s = setup();
    for (const [value, expected] of [["45", "45"], ["300", "300"], ["44", "170"], ["301", "170"], ["oops", "170"]]) {
      expect(run(s, "su1_budget_seconds", { SU1_CHECK_BUDGET_S: value! }).stdout.trim()).toBe(expected);
    }
    expect(run(s, "su1_budget_seconds", { DEADLINE_IN: "200" }).stdout.trim()).toBe("50");
  });
});
