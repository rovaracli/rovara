// Test services slice 1: what the EC2 worker is told for the service runner (boot-stage2.sh) and what its image carries. Run against fake curl, install, mount and mountpoint tools.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseBootFacts } from "../../packages/worker/src/test-services-report.js";

const stage2 = readFileSync(new URL("../../packages/worker/ec2/boot-stage2.sh", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../../environments/base/Dockerfile", import.meta.url), "utf8");
const fn = (name: string): string => new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "mu").exec(stage2)?.[0] ?? "";
const IMAGE = `944937319445.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@sha256:${"a".repeat(64)}`;

function tools(directory: string, body: Record<string, string>): string {
  const bin = join(directory, "bin");
  spawnSync("mkdir", ["-p", bin]);
  for (const [name, text] of Object.entries(body)) { writeFileSync(join(bin, name), `#!/bin/bash\n${text}\n`); chmodSync(join(bin, name), 0o755); }
  return `${bin}:/usr/bin:/bin`;
}

describe("the worker's test services settings", () => {
  const run = (options: { image?: string; logGroup?: string } = {}) => {
    const directory = mkdtempSync(join(tmpdir(), "tsl-env-"));
    const envFile = join(directory, "worker.env");
    writeFileSync(envFile, "AGENTX_RUNTIME=ec2\n");
    // A curl that records any call: the settings need no metadata service any more (the worker trusts the catalog baked into its own image, so it needs no account id).
    const path = tools(directory, { curl: `echo "$@" >> "${directory}/curl.calls"; exit 22` });
    const program = `readonly WORKER_ENV_FILE=${envFile}\n${fn("write_test_services_environment")}\nwrite_test_services_environment`;
    const ran = spawnSync("/bin/bash", ["-c", program], { encoding: "utf8", env: { PATH: path, AGENTX_WORKER_IMAGE: options.image ?? IMAGE, AGENTX_LOG_GROUP: options.logGroup ?? "/agentx/staging/worker" } });
    let calls = "";
    try { calls = readFileSync(join(directory, "curl.calls"), "utf8"); } catch { /* none */ }
    return { status: ran.status, written: readFileSync(envFile, "utf8"), calls };
  };

  it("writes exactly these names: the registry from the worker image and the environment from the launch's log group (no run directory, no catalog directory, no account)", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.written).toBe([
      "AGENTX_RUNTIME=ec2",
      "AGENTX_TEST_SERVICES_REGISTRY=944937319445.dkr.ecr.us-west-2.amazonaws.com",
      "AGENTX_TEST_SERVICES_ENV=staging",
      "",
    ].join("\n"));
    // The run directory is added by the launcher only when the tmpfs was mounted (L2); the account is not needed (H4).
    expect(r.written).not.toMatch(/RUN_DIR|CATALOG_DIR|ACCOUNT_ID/u);
    expect(r.calls).toBe("");
    expect(stage2).not.toContain("instance_account_id");
    expect(stage2).not.toContain("AGENTX_TEST_SERVICES_ACCOUNT_ID=");
    // nothing is a secret, and no trusted key is in the settings
    expect(r.written).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD/u);
  });
  it("writes nothing when the image or the log group is not in the expected form (the settings are derived, never guessed)", () => {
    for (const options of [{ image: `docker.io/library/node@sha256:${"a".repeat(64)}` }, { logGroup: "/agentx/production/../worker" }, { logGroup: "/aws/other" }, { logGroup: "/agentx/Staging/worker" }]) {
      const r = run(options);
      expect(r.status, JSON.stringify(options)).not.toBe(0);
      expect(r.written, JSON.stringify(options)).toBe("AGENTX_RUNTIME=ec2\n");
    }
  });
  it("is written for a named environment only, only after root pulled the catalog images, and a failure is not fatal to the boot", () => {
    const main = fn("stage2_main");
    expect(main).toMatch(/if \[\[ \$\{AGENTX_ENVIRONMENT_KIND:-\} == named \]\]; then\n\s+if pull_catalog_images "\$region"; then\n\s+write_test_services_environment \|\| log /u);
    expect(main).toContain("test services are not offered on this worker");
    expect(main.indexOf("write_worker_environment")).toBeLessThan(main.indexOf("write_test_services_environment"));
  });
});

