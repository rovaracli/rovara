import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FUNCTION_RUNNER_AGENT_HOST_PATH, FUNCTION_RUNNER_GVISOR, FUNCTION_RUNNER_REPOSITORIES, FUNCTION_RUNNER_UNAVAILABLE_REASONS } from "@agentx/cloud-contracts";

// Slice 4, lane C1: the function runner's part of boot-stage2.sh, run for real in bash with fake curl, docker, df, uname and the like on PATH and the script's fixed system paths pointed at a temporary folder. The script runs as root on Linux;
// here every system path is rewritten in a COPY (the real file is read, so a changed path or constant fails the "paths" test first).
const stage2 = readFileSync(new URL("../../packages/worker/ec2/boot-stage2.sh", import.meta.url), "utf8");
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const sha512 = (bytes: Uint8Array) => createHash("sha512").update(bytes).digest("hex");
const REAL = { release: FUNCTION_RUNNER_GVISOR.release, aarch64: FUNCTION_RUNNER_GVISOR.sha512.aarch64, x86_64: FUNCTION_RUNNER_GVISOR.sha512.x86_64 };

/** A gvisor.tar.bz2 as the release has it: `runsc` (a script that prints a version), the shim and a directory with a helper. `extra` adds members for the refusal cases. */
function makeArchive(dir: string, name: string, options: { extra?: string; version?: string } = {}): { path: string; sha512: string } {
  const script = join(dir, `${name}.py`);
  writeFileSync(script, [
    "import io, sys, tarfile",
    "out = sys.argv[1]",
    "def add(t, name, data, mode=0o755):",
    "    i = tarfile.TarInfo(name); i.size = len(data); i.mode = mode; t.addfile(i, io.BytesIO(data))",
    "with tarfile.open(out, 'w:bz2') as t:",
    `    add(t, 'runsc', b'#!/bin/sh\\necho runsc version ${options.version ?? "release-20261109.0"}\\n')`,
    "    add(t, 'containerd-shim-runsc-v1', b'shim')",
    "    d = tarfile.TarInfo('gvisor-bin'); d.type = tarfile.DIRTYPE; d.mode = 0o755; t.addfile(d)",
    "    add(t, 'gvisor-bin/gvisor_sentry', b'sentry')",
    options.extra ?? "    pass",
  ].join("\n"));
  const path = join(dir, `${name}.tar.bz2`);
  const made = spawnSync("python3", ["-I", script, path], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(made.stderr);
  return { path, sha512: sha512(readFileSync(path)) };
}

/** An ELF header of 20 bytes for a machine byte (b7 aarch64, 3e x86-64), then padding. */
const elf = (machine: number) => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(14), Buffer.from([machine, 0x00]), Buffer.alloc(64)]);

interface Setup {
  dir: string;
  bin: string;
  calls: string;
  log: string;
  env: string;
  daemon: string;
  gvisor: string;
  agentDir: string;
}

