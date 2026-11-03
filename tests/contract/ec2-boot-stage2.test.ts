import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ec2WorkerBootScript, type Ec2WorkerBootConfig } from "../../packages/contracts/src/session.js";

// Task 10: a named environment's boot is two files. boot.sh is user data and stops after it pulls the worker image; the rest, boot-stage2.sh, is
// read out of that image, checked against a hash the control plane launched the worker with, and sourced. A legacy worker keeps today's boot.sh as
// boot-legacy.sh (ruling R58).
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const directoryOf = () => new URL("../../packages/worker/ec2/", import.meta.url).pathname;
const stage1 = read("packages/worker/ec2/boot.sh");
const stage2 = read("packages/worker/ec2/boot-stage2.sh");
const legacy = read("packages/worker/ec2/boot-legacy.sh");

/**
 * boot-legacy.sh: boot.sh as it stood on this plan's branch before the split (308a2cf8, the start-of-plan merge of origin/mainline), brought forward by each merge of origin/mainline.
 * Round 4 (mainline 46973735): re-taken after the three-way merge of mainline's boot.sh changes into it (kernel pin, MODEL3 worker environment, qualification diagnostics).
 */
export const BOOT_SH_AT_BRANCH_BASE_SHA256 = "a731533fe3cd7bca59455befabed6d9f1747022b005a3a1db4e8bf8f5c4c19e1";

/** Constants only the moved functions use: their declarations moved with them, and nothing else in the script changed. */
const MOVED_DECLARATIONS = [
  "readonly CONTAINED_IMAGE=node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9\n",
  "readonly WORKER_ENV_FILE=/etc/agentx/worker.env\n",
  "readonly WORKER_CONTAINER=agentx-worker\n",
  "readonly DOCKER_SOCKET=/var/run/docker.sock\n",
] as const;

const MOVED_FUNCTIONS = [
  "pull_contained_image",
  "pull_executor_image",
  "write_worker_environment",
  "write_worker_launcher",
  "write_worker_unit",
  "write_e2e_qualification_script",
  "start_e2e_qualification",
] as const;