describe("root pulls the catalog images by digest before the worker starts (H2)", () => {
  const REPO_DIGEST = "c".repeat(64);
  const prepull = (images: Array<{ repository: string; digest: string }>) => JSON.stringify({ schemaVersion: 1, catalogRevision: 1, images: images.map((image, index) => ({ id: `thing${String(index)}@1`, ...image, platforms: ["linux/arm64"] })) }, null, 2);
  const run = (list: string | undefined, options: { pullExit?: number; loginExit?: number; present?: boolean; pullScript?: string; realTimeout?: boolean; env?: Record<string, string> } = {}) => {
    const directory = mkdtempSync(join(tmpdir(), "tsl-pull-"));
    if (list !== undefined) writeFileSync(join(directory, "prepull.json"), list);
    // The fake timeout records its arguments; with `realTimeout` it also kills the command after the duration (exit 124, as the real one does).
    const timeoutScript = [
      `echo "timeout $*" >> "${directory}/calls"`,
      'while [[ "$1" == --* ]]; do shift; done',
      ...(options.realTimeout === true
        ? ['d=${1%s}; shift', '"$@" & p=$!', '( sleep "$d"; kill $p 2>/dev/null ) >/dev/null 2>&1 & k=$!', 'wait $p; rc=$?; kill $k 2>/dev/null; if [ $rc -ge 128 ]; then exit 124; fi; exit $rc']
        : ['shift', 'exec "$@"']),
    ].join("\n");
    const path = tools(directory, {
      timeout: timeoutScript,
      aws: `echo "aws $@" >> "${directory}/calls"; echo token`,
      docker: [
        `echo "docker $@" >> "${directory}/calls"`,
        'case "$1" in',
        `  run) [ -f "${directory}/prepull.json" ] && cat "${directory}/prepull.json" || exit 1 ;;`,
        `  login) cat >/dev/null; exit ${String(options.loginExit ?? 0)} ;;`,
        `  image) exit ${options.present === true ? "0" : "1"} ;;`,
        `  pull) ${options.pullScript ?? `exit ${String(options.pullExit ?? 0)}`} ;;`,
        '  logout) ;;',
        'esac',
      ].join("\n"),
    });
    const program = `log() { echo "$*" >> "${directory}/log"; }\n${fn("pull_catalog_images")}\npull_catalog_images us-west-2`;
    const ran = spawnSync("/bin/bash", ["-c", program], { encoding: "utf8", env: { PATH: path, AGENTX_WORKER_IMAGE: IMAGE, AGENTX_LOG_GROUP: "/agentx/staging/worker", TMPDIR: directory, ...options.env } });
    const read = (name: string): string => { try { return readFileSync(join(directory, name), "utf8"); } catch { return ""; } };
    return { status: ran.status, calls: read("calls"), log: read("log"), directory, read };
  };

  it("logs in to the registry and pulls each pinned digest of the worker image's list, by digest, from the environment's catalog repository", () => {
    const r = run(prepull([{ repository: "svc/postgres", digest: REPO_DIGEST }]));
    expect(r.status).toBe(0);
    expect(r.calls).toContain("aws ecr get-login-password --region us-west-2");
    expect(r.calls).toContain("docker login --username AWS --password-stdin 944937319445.dkr.ecr.us-west-2.amazonaws.com");
    expect(r.calls).toContain(`docker pull 944937319445.dkr.ecr.us-west-2.amazonaws.com/rovara-catalog/staging/svc/postgres@sha256:${REPO_DIGEST}`);
    // The list is read with one throwaway `cat` of the image's file, not a copy-out of the image.
    expect(r.calls).toContain("--entrypoint cat");
    expect(r.calls).toContain("/opt/agentx/packages/worker/service-catalog/prepull.json");
    expect(r.calls).not.toContain("docker cp");
    expect(r.calls).not.toContain("docker create");
    // No ECR token is left on disk: the logout comes after the last pull.
    expect(r.calls.lastIndexOf("docker logout 944937319445.dkr.ecr.us-west-2.amazonaws.com")).toBeGreaterThan(r.calls.lastIndexOf("docker pull"));
  });
  it("does nothing, quietly and successfully, for a worker whose image pins nothing or has no list (boot is not broken)", () => {
    for (const list of [prepull([]), undefined]) {
      const r = run(list);
      expect(r.status).toBe(0);
      expect(r.calls).not.toContain("docker pull");
      expect(r.calls).not.toContain("docker login");
    }
  });
  it("pulls nothing that is not a catalog repository by digest: a path out of svc/ is ignored, and nothing is pulled by tag", () => {
    const r = run(prepull([{ repository: "../worker", digest: REPO_DIGEST }, { repository: "svc/Upper", digest: REPO_DIGEST }]));
    expect(r.calls).not.toContain("docker pull");
    // And no pull line without a digest.
    expect(r.calls).not.toMatch(/docker pull [^@\n]*\n/u);
  });
  it("skips an image that is already here, and fails loudly (status 1, a log line) when the login or a pull fails", () => {
    expect(run(prepull([{ repository: "svc/postgres", digest: REPO_DIGEST }]), { present: true }).calls).not.toContain("docker pull");
    for (const options of [{ pullExit: 1 }, { loginExit: 1 }]) {
      const r = run(prepull([{ repository: "svc/postgres", digest: REPO_DIGEST }]), options);
      expect(r.status, JSON.stringify(options)).toBe(1);
      expect(r.log, JSON.stringify(options)).toContain("CATALOG PRE-PULL FAILED");
      expect(r.calls, JSON.stringify(options)).toContain("docker logout 944937319445.dkr.ecr.us-west-2.amazonaws.com");
    }
  });
});