function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), "ec2-function-runner-"));
  roots.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const s: Setup = { dir, bin, calls: join(dir, "calls"), log: join(dir, "log"), env: join(dir, "worker.env"), daemon: join(dir, "daemon.json"), gvisor: join(dir, "gv"), agentDir: join(dir, "agent") };
  writeFileSync(join(dir, "firewall.sh"), "exit 0\n");
  writeFileSync(s.calls, "");
  writeFileSync(s.log, "");
  writeFileSync(s.env, "AWS_REGION=us-west-2\n");
  const tool = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  tool("timeout", 'while [[ "$1" == --* ]]; do shift; done; shift; exec "$@"');
  tool("sha512sum", 'exec shasum -a 512 "$@"');
  tool("sleep", "exit 0");
  tool("chown", "exit 0");
  tool("systemctl", "exit 0");
  tool("uname", 'case "$1" in -m) printf "%s\\n" "${FAKE_UNAME_M:-aarch64}" ;; -r) printf "6.1.0-host\\n" ;; *) /usr/bin/uname "$@" ;; esac');
  // install(1) as root would run it: -o and -g (and their values) dropped.
  tool("install", 'args=(); while (($#)); do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; exec /usr/bin/install "${args[@]}"');
  tool("df", 'printf "Filesystem 1M-blocks Used Available Capacity Mounted\\n/dev/x 100000 1 %s 1%% /\\n" "${FREE_MB:-50000}"');
  // curl: CURL_PLAN is a space list of `good|bad|swap:<exit>`, one per call; `good` writes the real fixture, `swap` another valid archive, `bad` junk.
  tool("curl", [
    'out=""; url=""; while (($#)); do case "$1" in --output) out=$2; shift 2 ;; --proto|--max-filesize) shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done',
    'printf "%s\\n" "$url" >>"$CALLS_FILE"',
    'n=$(wc -l <"$CURL_COUNT" 2>/dev/null || echo 0); echo x >>"$CURL_COUNT"',
    'plan=(${CURL_PLAN:-good:0}); step=${plan[$n]:-${plan[${#plan[@]}-1]}}; kind=${step%%:*}; code=${step##*:}',
    'case "$kind" in good) cp "$ARCHIVE" "$out" ;; swap) cp "$SWAP_ARCHIVE" "$out" ;; *) printf "junk" >"$out" ;; esac',
    'exit "$code"',
  ].join("\n"));
  tool("docker", [
    'printf "docker %s\\n" "$*" >>"$CALLS_FILE"',
    'case "$1" in',
    '  info) if [[ -n "${DOCKER_RUNTIMES+x}" ]]; then printf "%s\\n" "$DOCKER_RUNTIMES"; else printf "%s\\n" "{\\"runc\\":{},\\"runsc\\":{}}"; fi ;;',
    '  run) case "$*" in *"--entrypoint cat"*) cat "$LIST_FILE" ;; *"--runtime runsc"*) exit "${SMOKE_EXIT:-0}" ;; *) exit 0 ;; esac ;;',
    '  image) [[ "$2" == inspect && "$3" == --format ]] && { printf "%s\\n" "${IMAGE_ARCH-arm64}"; exit 0; }; exit 0 ;;',
    '  create) printf "cid1\\n" ;;',
    '  cp) [[ -n "${AGENT_FIXTURE:-}" ]] && cp "$AGENT_FIXTURE" "${3}" ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join("\n"));
  return s;
}

const DIGESTS = { agent: "a".repeat(64), python: "b".repeat(64), nodejs: "c".repeat(64) };
const listFile = (s: Setup, lines: string[]) => { const file = join(s.dir, "list.json"); writeFileSync(file, `{\n  "schemaVersion": 1,\n  "images": [\n${lines.join("\n")}\n  ]\n}\n`); return file; };
const image = (repository: string, digest: string, last = false) => `    {\n      "id": "x@1",\n      "repository": "${repository}",\n      "digest": "${digest}",\n      "platforms": [\n        "linux/arm64"\n      ]\n    }${last ? "" : ","}`;
const fullList = (s: Setup) => listFile(s, [image("svc/function-agent", DIGESTS.agent), image("svc/lambda-nodejs", DIGESTS.nodejs), image("svc/lambda-python", DIGESTS.python, true)]);

/** Runs `body` in bash with stage 2 sourced from a copy whose system paths and (optionally) archive hashes are the test's. */
function run(s: Setup, body: string, env: Record<string, string> = {}, options: { sha512?: { aarch64?: string; x86_64?: string } } = {}) {
  let text = stage2
    .replaceAll("/usr/local/lib/rovara-gvisor", s.gvisor)
    .replaceAll("/opt/rovara/function-runner", s.agentDir)
    .replaceAll("/opt/rovara ", `${join(s.dir, "optrovara")} `)
    .replaceAll("/etc/docker/daemon.json", s.daemon)
    .replaceAll("/usr/local/libexec/rovara-container-firewall", join(s.dir, "firewall.sh"))
    .replaceAll("/var/tmp/", `${s.dir}/`);
  if (options.sha512?.aarch64 !== undefined) text = text.replace(`readonly GVISOR_SHA512_AARCH64=${REAL.aarch64}`, `readonly GVISOR_SHA512_AARCH64=${options.sha512.aarch64}`);
  if (options.sha512?.x86_64 !== undefined) text = text.replace(`readonly GVISOR_SHA512_X86_64=${REAL.x86_64}`, `readonly GVISOR_SHA512_X86_64=${options.sha512.x86_64}`);
  // WORKER_ENV_FILE is readonly in stage 2, so its path is rewritten in the copy too.
  const file = join(s.dir, "stage2.sh");
  writeFileSync(file, text.replace("readonly WORKER_ENV_FILE=/etc/agentx/worker.env", `readonly WORKER_ENV_FILE=${s.env}`));
  const script = `set -u\nlog() { printf '%s\\n' "$*" >>"$LOG_FILE"; }\nsource "${file}"\n${body}\n`;
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { PATH: `${s.bin}:/usr/bin:/bin:/usr/sbin:/sbin`, LOG_FILE: s.log, CALLS_FILE: s.calls, CURL_COUNT: join(s.dir, "curl-count"), FUNCTION_RUNNER_RETRY_SLEEP: "0", DOCKER_DATA_ROOT: s.dir, HOME: s.dir, ...env },
  });
}

