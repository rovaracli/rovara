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
  const run = (options: { image?: string; logGroup?: string; imds?: "ok" | "none" | "garbled" } = {}) => {
    const directory = mkdtempSync(join(tmpdir(), "tsl-env-"));
    const envFile = join(directory, "worker.env");
    writeFileSync(envFile, "AGENTX_RUNTIME=ec2\n");
    const imds = options.imds ?? "ok";
    const path = tools(directory, {
      curl: imds === "none" ? "exit 22"
        : `echo "$@" >> "${directory}/curl.calls"; case "$*" in *"-X PUT"*) echo imds-token ;; *) echo '${imds === "garbled" ? '{"accountId": "not-an-account"}' : '{\n  "accountId" : "944937319445",\n  "region" : "us-west-2"\n}'}' ;; esac`,
    });
    const program = `readonly WORKER_ENV_FILE=${envFile}\n${fn("instance_account_id")}\n${fn("write_test_services_environment")}\nwrite_test_services_environment`;
    const ran = spawnSync("/bin/bash", ["-c", program], { encoding: "utf8", env: { PATH: path, AGENTX_WORKER_IMAGE: options.image ?? IMAGE, AGENTX_LOG_GROUP: options.logGroup ?? "/agentx/staging/worker" } });
    let calls = "";
    try { calls = readFileSync(join(directory, "curl.calls"), "utf8"); } catch { /* none */ }
    return { status: ran.status, written: readFileSync(envFile, "utf8"), calls };
  };

  it("writes exactly these names: the registry from the worker image, the environment from the launch's log group, the run directory, the catalog directory and the account from the instance identity", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.written).toBe([
      "AGENTX_RUNTIME=ec2",
      "AGENTX_TEST_SERVICES_REGISTRY=944937319445.dkr.ecr.us-west-2.amazonaws.com",
      "AGENTX_TEST_SERVICES_ENV=staging",
      "AGENTX_TEST_SERVICES_RUN_DIR=/run/agentx-test-services",
      "AGENTX_TEST_SERVICES_CATALOG_DIR=/opt/agentx/packages/worker/service-catalog",
      "AGENTX_TEST_SERVICES_ACCOUNT_ID=944937319445",
      "",
    ].join("\n"));
    // IMDSv2: a token first, then the identity document with it
    expect(r.calls).toContain("-X PUT");
    expect(r.calls).toContain("X-aws-ec2-metadata-token: imds-token");
    expect(r.calls).toContain("/latest/dynamic/instance-identity/document");
    // nothing is a secret, and no trusted key is in the settings
    expect(r.written).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD/u);
  });
  it("leaves the account out when the identity cannot be read (the staging-only catalog key is then not trusted), but still writes the rest", () => {
    for (const imds of ["none", "garbled"] as const) {
      const r = run({ imds });
      expect(r.status, imds).toBe(0);
      expect(r.written, imds).not.toContain("AGENTX_TEST_SERVICES_ACCOUNT_ID");
      expect(r.written, imds).toContain("AGENTX_TEST_SERVICES_ENV=staging");
    }
  });
  it("writes nothing when the image or the log group is not in the expected form (the settings are derived, never guessed)", () => {
    for (const options of [{ image: `docker.io/library/node@sha256:${"a".repeat(64)}` }, { logGroup: "/agentx/production/../worker" }, { logGroup: "/aws/other" }, { logGroup: "/agentx/Staging/worker" }]) {
      const r = run(options);
      expect(r.status, JSON.stringify(options)).not.toBe(0);
      expect(r.written, JSON.stringify(options)).toBe("AGENTX_RUNTIME=ec2\n");
    }
  });
  it("is written for a named environment only, and a failure is not fatal to the boot", () => {
    const main = fn("stage2_main");
    expect(main).toMatch(/if \[\[ \$\{AGENTX_ENVIRONMENT_KIND:-\} == named \]\]; then\n\s+write_test_services_environment \|\| log /u);
    expect(main.indexOf("write_worker_environment")).toBeLessThan(main.indexOf("write_test_services_environment"));
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
    expect(launcher).toContain('if [[ "$test_services_run_dir" == true ]]; then args+=(--volume "$TEST_SERVICES_RUN_DIR:$TEST_SERVICES_RUN_DIR"); fi');
    expect(launcher).toContain("log 'test services run directory unavailable (not fatal)'");
    expect(launcher).toContain("readonly TEST_SERVICES_RUN_DIR=/run/agentx-test-services");
  });
  it("makes the run directory only for a named environment, after the metadata block", () => {
    expect(launcher.indexOf("block_imds ||")).toBeLessThan(launcher.indexOf("prepare_test_services_run_dir; then"));
    expect(launcher).toMatch(/if named_environment; then\n\s+if prepare_test_services_run_dir/u);
  });
  it("ships catalog.json and, once built, catalog.sig.json beside the pre-pull list (no key file: the trusted keys are compiled in)", () => {
    expect(dockerfile).toContain("COPY environments/service-catalog/catalog*.json ./packages/worker/service-catalog/");
    expect(dockerfile.indexOf("COPY --from=build /opt/agentx/packages/worker ./packages/worker")).toBeLessThan(dockerfile.indexOf("COPY environments/service-catalog/catalog*.json"));
    expect(dockerfile).not.toMatch(/service-catalog[^\n]*\.pem|trusted[-_]keys/iu);
  });
});