/** `block_imds` with the comment lines just above it. It is the only function allowed to differ between the legacy script and stage 2 (see below). */
const BLOCK_IMDS_WITH_COMMENT = /(?:^#[^\n]*\n)*^block_imds\(\) \{\n[\s\S]*?^\}\n/mu;

const SETUP_ISOLATION_STATE_WITH_COMMENT = /(?:^#[^\n]*\n)*^setup_isolation_state\(\) \{\n[\s\S]*?^\}\n/mu;
// Test services slice 1: the launcher's run directory (a tmpfs the worker gets at the same path) is the one other named-environment-only addition inside a moved function.
const TEST_SERVICES_RUN_DIR_BLOCK = /^# Test services \(slice 1\): the run directory[^\n]*\n(?:#[^\n]*\n)*readonly TEST_SERVICES_RUN_DIR=[\s\S]*?^fi\n/mu;
const TEST_SERVICES_RUN_DIR_VOLUME = /^if \[\[ "\$test_services_run_dir" == true \]\]; then args\+=\([^\n]*\n/mu;
const SETUP_ISOLATION_ARGUMENT_WITH_COMMENT = /^# Setup runs need[^\n]*\nif named_environment; then args\+=\(--env "AGENTX_SETUP_ISOLATION=[^\n]*\n/mu;

describe("boot-legacy.sh", () => {
  it("is boot.sh as it was at the branch base, byte for byte", () => {
    expect(sha256(legacy)).toBe(BOOT_SH_AT_BRANCH_BASE_SHA256);
  });

  it("stage 2's block_imds applies the legacy metadata rules unchanged and last, after the setup run's rules in a fixed order (2026-11-03: the setup rules may now be withdrawn, see ec2-boot-config.test.ts)", () => {
    const legacyBlock = BLOCK_IMDS_WITH_COMMENT.exec(legacy)?.[0] ?? "";
    const stageBlock = BLOCK_IMDS_WITH_COMMENT.exec(stage2)?.[0] ?? "";
    expect(legacyBlock).toContain("block_imds() {");
    const rulesOf = (block: string) => [...block.matchAll(/"((?:DOCKER-USER|OUTPUT) [^"]+)"/gu)].map((match) => match[1]);
    const legacyRules = rulesOf(legacyBlock);
    expect(legacyRules).toHaveLength(2);
    const arrayOf = (name: string) => rulesOf(new RegExp(`local -a ${name}=\\(.*\\)`, "u").exec(stageBlock)?.[0] ?? "");
    // The two metadata rejections are exactly the legacy rules, in the legacy order, and each is fatal when it cannot be inserted.
    expect(arrayOf("imds_rules")).toEqual(legacyRules);
    expect(stageBlock).toContain('iptables -C $rule 2>/dev/null || iptables -I $rule || return 1');
    // The five others are the setup run's, in the fixed order, and are inserted before the metadata rules (so those end up on top).
    const setup = arrayOf("setup_rules");
    expect(setup).toHaveLength(5);
    expect(setup.every((rule) => /^DOCKER-USER -i rvbs\+ /u.test(rule!))).toBe(true);
    expect(stageBlock.indexOf('"${setup_rules[@]}"; do\n      # shellcheck disable=SC2086\n      iptables -C $rule 2>/dev/null || iptables -I')).toBeLessThan(stageBlock.indexOf('"${imds_rules[@]}"; do'));
    // Deletion only ever by rule text, and only of the setup rules.
    expect(stageBlock).not.toMatch(/iptables -[FXZ]\b/u);
    expect(stageBlock.match(/iptables -D /gu)).toHaveLength(1);
    expect(stageBlock).toContain('for rule in "${setup_rules[@]}"; do\n      # shellcheck disable=SC2086\n      if iptables -C $rule 2>/dev/null; then iptables -D $rule');
  });

  it("knows nothing of stage 2: a legacy worker's single-file boot is unchanged (R58)", () => {
    expect(legacy).not.toMatch(/stage2|STAGE2/iu);
    expect(legacy.endsWith('\nmain "$@"\n')).toBe(true);
    for (const name of MOVED_FUNCTIONS) expect(legacy, name).toContain(`\n${name}() {`);
  });
});

describe("boot.sh (stage 1) and boot-stage2.sh", () => {
  it("are valid bash", () => {
    for (const script of [stage1, stage2]) expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8" }).status).toBe(0);
  });

  it("move the long tail of the boot verbatim: stage 1 is the legacy script up to the first moved function, and stage 2 holds the rest as it was", () => {
    const firstMoved = "# This optional preload is bounded; failure leaves the worker available.\npull_contained_image() {";
    const mainStart = legacy.indexOf("\nmain() {");
    expect(legacy.indexOf(firstMoved)).toBeGreaterThan(-1);
    // The legacy script up to the first moved function, less the four declarations that moved with them, is the start of boot.sh unchanged.
    const prefix = MOVED_DECLARATIONS.reduce((text, declaration) => text.replace(declaration, ""), legacy.slice(0, legacy.indexOf(firstMoved)));
    expect(prefix.length).toBeLessThan(legacy.indexOf(firstMoved));
    // The test-services pieces (Docker's address pools, the rvi-to-rvi wall) are NOT in user data: they live in stage 2, to keep boot.sh under the user data limit.
    expect(stage1).not.toContain("default-address-pools");
    expect(stage1).not.toContain("--physdev-is-bridged");
    expect(stage1.startsWith(prefix)).toBe(true);
    for (const declaration of MOVED_DECLARATIONS) {
      expect(stage1, declaration).not.toContain(declaration);
      expect(stage2, declaration).toContain(declaration);
    }
    // Everything from pull_contained_image to the end of start_e2e_qualification is in stage 2 unchanged.
    const moved = legacy.slice(legacy.indexOf(firstMoved), mainStart + 1).trimEnd();
    // Named exceptions: `block_imds` (the launcher's firewall step, run only for a named environment, never by a legacy worker) may differ, because a setup run's network rules sit in it; and, since 2026-11-03, the reader of the
    // setup-isolation state file and the one line that hands its content to the worker (both named-environment only). Everything else is verbatim.
    const withoutSetupIsolation = (text: string) => text.replace(BLOCK_IMDS_WITH_COMMENT, "").replace(SETUP_ISOLATION_STATE_WITH_COMMENT, "").replace(SETUP_ISOLATION_ARGUMENT_WITH_COMMENT, "").replace(TEST_SERVICES_RUN_DIR_BLOCK, "").replace(TEST_SERVICES_RUN_DIR_VOLUME, "");
    expect(withoutSetupIsolation(stage2)).toContain(`\n${withoutSetupIsolation(moved)}\n`);
    for (const name of MOVED_FUNCTIONS) {
      expect(stage1, `${name} left boot.sh`).not.toContain(`\n${name}() {`);
      expect(stage2, `${name} is in stage 2`).toContain(`\n${name}() {`);
    }
  });

  it("change only main's call sites: stage 1 main ends at run_stage2, and stage2_main does what main did from there, in the same order, with the same BOOT_STEP labels", () => {
    const afterPull = '  pull_worker_image "$region"\n';
    const legacyTail = legacy.slice(legacy.indexOf(afterPull) + afterPull.length, legacy.indexOf('}\n\nmain "$@"'));
    expect(legacyTail).toContain('BOOT_STEP="start the worker"');
    expect(stage1.endsWith(`${afterPull}  run_stage2 "$region" "$instance_id"\n}\n\nmain "$@"\n`)).toBe(true);
    // Stage 1's main is the legacy main up to the pull.
    const legacyMainHead = legacy.slice(legacy.indexOf("\nmain() {"), legacy.indexOf(afterPull) + afterPull.length);
    expect(stage1).toContain(legacyMainHead);
    const stage2Main = /^stage2_main\(\) \{\n([\s\S]*?)^\}$/m.exec(stage2)?.[1] ?? "";
    // The one addition: in a named environment, after the worker environment is written and before the worker unit, Docker's address pools and the rvi-to-rvi wall (design test-services.md 4.0.1).
    const addition = '  write_worker_environment "$region"\n  if [[ ${AGENTX_ENVIRONMENT_KIND:-} == named ]]; then\n    write_test_services_environment || log "the test services settings could not be written (not fatal; runs with dependencies are refused)"\n    set_docker_address_pools || fail "could not set Docker\'s address pools"\n    metadata_blocked || fail "the metadata block is missing after the Docker restart"\n    wall_between_run_networks || fail "could not wall run networks off from each other"\n    wall_ipv6_into_host || fail "could not drop IPv6 from run networks into the host"\n    install_run_walls_unit || fail "could not install the unit that restores the run network walls"\n  fi\n';
    expect(legacyTail).toContain('  write_worker_environment "$region"\n');
    expect(stage2Main).toBe(`  local region=$1 instance_id=$2\n  BOOT_STEP="download the worker image"\n${legacyTail.replace('  write_worker_environment "$region"\n', addition)}`);
  });

  it("run the container wall before any container can start: stage 1 sets Docker up (and walls containers off) before it pulls, creates or runs anything", () => {
    const ensureDocker = /^ensure_docker\(\) \{[\s\S]*?^\}$/m.exec(stage1)?.[0] ?? "";
    expect(ensureDocker.trimEnd().endsWith("  wall_off_containers\n}")).toBe(true);
    expect(stage1).toContain("<<'FIREWALL'");
    expect(stage2).not.toContain("wall_off_containers");
    expect(stage2).not.toContain("<<'FIREWALL'");
    const main = stage1.slice(stage1.indexOf("\nmain() {"));
    expect(main.indexOf("  ensure_docker\n")).toBeGreaterThan(-1);
    expect(main.indexOf("  ensure_docker\n")).toBeLessThan(main.indexOf('pull_worker_image "$region"'));
    expect(main.indexOf('pull_worker_image "$region"')).toBeLessThan(main.indexOf("run_stage2"));
    expect(/^run_stage2\(\) \{[\s\S]*?^\}$/m.exec(stage1)?.[0] ?? "").toContain('docker create "$AGENTX_WORKER_IMAGE"');
  });

  it("define constants and functions only in stage 2, so sourcing it does nothing until stage2_main is called", () => {
    const sourced = spawnSync("bash", ["-c", 'set -euo pipefail; source "$1"; declare -F', "bash", join(directoryOf(), "boot-stage2.sh")], { encoding: "utf8" });
    expect(sourced.status, sourced.stderr).toBe(0);
    expect(sourced.stderr).toBe("");
    const defined = sourced.stdout.split("\n").filter(Boolean).map((line) => line.replace(/^declare -f /, "")).sort();
    expect(defined).toEqual([...MOVED_FUNCTIONS, "set_docker_address_pools", "metadata_blocked", "wall_between_run_networks", "ipv6_active", "wall_ipv6_into_host", "install_run_walls_unit", "instance_account_id", "write_test_services_environment", "stage2_main"].sort());
    expect(stage2).not.toMatch(/^main "\$@"/m);
  });
});

describe("the worker image carries stage 2", () => {
  it("copies boot-stage2.sh to /opt/agentx/boot/stage2.sh, read-only and owned by root, in the final stage", () => {
    const dockerfile = read("environments/base/Dockerfile");
    const finalStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    const copy = finalStage.split("\n").find((line) => line.startsWith("COPY ") && line.includes("packages/worker/ec2/boot-stage2.sh"));
    expect(copy, "a COPY of boot-stage2.sh").toBeDefined();
    expect(copy).toMatch(/ --chmod=0?444 /);
    expect(copy).toMatch(/ --chown=root:root /);
    expect(copy!.trim().endsWith(" packages/worker/ec2/boot-stage2.sh /opt/agentx/boot/stage2.sh")).toBe(true);
    // Not copied through the build stage's transformations, and the launcher still reads the file the hash was taken from.
    expect(copy).not.toContain("--from=");
    // Dockerfile* is ignored by .dockerignore, but the script is not.
    expect(read(".dockerignore")).not.toMatch(/boot-stage2|\.sh|ec2/u);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// The boot harness: boot.sh runs for real in bash (with its volume steps stood in for), with fake docker, sha256sum, systemctl and the like on
// PATH. The fake docker keeps the worker image's boot-stage2.sh in a file, as `docker cp` reads it out of the image.
// ---------------------------------------------------------------------------------------------------------------------------------------
const IMAGE = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx/worker@sha256:${"b".repeat(64)}`;
const MISMATCH_MESSAGE = "the worker image's boot steps do not match this control plane; the two come from different releases, so run agentx upgrade";

const bootConfig = (sha: string): Ec2WorkerBootConfig => ({
  workspaceId: randomUUID(),
  generation: 1,
  volumeId: "vol-0123456789abcdef0",
  expectNewVolume: true,
  workerImage: IMAGE,
  invokePublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE",
  controlPlaneUrl: "https://control.example.test",
  modelProvider: "amazon-bedrock",
  modelId: "us.anthropic.claude-sonnet-5-v1:0",
  promptCacheRetention: "long",
  logGroupName: "/agentx/test/worker",
  environmentKind: "named",
  modelProxyUrl: "http://proxy.example.test:4000",
  bootStage2Sha256: sha,
});

const FAKES: Record<string, string> = {
  docker: `#!/bin/bash
echo "docker $*" >>"$LOG"
case "$1" in
  create) echo cid-1 ;;
  cp) [[ -z "\${CP_FAILS:-}" ]] || exit 1
    # A symlink in the image is copied as a symlink (docker cp does not follow it), pointing at a file that holds the right bytes.
    if [[ -n "\${CP_LINKS:-}" ]]; then ln -s "$IMAGE_STAGE2" "$3"; else cp "$IMAGE_STAGE2" "$3"; fi ;;
  *) ;;
esac
`,
  // Linux's sha256sum prints "<hash>  <file>", as shasum does.
  sha256sum: `#!/bin/bash
exec shasum -a 256 "$@"
`,
  // A Docker restart that FLUSH_ON_RESTART=1 makes flush DOCKER-USER, to see what stage 2 does about it.
  systemctl: `#!/bin/bash
echo "systemctl $*" >>"$LOG"
if [ "$*" = "restart docker.service" ] && [ -n "\${FLUSH_ON_RESTART:-}" ]; then : >"$IPT_STATE"; fi
`,
  // A small stateful iptables for the DOCKER-USER chain: -C checks, -I puts a rule on top, -A at the bottom, -S prints.
  iptables: `#!/bin/bash
echo "iptables $*" >>"$LOG"
op=$1; shift
case "$op" in
  -C) grep -qxF -- "$*" "$IPT_STATE" ;;
  -I) { printf '%s\\n' "$*"; cat "$IPT_STATE"; } >"$IPT_STATE.new"; mv "$IPT_STATE.new" "$IPT_STATE" ;;
  -A) printf '%s\\n' "$*" >>"$IPT_STATE" ;;
  -S) [ "$1" = DOCKER-USER ] && sed 's/^/-A /' "$IPT_STATE"; exit 0 ;;
  *) exit 0 ;;