describe("the boot pulls are bounded per image and run in parallel (slice-1 follow-up b)", () => {
  const digests = (count: number): Array<{ repository: string; digest: string }> => Array.from({ length: count }, (_, index) => ({ repository: `svc/thing${String(index)}`, digest: index.toString(16).padStart(64, "d") }));
  const list = (count: number): string => JSON.stringify({ schemaVersion: 1, catalogRevision: 1, images: digests(count).map((image, index) => ({ id: `thing${String(index)}@1`, ...image, platforms: ["linux/arm64"] })) }, null, 2);
  // Builds the same fake host as the block above, with a count of pulls running at once.
  function drive(images: number, options: { pullScript: string; realTimeout?: boolean; env?: Record<string, string> }) {
    const directory = mkdtempSync(join(tmpdir(), "tsl-par-"));
    writeFileSync(join(directory, "prepull.json"), list(images));
    const timeoutScript = [
      `echo "timeout $*" >> "${directory}/calls"`,
      'while [[ "$1" == --* ]]; do shift; done',
      ...(options.realTimeout === true
        ? ['d=${1%s}; shift', '"$@" & p=$!', '( sleep "$d"; kill $p 2>/dev/null ) >/dev/null 2>&1 & k=$!', 'wait $p; rc=$?; kill $k 2>/dev/null; if [ $rc -ge 128 ]; then exit 124; fi; exit $rc']
        : ['shift', 'exec "$@"']),
    ].join("\n");
    const path = tools(directory, {
      timeout: timeoutScript,
      aws: 'echo token',
      docker: [
        'case "$1" in',
        `  run) cat "${directory}/prepull.json" ;;`,
        '  login) cat >/dev/null ;;',
        '  image) exit 1 ;;',
        `  pull) echo "pull $2" >> "${directory}/pulls"; ${options.pullScript} ;;`,
        '  logout) echo logout >> "' + directory + '/calls" ;;',
        'esac',
      ].join("\n"),
    });
    const program = `log() { echo "$*" >> "${directory}/log"; }\n${fn("pull_catalog_images")}\npull_catalog_images us-west-2`;
    const started = Date.now();
    const ran = spawnSync("/bin/bash", ["-c", program], { encoding: "utf8", env: { PATH: path, AGENTX_WORKER_IMAGE: IMAGE, AGENTX_LOG_GROUP: "/agentx/staging/worker", TMPDIR: directory, ...options.env } });
    const read = (name: string): string => { try { return readFileSync(join(directory, name), "utf8"); } catch { return ""; } };
    return { status: ran.status, calls: read("calls"), log: read("log"), pulls: read("pulls").split("\n").filter((line) => line !== ""), seconds: (Date.now() - started) / 1000, read };
  }
  it("gives every pull its own time limit (180 s by default, killed 10 s later) instead of one long wait per image", () => {
    const r = drive(3, { pullScript: "exit 0" });
    expect(r.status).toBe(0);
    expect(r.calls.match(/timeout --foreground --kill-after=10s 180s docker pull /gu)).toHaveLength(3);
    expect(r.calls).not.toContain("600s");
    expect(stage2).not.toContain("600s docker pull");
  });
  it("pulls several images at once, never more than four", () => {
    // The harness makes its own directory, so the slow pull writes to a path the test passes through the environment.
    const directory = mkdtempSync(join(tmpdir(), "tsl-par-conc-"));
    const r = drive(7, { pullScript: `d="$TSL_CONC"; mkdir -p "$d/active"; touch "$d/active/$$"; ls "$d/active" | wc -l >> "$d/concurrency"; sleep 1; rm -f "$d/active/$$"`, env: { TSL_CONC: directory } });
    expect(r.status).toBe(0);
    expect(r.pulls).toHaveLength(7);
    const seen = readFileSync(join(directory, "concurrency"), "utf8").split("\n").filter((line) => line !== "").map(Number);
    expect(Math.max(...seen)).toBeGreaterThan(1);
    expect(Math.max(...seen)).toBeLessThanOrEqual(4);
    // 7 one-second pulls, 4 at a time: about two seconds, not seven.
    expect(r.seconds).toBeLessThan(6);
  });
  it("takes CATALOG_PULL_PARALLEL and CATALOG_PULL_TIMEOUT_S only as positive whole numbers: 0, text, a sign or a decimal fall back to 4 and 180 s", () => {
    for (const bad of ["0", "x", "", "-1", "1.5", "04x", " 2"]) {
      const r = drive(5, { pullScript: "exit 0", env: { CATALOG_PULL_PARALLEL: bad, CATALOG_PULL_TIMEOUT_S: bad } });
      expect(r.status, JSON.stringify(bad)).toBe(0);
      expect(r.pulls, JSON.stringify(bad)).toHaveLength(5);
      expect(r.calls.match(/timeout --foreground --kill-after=10s 180s docker pull /gu), JSON.stringify(bad)).toHaveLength(5);
    }
    // A good value is used: 3 s limit.
    expect(drive(2, { pullScript: "exit 0", env: { CATALOG_PULL_TIMEOUT_S: "3" } }).calls).toContain("3s docker pull ");
  });
  it("with an invalid parallel setting pulls up to 4 at once, not 0 (which would never start) and not all", () => {
    const directory = mkdtempSync(join(tmpdir(), "tsl-par-bad-"));
    const r = drive(7, { pullScript: `d="$TSL_CONC"; mkdir -p "$d/active"; touch "$d/active/$$"; ls "$d/active" | wc -l >> "$d/concurrency"; sleep 1; rm -f "$d/active/$$"`, env: { TSL_CONC: directory, CATALOG_PULL_PARALLEL: "0" } });
    expect(r.status).toBe(0);
    const seen = readFileSync(join(directory, "concurrency"), "utf8").split("\n").filter((line) => line !== "").map(Number);
    expect(Math.max(...seen)).toBeGreaterThan(1);
    expect(Math.max(...seen)).toBeLessThanOrEqual(4);
  });
  it("a hung pull is killed at its own limit and only that image is not offered: the others are pulled and stay available (partial, status 0)", () => {
    // Image 0 hangs (a long sleep); the limit is 2 s. The other images pull at once.
    const hungDigest = digests(5)[0]!.digest;
    const r = drive(5, { pullScript: `case "$2" in *${hungDigest}) exec sleep 60 ;; *) exit 0 ;; esac`, realTimeout: true, env: { CATALOG_PULL_TIMEOUT_S: "2" } });
    expect(r.status).toBe(0);
    expect(r.log).toContain("CATALOG PRE-PULL PARTIAL");
    expect(r.log).toContain("pulled 4");
    expect(r.log).toContain("svc/thing0");
    expect(r.log).not.toContain("svc/thing1");
    expect(r.seconds).toBeLessThan(12);
    expect(r.calls).toContain("logout");
    expect(r.pulls).toHaveLength(5);
    expect(r.pulls.filter((line) => line.includes(hungDigest))).toHaveLength(1);
  });
  it("a failed pull never stops the others from starting, even one at a time; with nothing pulled at all it is a failure (status 1)", () => {
    const failing = drive(4, { pullScript: "exit 1", env: { CATALOG_PULL_PARALLEL: "1" } });
    expect(failing.status).toBe(1);
    expect(failing.pulls).toHaveLength(4);
    expect(failing.log).toContain("CATALOG PRE-PULL FAILED");
    // The second image fails, the rest arrive: partial, and the failure is named by repository.
    const digestOfSecond = digests(4)[1]!.digest;
    const some = drive(4, { pullScript: `case "$2" in *${digestOfSecond}) exit 1 ;; *) exit 0 ;; esac`, env: { CATALOG_PULL_PARALLEL: "1" } });
    expect(some.status).toBe(0);
    expect(some.pulls).toHaveLength(4);
    expect(some.log).toContain("CATALOG PRE-PULL PARTIAL: pulled 3, not offered on this worker: svc/thing1");
  });
  it("once the boot deadline has passed the images not yet started count as not pulled (the boot is not held)", () => {
    const r = drive(3, { pullScript: "exit 0", env: { BOOT_DEADLINE: "0" } });
    expect(r.pulls).toHaveLength(0);
    expect(r.status).toBe(1);
    expect(r.log).toContain("CATALOG PRE-PULL FAILED");
  });
  it("counts every image it pulled in the boot facts and still logs out", () => {
    const r = drive(6, { pullScript: "exit 0" });
    expect(r.status).toBe(0);
    expect(r.log).toContain("pulled 6 catalog image(s) by digest");
    expect(r.calls).toContain("logout");
  });
});

