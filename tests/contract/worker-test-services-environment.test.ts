// Test services slice 1: what the EC2 worker is told for the service runner (boot-stage2.sh) and what its image carries. Run against fake curl, install, mount and mountpoint tools.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

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
  const run = (list: string | undefined, options: { pullExit?: number; loginExit?: number; present?: boolean } = {}) => {
    const directory = mkdtempSync(join(tmpdir(), "tsl-pull-"));
    if (list !== undefined) writeFileSync(join(directory, "prepull.json"), list);
    const path = tools(directory, {
      timeout: 'while [[ "$1" == --* ]]; do shift; done; shift; exec "$@"',
      aws: `echo "aws $@" >> "${directory}/calls"; echo token`,
      docker: [
        `echo "docker $@" >> "${directory}/calls"`,
        'case "$1" in',
        `  run) [ -f "${directory}/prepull.json" ] && cat "${directory}/prepull.json" || exit 1 ;;`,
        `  login) cat >/dev/null; exit ${String(options.loginExit ?? 0)} ;;`,
        `  image) exit ${options.present === true ? "0" : "1"} ;;`,
        `  pull) exit ${String(options.pullExit ?? 0)} ;;`,
        'esac',
      ].join("\n"),
    });
    const program = `log() { echo "$*" >> "${directory}/log"; }\n${fn("pull_catalog_images")}\npull_catalog_images us-west-2`;
    const ran = spawnSync("/bin/bash", ["-c", program], { encoding: "utf8", env: { PATH: path, AGENTX_WORKER_IMAGE: IMAGE, AGENTX_LOG_GROUP: "/agentx/staging/worker", TMPDIR: directory } });
    const read = (name: string): string => { try { return readFileSync(join(directory, name), "utf8"); } catch { return ""; } };
    return { status: ran.status, calls: read("calls"), log: read("log") };
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
    }
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