esac
`,
  // Runs the transient unit's command in the background, as systemd would, so the failure responder can be asked for /ping.
  "systemd-run": `#!/bin/bash
options=""
while [[ "$1" == --* ]]; do options="$options $1"; shift; done
echo "systemd-run$options" >>"$LOG"
nohup "$@" >/dev/null 2>&1 &
echo $! >"$RESPONDER_PID"
`,
  install: `#!/bin/bash
dir=0; args=()
while (($#)); do case "$1" in -d) dir=1 ;; -o|-g|-m) shift ;; *) args+=("$1") ;; esac; shift; done
if ((dir)); then mkdir -p "\${args[@]}"; else cp "\${args[0]}" "\${args[1]}"; fi
`,
  timeout: `#!/bin/bash
shift
exec "$@"
`,
  sleep: `#!/bin/bash
echo "sleep $*" >>"$LOG"
`,
  aws: `#!/bin/bash
echo "aws $*" >>"$LOG"
echo password
`,
  curl: `#!/bin/bash
case "$*" in
  *api/token*) echo token ;;
  *placement/region*) echo us-east-1 ;;
  *instance-id*) echo i-0123456789abcdef0 ;;
  *) exit 22 ;;
esac
`,
};

const directories: string[] = [];
const responders: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  for (const pidFile of responders.splice(0)) {
    try { process.kill(Number(readFileSync(pidFile, "utf8").trim())); } catch { /* never started, or already gone */ }
  }
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

interface Run {
  status: number | null;
  stderr: string;
  /** The calls the fakes recorded, in order. */
  calls: string[];
  /** What the boot left for the failure responder to serve on /ping. */
  failure: string | undefined;
  directory: string;
  port: number;
}

/**
 * Runs boot.sh, as cloud-init would run the rendered user data, with the worker image holding `served(directory)` as its boot-stage2.sh.
 * `expected` is the hash the control plane launched the worker with; by default, that of what the image holds.
 */
async function boot(options: { served: (directory: string) => string; expected?: string; cpFails?: boolean; noHash?: boolean; cpLinks?: boolean; flushOnRestart?: boolean; firewallRestores?: boolean; firewallRule?: string }): Promise<Run> {
  const directory = mkdtempSync(join(tmpdir(), "boot-stage2-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(FAKES)) { writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755); }
  const port = await freePort();
  // The paths a real boot writes as root are the test's own; nothing else of either file changes.
  const place = (text: string) => text
    .replaceAll("/run/agentx-boot-failure", `${directory}/failure`)
    .replaceAll("/run/agentx/boot-stage2.sh", `${directory}/run/agentx/boot-stage2.sh`)
    .replaceAll("/etc/docker", `${directory}/etc/docker`)
    .replaceAll("/etc/agentx", `${directory}/etc/agentx`)
    .replaceAll("/etc/systemd/system", `${directory}/etc/systemd`)
    .replaceAll("/usr/local/libexec", `${directory}/libexec`)
    .replaceAll("readonly WORKER_PORT=8080", `readonly WORKER_PORT=${port}`);
  mkdirSync(join(directory, "etc", "systemd"), { recursive: true });
  // Stage 1 stands in for the container firewall unit in this harness, so the script stage 2 runs again after a Docker restart is a stub that says so.
  mkdirSync(join(directory, "libexec"), { recursive: true });
  writeFileSync(join(directory, "libexec", "rovara-container-firewall"), `echo "rovara-container-firewall" >>"$LOG"\nrule="\${FW_RULE:-DOCKER-USER -d 169.254.169.254/32 -j DROP}"\n[ "\${FW_RESTORES:-1}" = 0 ] || grep -qxF "$rule" "$IPT_STATE" || echo "$rule" >>"$IPT_STATE"\n`);
  const served = options.served(directory);
  const image = join(directory, "image-stage2.sh");
  writeFileSync(image, served);
  // The boot's volume, device and runtime-directory steps need block devices and root; everything from Docker onwards runs as written, except
  // the container wall, whose rules need iptables (container-firewall.test.ts runs those).
  const stoodIn = `