describe("the run directory and the catalog in the image", () => {
  const launcher = /<<'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/u.exec(stage2)?.[1] ?? "";
  it("is a small tmpfs the launcher makes at every start, owned by the worker's user, no exec, at the same path on the host and in the worker", () => {
    const body = /^prepare_test_services_run_dir\(\) \{\n[\s\S]*?^\}$/mu.exec(launcher)?.[0] ?? "";
    expect(body).not.toBe("");
    const directory = mkdtempSync(join(tmpdir(), "tsl-run-"));
    const path = tools(directory, {
      install: `echo "install $@" >> "${directory}/calls"`,
      mount: `echo "mount $@" >> "${directory}/calls"`,
      mountpoint: `[ -f "${directory}/mounted" ]; rc=$?; [ -f "${directory}/calls" ] && grep -q '^mount ' "${directory}/calls" && touch "${directory}/mounted" && rc=0; exit $rc`,
    });
    const ran = spawnSync("/bin/bash", ["-c", `WORKER_UID=1000\nWORKER_GID=1000\nTEST_SERVICES_RUN_DIR=/run/agentx-test-services\n${body}\nprepare_test_services_run_dir`], { encoding: "utf8", env: { PATH: path } });
    expect(ran.status, ran.stderr).toBe(0);
    const calls = readFileSync(join(directory, "calls"), "utf8");
    expect(calls).toContain("install -d -o 1000 -g 1000 -m 0700 /run/agentx-test-services");
    expect(calls).toContain("mount -t tmpfs -o size=64m,mode=0700,uid=1000,gid=1000,nosuid,nodev,noexec tmpfs /run/agentx-test-services");
    // the worker gets the same path, only when it exists, and a failure to make it is not fatal
    // L2: the worker is told the run directory ONLY when the tmpfs was mounted, so a worker whose mount failed has an incomplete configuration and offers no test services.
    expect(launcher).toContain('if [[ "$test_services_run_dir" == true ]]; then args+=(--volume "$TEST_SERVICES_RUN_DIR:$TEST_SERVICES_RUN_DIR" --env "AGENTX_TEST_SERVICES_RUN_DIR=$TEST_SERVICES_RUN_DIR"); fi');
    expect(stage2.match(/AGENTX_TEST_SERVICES_RUN_DIR/gu)?.length).toBeLessThanOrEqual(3);
    expect(fn("write_test_services_environment")).not.toContain("RUN_DIR");
    expect(launcher).toContain("log 'test services run directory unavailable (not fatal)'");
    expect(launcher).toContain("readonly TEST_SERVICES_RUN_DIR=/run/agentx-test-services");
  });
  it("makes the run directory only for a named environment, after the metadata block", () => {
    expect(launcher.indexOf("block_imds ||")).toBeLessThan(launcher.indexOf("prepare_test_services_run_dir; then"));
    expect(launcher).toMatch(/if named_environment; then\n\s+if prepare_test_services_run_dir/u);
  });
  it("ships catalog.json and, once built, catalog.sig.json beside the pre-pull list (no key file: the trusted keys are compiled in)", () => {
    expect(dockerfile).toContain("COPY --from=build /opt/agentx/environments/service-catalog/catalog*.json ./packages/worker/service-catalog/");
    expect(dockerfile.indexOf("COPY --from=build /opt/agentx/packages/worker ./packages/worker")).toBeLessThan(dockerfile.indexOf("COPY --from=build /opt/agentx/environments/service-catalog/catalog*.json"));
    expect(dockerfile).not.toMatch(/service-catalog[^\n]*\.pem|trusted[-_]keys/iu);
  });
});