const ON = { AGENTX_FUNCTION_RUNNER: "1", AGENTX_TEST_SERVICES: "1", AGENTX_WORKER_IMAGE: "944937319445.dkr.ecr.us-west-2.amazonaws.com/agentx-worker@sha256:" + "d".repeat(64), AGENTX_LOG_GROUP: "/agentx/staging/worker" };
const callsOf = (s: Setup) => readFileSync(s.calls, "utf8");
const logOf = (s: Setup) => readFileSync(s.log, "utf8");
const envOf = (s: Setup) => readFileSync(s.env, "utf8");

describe("boot-stage2.sh: the function runner's constants", () => {
  it("are bash, and hold the pinned release, URL, both sha512 values and the three repositories that the contracts hold (one source of truth, two places)", () => {
    expect(spawnSync("bash", ["-n"], { input: stage2, encoding: "utf8" }).status).toBe(0);
    const value = (name: string) => new RegExp(`^readonly ${name}=(.*)$`, "mu").exec(stage2)?.[1];
    expect(value("GVISOR_RELEASE")).toBe(FUNCTION_RUNNER_GVISOR.release);
    expect(value("GVISOR_BASE_URL")).toBe(FUNCTION_RUNNER_GVISOR.baseUrl);
    expect(value("GVISOR_SHA512_AARCH64")).toBe(FUNCTION_RUNNER_GVISOR.sha512.aarch64);
    expect(value("GVISOR_SHA512_X86_64")).toBe(FUNCTION_RUNNER_GVISOR.sha512.x86_64);
    expect(value("FUNCTION_RUNNER_AGENT_PATH")).toBe(FUNCTION_RUNNER_AGENT_HOST_PATH);
    expect(value("FUNCTION_RUNNER_REPOSITORIES")).toBe(`"${FUNCTION_RUNNER_REPOSITORIES.join(" ")}"`);
    // A dated release: the `latest` path 404s and would also move under us. And the hash is a full sha512, never a placeholder.
    expect(FUNCTION_RUNNER_GVISOR.baseUrl).toMatch(/\/release\/20\d{6}\.\d+$/u);
    expect(FUNCTION_RUNNER_GVISOR.baseUrl).not.toContain("latest");
    for (const hash of Object.values(FUNCTION_RUNNER_GVISOR.sha512)) expect(hash).toMatch(/^[a-f0-9]{128}$/u);
    expect(FUNCTION_RUNNER_GVISOR.sha512.aarch64).not.toBe(FUNCTION_RUNNER_GVISOR.sha512.x86_64);
  });

  it("every fixed reason the script gives is in the contracts' allow-list, and nothing else is ever a reason", () => {
    const used = [...stage2.matchAll(/function_runner_unavailable ([a-z-]+)/gu)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(5);
    for (const reason of used) expect(FUNCTION_RUNNER_UNAVAILABLE_REASONS as readonly string[], reason).toContain(reason);
    // Every reason the contracts list is one the script can give (no dead word).
    for (const reason of FUNCTION_RUNNER_UNAVAILABLE_REASONS) expect(used, reason).toContain(reason);
  });

  it("registers the runtime in the daemon.json that set_docker_address_pools writes (which writes the whole file, so nowhere else would survive), installs gVisor BEFORE it and checks everything AFTER the walls", () => {
    const main = /^stage2_main\(\) \{\n([\s\S]*?)^\}$/mu.exec(stage2)?.[1] ?? "";
    const at = (text: string) => main.indexOf(text);
    expect(at("pull_catalog_images")).toBeGreaterThan(-1);
    expect(at("install_function_runner_runsc")).toBeGreaterThan(at("pull_catalog_images"));
    expect(at("install_function_runner_runsc")).toBeLessThan(at("set_docker_address_pools"));
    expect(at("finish_function_runner")).toBeGreaterThan(at("install_run_walls_unit"));
    expect(at("finish_function_runner")).toBeLessThan(at("write_test_services_boot_facts"));
    expect(/^set_docker_address_pools\(\) \{[\s\S]*?^\}$/mu.exec(stage2)?.[0]).toContain("function_runner_daemon_runtimes");
    // Not offered by default: nothing in the control plane's launch settings turns it on yet.
    expect(readFileSync(new URL("../../infra/lib/control-plane.ts", import.meta.url), "utf8")).not.toContain("AGENTX_FUNCTION_RUNNER");
  });
});

describe("install_function_runner_runsc", () => {
  it("does nothing at all when the runner is not turned on (no download, no file, no state)", () => {
    const s = setup();
    const result = run(s, "install_function_runner_runsc; echo \"rc=$? state=$FUNCTION_RUNNER_STATE runsc=[$FUNCTION_RUNNER_RUNSC]\"; function_runner_daemon_runtimes", {});
    expect(result.stdout).toContain("rc=0 state=off runsc=[]");
    expect(callsOf(s)).toBe("");
    expect(existsSync(s.gvisor)).toBe(false);
    // Runner on but test services off is off too.
    const half = run(s, "install_function_runner_runsc; echo \"state=$FUNCTION_RUNNER_STATE\"", { AGENTX_FUNCTION_RUNNER: "1" });
    expect(half.stdout).toContain("state=off");
    expect(callsOf(s)).toBe("");
  });

  it("downloads the pinned dated release for this architecture over https, checks it against the script's own sha512, and installs it root-owned and not group- or world-writable", () => {
    const s = setup();
    const archive = makeArchive(s.dir, "good");
    const result = run(s, 'install_function_runner_runsc; echo "rc=$? state=$FUNCTION_RUNNER_STATE runsc=$FUNCTION_RUNNER_RUNSC"; function_runner_daemon_runtimes', { ...ON, ARCHIVE: archive.path }, { sha512: { aarch64: archive.sha512 } });
    expect(result.stdout).toContain(`rc=0 state=off runsc=${s.gvisor}/20261109.0/runsc`);
    expect(callsOf(s).trim()).toBe(`${FUNCTION_RUNNER_GVISOR.baseUrl}/aarch64/gvisor.tar.bz2`);
    for (const name of ["runsc", "containerd-shim-runsc-v1", "gvisor-bin/gvisor_sentry"]) {
      const mode = statSync(join(s.gvisor, "20261109.0", name)).mode & 0o777;
      expect(mode & 0o022, name).toBe(0);
      expect(mode & 0o100, name).not.toBe(0);
    }
    // The runtime entry is valid JSON and names exactly the path the script made.
    const runtimes = JSON.parse(`{${result.stdout.split("\n").find((line) => line.startsWith(", "))?.slice(1) ?? ""}}`) as { runtimes: { runsc: { path: string } } };
    expect(runtimes.runtimes.runsc.path).toBe(`${s.gvisor}/20261109.0/runsc`);
    // No staging folder is left behind.
    expect(readdirSync(s.dir).filter((name) => name.startsWith("rovara-gvisor."))).toEqual([]);
  });

  it("uses the x86_64 hash and path on an x86_64 machine, and refuses a machine it has no hash for (no download)", () => {
    const s = setup();
    const archive = makeArchive(s.dir, "x");
    const ok = run(s, "install_function_runner_runsc; echo rc=$?", { ...ON, ARCHIVE: archive.path, FAKE_UNAME_M: "x86_64" }, { sha512: { x86_64: archive.sha512 } });
    expect(ok.stdout).toContain("rc=0");
    expect(callsOf(s).trim()).toBe(`${FUNCTION_RUNNER_GVISOR.baseUrl}/x86_64/gvisor.tar.bz2`);
    // The aarch64 hash does not authorise an x86_64 download: with only the aarch64 hash replaced, the x86_64 machine refuses.
    const t = setup();
    const crossed = run(t, "install_function_runner_runsc; echo \"rc=$? state=$FUNCTION_RUNNER_STATE reason=$FUNCTION_RUNNER_REASON\"", { ...ON, ARCHIVE: archive.path, FAKE_UNAME_M: "x86_64" }, { sha512: { aarch64: archive.sha512 } });
    expect(crossed.stdout).toContain("rc=1 state=unavailable reason=runtime-install-failed");
    const u = setup();
    const odd = run(u, "install_function_runner_runsc; echo \"rc=$? reason=$FUNCTION_RUNNER_REASON\"", { ...ON, FAKE_UNAME_M: "riscv64" });
    expect(odd.stdout).toContain("rc=1 reason=arch-not-supported");
    expect(callsOf(u)).toBe("");
  });

  it("refuses a swapped download: bytes that do not hash to the pinned sha512 are never unpacked, on the first try, on every retry, and after a failed try that left a file behind", () => {
    const s = setup();
    const swapped = makeArchive(s.dir, "swapped", { version: "release-EVIL" });
    // The real pin (nothing patched): a valid archive of other bytes fails all three attempts.
    const result = run(s, 'install_function_runner_runsc; echo "rc=$? state=$FUNCTION_RUNNER_STATE reason=$FUNCTION_RUNNER_REASON runsc=[$FUNCTION_RUNNER_RUNSC]"; function_runner_daemon_runtimes', { ...ON, ARCHIVE: swapped.path, CURL_PLAN: "good:0" });
    expect(result.stdout).toContain("rc=1 state=unavailable reason=runtime-install-failed runsc=[]");
    expect(callsOf(s).trim().split("\n")).toHaveLength(3);
    expect(existsSync(s.gvisor)).toBe(false);
    expect(readdirSync(s.dir).filter((name) => name.startsWith("rovara-gvisor."))).toEqual([]);
    // The runtime is not offered to Docker.
    expect(result.stdout).not.toContain("runtimes");
    // A retry is checked like the first try: attempt 1 fails with a partial file, attempt 2 "succeeds" with junk, attempt 3 with another archive.
    const t = setup();
    const again = run(t, 'install_function_runner_runsc; echo "rc=$? runsc=[$FUNCTION_RUNNER_RUNSC]"', { ...ON, ARCHIVE: swapped.path, SWAP_ARCHIVE: swapped.path, CURL_PLAN: "bad:22 bad:0 swap:0" });
    expect(again.stdout).toContain("rc=1 runsc=[]");
    expect(existsSync(t.gvisor)).toBe(false);
  });

  it("accepts a retry that brings the right bytes (a flaky first download is not a failure), and the second file is the one that is checked", () => {
    const s = setup();
    const archive = makeArchive(s.dir, "good");
    const result = run(s, 'install_function_runner_runsc; echo "rc=$? runsc=$FUNCTION_RUNNER_RUNSC"', { ...ON, ARCHIVE: archive.path, CURL_PLAN: "bad:22 good:0" }, { sha512: { aarch64: archive.sha512 } });
    expect(result.stdout).toContain(`rc=0 runsc=${s.gvisor}/20261109.0/runsc`);
    expect(callsOf(s).trim().split("\n")).toHaveLength(2);
  });

  it("stops (not offered, nothing installed) when the download itself keeps failing", () => {
    const s = setup();
    const result = run(s, 'install_function_runner_runsc; echo "rc=$? reason=$FUNCTION_RUNNER_REASON"', { ...ON, CURL_PLAN: "bad:22" });
    expect(result.stdout).toContain("rc=1 reason=runtime-install-failed");
    expect(existsSync(s.gvisor)).toBe(false);
  });

  it("refuses an archive, even one with the right hash, that holds a link, a path that leaves the folder, a device-like name or too many files, and leaves nothing installed", () => {
    const cases: Record<string, string> = {
      symlink: "    l = tarfile.TarInfo('gvisor-bin/evil'); l.type = tarfile.SYMTYPE; l.linkname = '/etc/passwd'; t.addfile(l)",
      traversal: "    add(t, '../escape', b'x')",
      absolute: "    add(t, '/tmp/abs', b'x')",
      deep: "    add(t, 'gvisor-bin/a/b', b'x')",
      hidden: "    add(t, '.hidden', b'x')",
      hardlink: "    l = tarfile.TarInfo('hard'); l.type = tarfile.LNKTYPE; l.linkname = 'runsc'; t.addfile(l)",
      many: "    [add(t, 'f%d' % i, b'x') for i in range(70)]",
    };
    for (const [name, extra] of Object.entries(cases)) {
      const s = setup();
      const archive = makeArchive(s.dir, name, { extra });
      const result = run(s, 'install_function_runner_runsc; echo "rc=$? runsc=[$FUNCTION_RUNNER_RUNSC]"', { ...ON, ARCHIVE: archive.path }, { sha512: { aarch64: archive.sha512 } });
      expect(result.stdout, name).toContain("rc=1 runsc=[]");
      expect(existsSync(join(s.gvisor, "20261109.0")), name).toBe(false);
      expect(existsSync(join(s.dir, "escape")), name).toBe(false);
    }
  });

  it("refuses a runsc that does not run or is not this release (the version it prints must name the pinned release)", () => {
    const s = setup();
    const old = makeArchive(s.dir, "old", { version: "release-20200101.0" });
    const result = run(s, 'install_function_runner_runsc; echo "rc=$? runsc=[$FUNCTION_RUNNER_RUNSC]"', { ...ON, ARCHIVE: old.path }, { sha512: { aarch64: old.sha512 } });
    expect(result.stdout).toContain("rc=1 runsc=[]");
    expect(existsSync(join(s.gvisor, "20261109.0"))).toBe(false);
  });

  it("writes only a fixed reason to the log: no path, URL, hash or command output", () => {
    const s = setup();
    run(s, "install_function_runner_runsc", { ...ON, CURL_PLAN: "bad:22" });
    const log = logOf(s);
    expect(log).toContain("runtime-install-failed");
    for (const leaked of [s.dir, "storage.googleapis.com", REAL.aarch64.slice(0, 16), "junk"]) expect(log).not.toContain(leaked);
  });
});

describe("daemon.json (set_docker_address_pools)", () => {
  const pools = (s: Setup, env: Record<string, string>, prefix = "") => run(s, `${prefix}\nset_docker_address_pools; echo rc=$?`, env);
  it("is exactly today's file when no runtime was installed, and gains the runsc runtime (valid JSON, the data root and pools kept) when one was", () => {
    const s = setup();
    expect(pools(s, ON).stdout).toContain("rc=0");
    const plain = JSON.parse(readFileSync(s.daemon, "utf8")) as Record<string, unknown>;
    expect(Object.keys(plain).sort()).toEqual(["data-root", "default-address-pools"]);
    const t = setup();
    expect(pools(t, ON, `FUNCTION_RUNNER_RUNSC=${t.gvisor}/20261109.0/runsc`).stdout).toContain("rc=0");
    const withRuntime = JSON.parse(readFileSync(t.daemon, "utf8")) as { runtimes: { runsc: { path: string } }; "data-root": string; "default-address-pools": unknown[] };
    expect(withRuntime.runtimes.runsc.path).toBe(`${t.gvisor}/20261109.0/runsc`);
    expect(withRuntime["default-address-pools"]).toHaveLength(5);
    expect(withRuntime["data-root"]).toBe(t.dir);
    // A path the script did not make (an environment value that leaked into the variable) is not written.
    const u = setup();
    expect(pools(u, ON, "FUNCTION_RUNNER_RUNSC=/tmp/other/runsc").stdout).toContain("rc=0");
    expect(Object.keys(JSON.parse(readFileSync(u.daemon, "utf8")) as object)).not.toContain("runtimes");
  });
});

describe("function_runner_collect_pairs (the runner's images ride the services pre-pull)", () => {
  it("collects the three repositories by digest only, ignores a repository it does not know, and skips a digest that is not 64 hex digits", () => {
    const s = setup();
    const list = listFile(s, [image("svc/function-agent", DIGESTS.agent), image("svc/postgres", "e".repeat(64)), image("svc/lambda-nodejs", DIGESTS.nodejs), image("svc/lambda-python", "latest", true)]);
    const result = run(s, 'function_runner_collect_pairs; echo "rc=$? state=$FUNCTION_RUNNER_STATE reason=$FUNCTION_RUNNER_REASON"; printf "%s\\n" "${FUNCTION_RUNNER_PAIRS[@]:-}"', { ...ON, LIST_FILE: list });
    // lambda-python had a tag, not a digest: the list is incomplete, so the runner is not offered and nothing is pulled.
    expect(result.stdout).toContain("rc=1 state=unavailable reason=images-not-pulled");
    expect(result.stdout).not.toContain("svc/postgres");
    const t = setup();
    const ok = run(t, 'function_runner_collect_pairs; echo "rc=$?"; printf "%s\\n" "${FUNCTION_RUNNER_PAIRS[@]}"', { ...ON, LIST_FILE: fullList(t) });
    expect(ok.stdout.split("\n").filter(Boolean)).toEqual(["rc=0", `svc/function-agent@sha256:${DIGESTS.agent}`, `svc/lambda-nodejs@sha256:${DIGESTS.nodejs}`, `svc/lambda-python@sha256:${DIGESTS.python}`]);
    // The list is read out of the worker image with a throwaway cat that has no network.
    expect(callsOf(t)).toContain("--network none");
    expect(callsOf(t)).toContain("service-catalog/function-runner-prepull.json");
  });

  it("does not pull anything when the disk is under the free-space floor (the Lambda images are about 2.5 GB), and says why in one fixed word", () => {
    const s = setup();
    const result = run(s, 'function_runner_collect_pairs; echo "rc=$? state=$FUNCTION_RUNNER_STATE reason=$FUNCTION_RUNNER_REASON pairs=${#FUNCTION_RUNNER_PAIRS[@]}"', { ...ON, LIST_FILE: fullList(s), FREE_MB: "8000" });
    expect(result.stdout).toContain("rc=1 state=unavailable reason=disk-too-low pairs=0");
    expect(callsOf(s)).not.toContain("docker run");
    // Exactly at the floor is enough; a df that gives no number is a refusal.
    const t = setup();
    expect(run(t, "function_runner_collect_pairs; echo rc=$?", { ...ON, LIST_FILE: fullList(t), FREE_MB: "8192" }).stdout).toContain("rc=0");
    const u = setup();
    expect(run(u, "function_runner_collect_pairs; echo rc=$?", { ...ON, LIST_FILE: fullList(u), FREE_MB: "lots" }).stdout).toContain("rc=1");
  });

  it("is off when the runner is off: no df, no docker call, no pairs; and an empty (unpinned) list means not offered, not an error", () => {
    const s = setup();
    expect(run(s, 'function_runner_collect_pairs; echo "rc=$? n=${#FUNCTION_RUNNER_PAIRS[@]}"', { LIST_FILE: fullList(s) }).stdout).toContain("rc=1 n=0");
    expect(callsOf(s)).toBe("");
    const t = setup();
    const empty = run(t, 'function_runner_collect_pairs; echo "rc=$? reason=$FUNCTION_RUNNER_REASON"', { ...ON, LIST_FILE: listFile(t, []) });
    expect(empty.stdout).toContain("rc=1 reason=images-not-pulled");
  });
});

describe("finish_function_runner", () => {
  const pairs = `FUNCTION_RUNNER_PAIRS=("svc/function-agent@sha256:${DIGESTS.agent}" "svc/lambda-nodejs@sha256:${DIGESTS.nodejs}" "svc/lambda-python@sha256:${DIGESTS.python}"); FUNCTION_RUNNER_RUNSC=/x/runsc; PREPULL_FAILED_REPOS=""`;
  const finish = (s: Setup, env: Record<string, string>, prefix = pairs) => run(s, `${prefix}\nfinish_function_runner; echo "rc=$? state=$FUNCTION_RUNNER_STATE reason=$FUNCTION_RUNNER_REASON"`, { ...ON, ...env });
  const agentFile = (s: Setup, machine = 0xb7) => { const file = join(s.dir, "agent-fixture"); writeFileSync(file, elf(machine)); return file; };

  it("writes ready, the runtime and the agent path only when the runtime is registered, a container really runs under it, every image is of this architecture and the agent is a root-owned ELF for this machine", () => {
    const s = setup();
    const result = finish(s, { AGENT_FIXTURE: agentFile(s) });
    expect(result.stdout).toContain("rc=0 state=ready reason=");
    expect(envOf(s)).toContain(`AGENTX_FUNCTION_RUNNER=ready\nAGENTX_FUNCTION_RUNNER_RUNTIME=runsc\nAGENTX_FUNCTION_RUNNER_AGENT=${s.agentDir}/agent\n`);
    expect(envOf(s)).not.toContain("REASON");
    expect(statSync(join(s.agentDir, "agent")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(s.agentDir, "agent"))).toEqual(elf(0xb7));
    const calls = callsOf(s);
    // The smoke run is a real container under the runtime, with the host's kernel release as its argument, offline, read-only, no capability, never pulling.
    expect(calls).toMatch(/docker run --rm --pull never --runtime runsc --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint \/usr\/local\/bin\/node \S+@sha256:d{64} -e .* 6\.1\.0-host/u);
    // The agent is read out of its own image by digest, with no network, and the container is removed.
    expect(calls).toContain(`docker create --pull never --network none --entrypoint /agent 944937319445.dkr.ecr.us-west-2.amazonaws.com/rovara-catalog/staging/svc/function-agent@sha256:${DIGESTS.agent}`);
    expect(calls).toContain("docker rm -f cid1");
  });

  it("is a no-op that writes nothing when the runner is off", () => {
    const s = setup();
    const result = run(s, `${pairs}\nfinish_function_runner; echo "rc=$? state=$FUNCTION_RUNNER_STATE"`, {});
    expect(result.stdout).toContain("rc=0 state=off");
    expect(envOf(s)).toBe("AWS_REGION=us-west-2\n");
    expect(callsOf(s)).toBe("");
  });

  it("writes unavailable with one fixed reason, and never ready, when the runtime is not registered with Docker (flag on, no runtime)", () => {
    const s = setup();
    const result = finish(s, { DOCKER_RUNTIMES: '{"runc":{}}', AGENT_FIXTURE: agentFile(s) });
    expect(result.stdout).toContain("rc=0 state=unavailable reason=runtime-not-registered");
    expect(envOf(s)).toBe("AWS_REGION=us-west-2\nAGENTX_FUNCTION_RUNNER=unavailable\nAGENTX_FUNCTION_RUNNER_REASON=runtime-not-registered\n");
    expect(existsSync(join(s.agentDir, "agent"))).toBe(false);
    // And no runtime installed at all (the install failed earlier) is not ready either.
    const t = setup();
    const none = finish(t, { AGENT_FIXTURE: agentFile(t) }, `FUNCTION_RUNNER_PAIRS=("svc/function-agent@sha256:${DIGESTS.agent}"); FUNCTION_RUNNER_STATE=unavailable; FUNCTION_RUNNER_REASON=runtime-install-failed`);
    expect(none.stdout).toContain("state=unavailable reason=runtime-install-failed");
    expect(envOf(t)).toContain("AGENTX_FUNCTION_RUNNER_REASON=runtime-install-failed");
    expect(envOf(t)).not.toContain("=ready");
  });

  it("is not ready when the smoke container fails (a registered runtime that does not run)", () => {
    const s = setup();
    expect(finish(s, { SMOKE_EXIT: "3", AGENT_FIXTURE: agentFile(s) }).stdout).toContain("state=unavailable reason=runtime-smoke-failed");
    expect(existsSync(join(s.agentDir, "agent"))).toBe(false);
  });

  it("removes and refuses an image of another architecture (a wrong-arch image is never used)", () => {
    const s = setup();
    const result = finish(s, { IMAGE_ARCH: "amd64", AGENT_FIXTURE: agentFile(s) });
    expect(result.stdout).toContain("state=unavailable reason=images-not-pulled");
    expect(callsOf(s)).toMatch(/docker rmi \S+@sha256:/u);
    // The same on an x86_64 machine for an arm64 image.
    const t = setup();
    const crossed = finish(t, { IMAGE_ARCH: "arm64", FAKE_UNAME_M: "x86_64", AGENT_FIXTURE: agentFile(t, 0x3e) });
    expect(crossed.stdout).toContain("reason=images-not-pulled");
    const u = setup();
    expect(finish(u, { IMAGE_ARCH: "", AGENT_FIXTURE: agentFile(u) }).stdout).toContain("reason=images-not-pulled");
  });

  it("refuses an agent that is not an ELF, is for another machine, is a link, is empty or is missing", () => {
    const wrong = setup();
    expect(finish(wrong, { AGENT_FIXTURE: agentFile(wrong, 0x3e) }).stdout).toContain("reason=agent-unavailable");
    const text = setup();
    const textFile = join(text.dir, "agent-fixture"); writeFileSync(textFile, "#!/bin/sh\necho hi\n");
    expect(finish(text, { AGENT_FIXTURE: textFile }).stdout).toContain("reason=agent-unavailable");
    const empty = setup();
    const emptyFile = join(empty.dir, "agent-fixture"); writeFileSync(emptyFile, "");
    expect(finish(empty, { AGENT_FIXTURE: emptyFile }).stdout).toContain("reason=agent-unavailable");
    const missing = setup();
    expect(finish(missing, {}).stdout).toContain("reason=agent-unavailable");
    for (const s of [wrong, text, empty, missing]) { expect(existsSync(join(s.agentDir, "agent"))).toBe(false); expect(envOf(s)).not.toContain("=ready"); }
  });

  it("is not ready when the services pre-pull reported a runner repository as not pulled, or the list has no agent", () => {
    const s = setup();
    expect(finish(s, { AGENT_FIXTURE: agentFile(s) }, `${pairs.replace('PREPULL_FAILED_REPOS=""', 'PREPULL_FAILED_REPOS="svc/postgres,svc/lambda-python"')}`).stdout).toContain("reason=images-not-pulled");
    const t = setup();
    expect(finish(t, { AGENT_FIXTURE: agentFile(t) }, "FUNCTION_RUNNER_PAIRS=(); FUNCTION_RUNNER_RUNSC=/x/runsc").stdout).toContain("reason=images-not-pulled");
    // Another repository failing is none of the runner's business.
    const u = setup();
    expect(finish(u, { AGENT_FIXTURE: agentFile(u) }, `${pairs.replace('PREPULL_FAILED_REPOS=""', 'PREPULL_FAILED_REPOS="svc/postgres"')}`).stdout).toContain("state=ready");
  });

  it("keeps the services boot facts and a withheld worker as they are: its lines are appended and the file's other lines are untouched", () => {
    const s = setup();
    writeFileSync(s.env, "AWS_REGION=us-west-2\nAGENTX_TEST_SERVICES_NOT_PULLED=all\n");
    finish(s, { AGENT_FIXTURE: agentFile(s) });
    expect(envOf(s).startsWith("AWS_REGION=us-west-2\nAGENTX_TEST_SERVICES_NOT_PULLED=all\n")).toBe(true);
  });
});