wait_for_device() { echo /dev/fake; }
prepare_filesystem() { :; }
mount_workspace() { echo "mount_workspace" >>"$LOG"; }
prepare_contained_runtime_directories() { CONTAINED_RUNTIME_AVAILABLE_BOOT=true; }
wall_off_containers() { echo "wall_off_containers" >>"$LOG"; echo "DOCKER-USER -d 169.254.169.254/32 -j DROP" >>"$IPT_STATE"; }
`;
  expect(stage1.endsWith('\nmain "$@"\n')).toBe(true);
  const rendered = ec2WorkerBootScript(options.noHash ? { ...bootConfig(""), environmentKind: undefined, bootStage2Sha256: undefined } : bootConfig(options.expected ?? sha256(served)), place(stage1).replace(/\nmain "\$@"\n$/, `${stoodIn}\nmain "$@"\n`));
  const script = join(directory, "user-data.sh");
  writeFileSync(script, rendered);
  const log = join(directory, "calls.log");
  writeFileSync(log, "");
  writeFileSync(join(directory, "iptables.state"), "");
  const pid = join(directory, "responder.pid");
  responders.push(pid);
  const ran = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, LOG: log, IPT_STATE: join(directory, "iptables.state"),
      ...(options.flushOnRestart ? { FLUSH_ON_RESTART: "1" } : {}), ...(options.firewallRestores === false ? { FW_RESTORES: "0" } : {}), ...(options.firewallRule ? { FW_RULE: options.firewallRule } : {}), IMAGE_STAGE2: image, RESPONDER_PID: pid, AGENTX_TEST_LOG: log,
      ...(options.cpFails ? { CP_FAILS: "1" } : {}),
      ...(options.cpLinks ? { CP_LINKS: "1" } : {}),
    },
    timeout: 60_000,
  });
  const failureFile = join(directory, "failure");
  return {
    status: ran.status, stderr: ran.stderr, calls: readFileSync(log, "utf8").split("\n").filter(Boolean), directory, port,
    failure: existsSync(failureFile) ? readFileSync(failureFile, "utf8").trim() : undefined,
  };
}

/** The real stage 2, with the paths a root boot writes to moved under the run's directory in the same way boot.sh's are. */
const placedStage2 = (directory: string) => stage2
  .replaceAll("/etc/docker", `${directory}/etc/docker`)
  .replaceAll("/etc/agentx", `${directory}/etc/agentx`)
  .replaceAll("/etc/systemd/system", `${directory}/etc/systemd`)
  .replaceAll("/usr/local/libexec", `${directory}/libexec`);

async function ping(port: number): Promise<{ status: number; json: unknown }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ping`);
      return { status: response.status, json: await response.json() };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("the failure responder never answered");
}