describe("the facts root hands to the worker for its CloudWatch self-report (staging workers are not SSM-managed)", () => {
  const facts = (world: { metadata?: boolean; walls?: boolean; ip6?: boolean; ip6tables?: boolean; version?: string; prepull?: string; count?: number; loggedOut?: boolean } = {}) => {
    const directory = mkdtempSync(join(tmpdir(), "tsl-facts-"));
    const envFile = join(directory, "worker.env");
    writeFileSync(envFile, "AGENTX_RUNTIME=ec2\n");
    const path = tools(directory, {
      iptables: world.walls === false ? "exit 1" : "exit 0",
      ip6tables: world.ip6tables === false ? "exit 1" : world.ip6 === false ? 'case "$*" in "-S INPUT") exit 0 ;; *) exit 1 ;; esac' : "exit 0",
      docker: `echo "${world.version ?? "25.0.5"}"`,
    });
    const program = [
      `readonly WORKER_ENV_FILE=${envFile}`, `metadata_blocked() { return ${world.metadata === false ? "1" : "0"}; }`, "ipv6_active() { return 0; }",
      `PREPULL_RESULT=${world.prepull ?? "ok"}; PREPULL_COUNT=${String(world.count ?? 1)}; PREPULL_LOGGED_OUT=${world.loggedOut === false ? "false" : "true"}`,
      fn("write_test_services_boot_facts"), "write_test_services_boot_facts",
    ].join("\n");
    const ran = spawnSync("/bin/bash", ["-c", program], { encoding: "utf8", env: { PATH: path } });
    const written = readFileSync(envFile, "utf8");
    return { status: ran.status, written, value: /^AGENTX_TEST_SERVICES_BOOT_FACTS=(.*)$/mu.exec(written)?.[1] };
  };

  it("writes one environment line whose value the worker reads: booleans, a count and a version, nothing else", () => {
    const r = facts();
    expect(r.status).toBe(0);
    expect(parseBootFacts(r.value)).toEqual({ metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "ok", prepulled: 1, loggedOut: true, dockerVersion: "25.0.5" });
    expect(r.written.split("\n").filter((line) => line.startsWith("AGENTX_TEST_SERVICES_BOOT_FACTS="))).toHaveLength(1);
    expect(r.written).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD|arn:|\.amazonaws\.com/u);
  });
  it("says false for a missing metadata block or wall, and carries a failed pre-pull and a login that was not removed", () => {
    expect(parseBootFacts(facts({ metadata: false }).value)).toMatchObject({ metadataBlocked: false });
    expect(parseBootFacts(facts({ walls: false }).value)).toMatchObject({ runWalls: false });
    expect(parseBootFacts(facts({ prepull: "failed", count: 0, loggedOut: false }).value)).toMatchObject({ prepull: "failed", prepulled: 0, loggedOut: false });
  });
  it("carries a partial pre-pull (some images arrived) as `partial`, and the not-pulled repositories reach the worker's environment file, well-formed only", () => {
    expect(parseBootFacts(facts({ prepull: "partial", count: 2 }).value)).toMatchObject({ prepull: "partial", prepulled: 2 });
    const write = (repos: string) => {
      const directory = mkdtempSync(join(tmpdir(), "tsl-notpulled-"));
      const envFile = join(directory, "worker.env");
      writeFileSync(envFile, "AGENTX_RUNTIME=ec2\n");
      const program = [`readonly WORKER_ENV_FILE=${envFile}`, `PREPULL_FAILED_REPOS='${repos}'`, fn("write_test_services_environment"), "write_test_services_environment"].join("\n");
      spawnSync("/bin/bash", ["-c", program], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", AGENTX_WORKER_IMAGE: IMAGE, AGENTX_LOG_GROUP: "/agentx/staging/worker" } });
      return readFileSync(envFile, "utf8");
    };
    expect(write("svc/local-aws,svc/postgres")).toContain("AGENTX_TEST_SERVICES_NOT_PULLED=svc/local-aws,svc/postgres\n");
    expect(write("")).not.toContain("NOT_PULLED");
    for (const bad of ["../x", "svc/Upper", "svc/a;rm", "svc/a,", "other/a"]) expect(write(bad), bad).not.toContain("NOT_PULLED");
    expect(write("svc/local-aws")).toContain("AGENTX_TEST_SERVICES_REGISTRY=");
  });
  it("never writes a version it did not read as a version", () => {
    expect(parseBootFacts(facts({ version: "25.0.5; echo hi" }).value)).toMatchObject({ dockerVersion: "0" });
  });
  it("is written after the walls, for a named environment, and the pull records what it did", () => {
    const main = fn("stage2_main");
    expect(main.indexOf("install_run_walls_unit")).toBeLessThan(main.indexOf("write_test_services_boot_facts"));
    const pull = fn("pull_catalog_images");
    for (const needle of ["PREPULL_RESULT=ok", "PREPULL_RESULT=failed", "PREPULL_LOGGED_OUT=true", "PREPULL_COUNT=$count"]) expect(pull, needle).toContain(needle);
  });
});