describe("stage 1 runs stage 2 from the worker image", () => {
  it("starts the worker unit when the image's stage 2 matches the launch setting, after walling containers off and before any container is made", async () => {
    const run = await boot({ served: placedStage2 });
    expect(run.failure, run.stderr).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const at = (needle: string) => run.calls.findIndex((call) => call.includes(needle));
    expect(at("systemctl enable --now agentx-worker.service")).toBeGreaterThan(-1);
    // Stage 1: Docker is set up and walled off, then the image is pulled, then stage 2 is read out of it.
    expect(at("wall_off_containers")).toBeGreaterThan(-1);
    expect(at("wall_off_containers")).toBeLessThan(at(`docker create ${IMAGE}`));
    expect(at("wall_off_containers")).toBeLessThan(at(`docker pull ${IMAGE}`));
    expect(at(`docker pull ${IMAGE}`)).toBeLessThan(at(`docker create ${IMAGE}`));
    expect(run.calls.filter((call) => call.startsWith("docker create"))).toEqual([`docker create ${IMAGE}`]);
    expect(run.calls.find((call) => call.startsWith("docker cp "))).toMatch(/^docker cp cid-1:\/opt\/agentx\/boot\/stage2\.sh .*\/boot-stage2\.sh$/);
    // create, cp and rm, in that order.
    expect(at("docker create")).toBeLessThan(at("docker cp"));
    expect(at("docker cp")).toBeLessThan(at("docker rm cid-1"));
    // Stage 2 then does what main did after the pull: the optional pulls, then the unit.
    expect(at("docker rm cid-1")).toBeLessThan(at("docker pull node@sha256:"));
    expect(at("docker pull node@sha256:")).toBeLessThan(at("systemctl daemon-reload"));
    expect(at("systemctl daemon-reload")).toBeLessThan(at("systemctl enable --now agentx-worker.service"));
    // And in a named environment, before the worker unit is even written: daemon.json gets Docker's address pools, Docker restarts on them, the container firewall script runs again (Docker rebuilt its chains), then the rvi-to-rvi wall goes in.
    const restart = run.calls.findLastIndex((call) => call === "systemctl restart docker.service");
    expect(restart).toBeGreaterThan(at("docker pull node@sha256:"));
    expect(restart).toBeLessThan(run.calls.indexOf("rovara-container-firewall"));
    expect(run.calls.indexOf("rovara-container-firewall")).toBeLessThan(run.calls.findIndex((call) => call.startsWith("iptables -I DOCKER-USER -i rvi+ -o rvi+ -m physdev ! --physdev-is-bridged -j DROP")));
    expect(run.calls.findIndex((call) => call.startsWith("iptables -I DOCKER-USER -i rvi+ -o rvi+"))).toBeLessThan(at("systemctl daemon-reload"));
    expect(readFileSync(join(run.directory, "etc", "docker", "daemon.json"), "utf8")).toContain('"default-address-pools"');
    expect(readFileSync(join(run.directory, "etc", "agentx", "worker.env"), "utf8")).toContain(`AGENTX_SANDBOX_IMAGE=${IMAGE}\n`);
    expect(existsSync(join(run.directory, "etc", "systemd", "agentx-worker.service"))).toBe(true);
    expect(run.stderr).toContain("agentx-boot: worker started");
    expect(run.calls.some((call) => call.startsWith("systemd-run --unit=agentx-boot-failure"))).toBe(false);
  });

  const METADATA_RULE = "-A DOCKER-USER -d 169.254.169.254/32 -j DROP";
  const rulesAfter = (run: Run) => readFileSync(join(run.directory, "iptables.state"), "utf8").split("\n").filter(Boolean);

  it("a Docker restart that flushes DOCKER-USER does not leave the metadata address open: the container firewall script put its block back before the worker unit is written, and the boot goes on", async () => {
    const run = await boot({ served: placedStage2, flushOnRestart: true });
    expect(run.failure, run.stderr).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    expect(rulesAfter(run).map((rule) => `-A ${rule}`)).toContain(METADATA_RULE);
    // The flush really happened (the wall rule from before the restart is gone only if it was flushed; the wall is inserted after, so it is there too) and the block was checked before the unit was written.
    const at = (needle: string) => run.calls.findIndex((call) => call.includes(needle));
    expect(at("iptables -S DOCKER-USER")).toBeGreaterThan(at("rovara-container-firewall"));
    expect(at("iptables -S DOCKER-USER")).toBeLessThan(at("systemctl daemon-reload"));
  });

  it("a rule that names the metadata address but lets it through is not a block: the boot stops", async () => {
    const run = await boot({ served: placedStage2, flushOnRestart: true, firewallRule: "DOCKER-USER -d 169.254.169.254/32 -j ACCEPT" });
    expect(run.failure).toBe("the metadata block is missing after the Docker restart");
    const other = await boot({ served: placedStage2, flushOnRestart: true, firewallRule: "DOCKER-USER -d 169.254.169.253/32 -j DROP" });
    expect(other.failure).toBe("the metadata block is missing after the Docker restart");
  });

  it("stops the boot with the exact message, and starts no worker unit, when the metadata block is missing after the Docker restart (the restart flushed DOCKER-USER and the firewall script did not restore it)", async () => {
    const run = await boot({ served: placedStage2, flushOnRestart: true, firewallRestores: false });
    expect(run.status).not.toBe(0);
    expect(run.failure).toBe("the metadata block is missing after the Docker restart");
    expect(run.stderr).toContain("agentx-boot: FAILED: the metadata block is missing after the Docker restart");
    expect(rulesAfter(run)).not.toContain("DOCKER-USER -d 169.254.169.254/32 -j DROP");
    expect(run.calls.some((call) => call.startsWith("systemctl enable --now"))).toBe(false);
    expect(run.calls.some((call) => call.startsWith("systemctl daemon-reload"))).toBe(false);
    // And the rvi wall step after it did not run either: nothing after the failed check ran.
    expect(run.calls.some((call) => call.startsWith("iptables -I DOCKER-USER -i rvi+"))).toBe(false);
  });

  it("fails with the exact message, reports it on /ping and enables no worker unit when the image's stage 2 is not the one the launch setting names", async () => {
    // The image carries a different stage 2 than the one this control plane was released with.
    const run = await boot({ served: (directory) => `${placedStage2(directory)}\necho SOURCED >>"$AGENTX_TEST_LOG"\n`, expected: sha256(placedStage2("/elsewhere")) });
    expect(run.status).toBe(1);
    expect(run.failure).toBe(MISMATCH_MESSAGE);
    expect(run.stderr).toContain(`agentx-boot: FAILED: ${MISMATCH_MESSAGE}`);
    // The mismatched file is never sourced, so nothing it holds ran.
    expect(run.calls).not.toContain("SOURCED");
    expect(run.calls.some((call) => call.includes("agentx-worker.service"))).toBe(false);
    expect(run.calls.some((call) => call.startsWith("systemctl enable --now"))).toBe(false);
    expect(run.calls.some((call) => call.startsWith("systemctl daemon-reload"))).toBe(false);
    expect(run.calls.some((call) => call.startsWith("docker pull node@"))).toBe(false);
    expect(existsSync(join(run.directory, "etc", "agentx", "worker.env"))).toBe(false);
    // The container made to read the file is removed.
    expect(run.calls).toContain("docker rm cid-1");
    // The failure responder answers /ping with the reason, so the provisioner stops the session with it.
    expect(run.calls.some((call) => call.startsWith("systemd-run --unit=agentx-boot-failure"))).toBe(true);
    expect(await ping(run.port)).toEqual({ status: 503, json: { status: "BootFailed", reason: MISMATCH_MESSAGE } });
  });

  it("fails with its own reason when stage 2 cannot be read out of the image, and still removes the container", async () => {
    const run = await boot({ served: placedStage2, cpFails: true });
    expect(run.status).toBe(1);
    expect(run.failure).toBe("could not read the boot steps from the worker image");
    expect(run.calls).toContain("docker rm cid-1");
    expect(run.calls.some((call) => call.startsWith("systemctl enable --now"))).toBe(false);
  });

  it("refuses a stage 2 that is a symlink in the image, even when what it points at has the right hash, and never sources it", async () => {
    const run = await boot({ served: (directory) => `${placedStage2(directory)}\necho SOURCED >>"$AGENTX_TEST_LOG"\n`, cpLinks: true });
    expect(run.status).toBe(1);
    expect(run.failure).toBe("the boot steps in the worker image are not a regular file");
    expect(run.calls).not.toContain("SOURCED");
    expect(run.calls).toContain("docker rm cid-1");
    expect(run.calls.some((call) => call.startsWith("systemctl enable --now"))).toBe(false);
    expect(run.calls.some((call) => call.startsWith("docker pull node@"))).toBe(false);
  });

  it("sources the very file it hashed: one copy out of the image, held read-only for root, and no second read from the image", async () => {
    const run = await boot({ served: placedStage2 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.calls.filter((call) => call.startsWith("docker cp "))).toHaveLength(1);
    const staged = join(run.directory, "run", "agentx", "boot-stage2.sh");
    expect(statSync(staged).isFile()).toBe(true);
    expect(statSync(staged).mode & 0o777).toBe(0o400);
  });

  it("fails when the launch carries no stage 2 hash, before it creates a container", async () => {
    const run = await boot({ served: placedStage2, noHash: true });
    expect(run.status).toBe(1);
    expect(run.failure).toBe("AGENTX_BOOT_STAGE2_SHA256 is not set");
    expect(run.calls.some((call) => call.startsWith("docker create"))).toBe(false);
    expect(run.calls.some((call) => call.startsWith("systemctl enable --now"))).toBe(false);
  });
});
