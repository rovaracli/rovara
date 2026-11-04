import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createSessionStepsHandler, pingWorker, type SessionStepsDependencies } from "../../packages/broker/src/aws/session-steps.js";
import { ec2WorkerBootScript } from "../../packages/contracts/src/session.js";

const bootScript = readFileSync(new URL("../../packages/worker/ec2/boot.sh", import.meta.url), "utf8");
// Task 10: the legacy deployment boots with today's single-file script; a named environment boots stage 1 and reads stage 2 from its worker image.
const legacyBootScript = readFileSync(new URL("../../packages/worker/ec2/boot-legacy.sh", import.meta.url), "utf8");
const stage2Sha256 = "5c".repeat(32);
const workspaceId = randomUUID();

function setup(ping: SessionStepsDependencies["ping"] = async () => ({ status: "Healthy" }), overrides: Partial<SessionStepsDependencies> = {}, settings: (base: Awaited<ReturnType<SessionStepsDependencies["workerSettings"]>>) => Awaited<ReturnType<SessionStepsDependencies["workerSettings"]>> = (base) => base) {
  const sessions = {
    markVolume: vi.fn(async () => undefined),
    markInstance: vi.fn(async () => undefined),
    markReady: vi.fn(async () => ({ requeued: ["r"] })),
    markFailed: vi.fn(async () => ({ failed: [] })),
    markDeleted: vi.fn(async () => undefined),
  };
  const pingSpy = vi.fn(ping);
  const handler = createSessionStepsHandler({
    sessions,
    workerSettings: async () => settings({
      workerImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production@sha256:${"a".repeat(64)}`,
      modelProvider: "amazon-bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      promptCacheRetention: "long",
      openRouterSecretArn: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/openrouter-AbCdEf",
      openRouterProviders: "anthropic,amazon-bedrock",
      anthropicSecretArn: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/anthropic-AbCdEf",
      openaiSecretArn: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/openai-AbCdEf",
    }),
    // Full length, as KMS returns a P-256 public key, so the user data size check is realistic.
    invokePublicKey: async () => `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"A".repeat(88)}`,
    bootScript: (variant) => (variant === "legacy" ? legacyBootScript : bootScript),
    controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com",
    logGroupName: "/agentx/production/worker",
    ping: pingSpy,
    ...overrides,
  });
  return { handler, sessions, ping: pingSpy };
}

describe("session steps", () => {
  it("renders the boot script as base64 gzip user data for one generation's volume (#229)", async () => {
    const { handler } = setup();
    const result = await handler({ action: "launchConfiguration", workspaceId, generation: 2, volumeId: "vol-0123456789abcdef0", expectNewVolume: false }) as { userData: string };
    // RunInstances takes UserData as base64, once; EC2 hands cloud-init the gzip, which it decompresses.
    const raw = Buffer.from(result.userData, "base64");
    expect([...raw.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    expect(raw.length).toBeLessThan(16_384);
    const userData = gunzipSync(raw).toString("utf8");
    expect(userData.startsWith("#!/bin/bash\n")).toBe(true);
    expect(userData).toContain(`export AGENTX_WORKSPACE_ID='${workspaceId}'`);
    expect(userData).toContain("export AGENTX_SESSION_GENERATION='2'");
    expect(userData).toContain("export AGENTX_EXPECT_NEW_VOLUME='false'");
    expect(userData).toContain("export AGENTX_MODEL_ID='us.anthropic.claude-sonnet-4-6'");
    expect(userData).toContain("export AGENTX_LOG_GROUP='/agentx/production/worker'");
    expect(userData).toContain('main "$@"');
    expect(userData).toBe(ec2WorkerBootScript({
      workspaceId,
      generation: 2,
      volumeId: "vol-0123456789abcdef0",
      expectNewVolume: false,
      workerImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production@sha256:${"a".repeat(64)}`,
      invokePublicKey: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"A".repeat(88)}`,
      controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com",
      modelProvider: "amazon-bedrock",
      modelId: "us.anthropic.claude-sonnet-4-6",
      promptCacheRetention: "long",
      openRouterSecretArn: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/openrouter-AbCdEf",
      openRouterProviders: "anthropic,amazon-bedrock",
      anthropicSecretArn: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/anthropic-AbCdEf",
      openaiSecretArn: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/openai-AbCdEf",
      logGroupName: "/agentx/production/worker",
    }, legacyBootScript));
    expect(userData).toContain("export AGENTX_ANTHROPIC_SECRET_ARN='arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/anthropic-AbCdEf'");
    expect(userData).toContain("export AGENTX_OPENAI_SECRET_ARN='arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/production/openai-AbCdEf'");
  });

  // Task 14: a named environment's workers call models through the proxy and hold no provider secret reference.
  describe("with a model proxy", () => {
    const proxyUrl = "http://internal-agentx-staging-proxy-123456.us-east-1.elb.amazonaws.com:4000";
    const launch = (handler: ReturnType<typeof setup>["handler"]) => handler({ action: "launchConfiguration", workspaceId, generation: 1, volumeId: "vol-0123456789abcdef0", expectNewVolume: true }) as Promise<{ userData: string }>;
    // What a named environment's SSM holds: no provider secret ARNs, and the proxy's URL when it is published.
    const named = (modelProxyUrl?: string, bootStage2Sha256: string | null = stage2Sha256) => ({ workerImage, modelProvider, modelId, promptCacheRetention }: Parameters<Parameters<typeof setup>[2] & {}>[0]) =>
      ({ workerImage, modelProvider, modelId, promptCacheRetention, ...(modelProxyUrl === undefined ? {} : { modelProxyUrl }), ...(bootStage2Sha256 === null ? {} : { bootStage2Sha256 }) });

    it("puts AGENTX_MODEL_PROXY_URL in the user data and no secret ARN", async () => {
      const { handler } = setup(undefined, { modelProxyRequired: true }, named(proxyUrl));
      const userData = gunzipSync(Buffer.from((await launch(handler)).userData, "base64")).toString("utf8");
      expect(userData).toContain(`export AGENTX_MODEL_PROXY_URL='${proxyUrl}'`);
      expect(userData).not.toMatch(/^export \w*_SECRET_ARN=/m);
    });

    // Task 25 Part B fix: the launcher switches on this, not on whether a proxy URL happens to be present.
    it("says explicitly that this is a named environment, and the legacy launch says nothing", async () => {
      const { handler } = setup(undefined, { modelProxyRequired: true }, named(proxyUrl));
      expect(gunzipSync(Buffer.from((await launch(handler)).userData, "base64")).toString("utf8")).toContain("export AGENTX_ENVIRONMENT_KIND='named'");
      const legacy = setup();
      expect(gunzipSync(Buffer.from((await launch(legacy.handler)).userData, "base64")).toString("utf8")).not.toContain("export AGENTX_ENVIRONMENT_KIND=");
    });

    it("tells the boot to pre-pull (AGENTX_TEST_SERVICES) only when test services are on in a named environment", async () => {
      const text = async (overrides: Parameters<typeof setup>[1]) => gunzipSync(Buffer.from((await launch(setup(undefined, overrides, named(proxyUrl)).handler)).userData, "base64")).toString("utf8");
      expect(await text({ modelProxyRequired: true, testServices: true })).toContain("export AGENTX_TEST_SERVICES='1'");
      expect(await text({ modelProxyRequired: true, testServices: false })).not.toContain("AGENTX_TEST_SERVICES");
      expect(await text({ modelProxyRequired: true })).not.toContain("AGENTX_TEST_SERVICES");
      // The legacy launch never says it, whatever the switch.
      expect(gunzipSync(Buffer.from((await launch(setup(undefined, { testServices: true }).handler)).userData, "base64")).toString("utf8")).not.toContain("AGENTX_TEST_SERVICES");
    });

    it("refuses to launch a worker without the proxy URL when the environment requires one, naming the missing setting", async () => {
      const { handler } = setup(undefined, { modelProxyRequired: true }, named());
      await expect(launch(handler)).rejects.toThrow(/model proxy URL.*missing/i);
    });

    // Task 10: stage 2 of the boot ships in the worker image; the hash that checks it is the setting that travels with the image.
    it("boots a named environment from boot.sh with the stage 2 hash it read beside the worker image", async () => {
      const { handler } = setup(undefined, { modelProxyRequired: true }, named(proxyUrl));
      const userData = gunzipSync(Buffer.from((await launch(handler)).userData, "base64")).toString("utf8");
      expect(userData).toContain(`export AGENTX_BOOT_STAGE2_SHA256='${stage2Sha256}'`);
      expect(userData).toContain("run_stage2");
      expect(userData).not.toContain("<<'LAUNCHER'");
      expect(userData).toBe(ec2WorkerBootScript({
        workspaceId, generation: 1, volumeId: "vol-0123456789abcdef0", expectNewVolume: true,
        workerImage: `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production@sha256:${"a".repeat(64)}`,
        invokePublicKey: `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"A".repeat(88)}`,
        controlPlaneUrl: "https://abc.execute-api.us-east-1.amazonaws.com", modelProvider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6",
        promptCacheRetention: "long", modelProxyUrl: proxyUrl, environmentKind: "named", bootStage2Sha256: stage2Sha256, logGroupName: "/agentx/production/worker",
      }, bootScript));
    });

    it("refuses a named launch with no stage 2 hash, saying to upgrade", async () => {
      const { handler } = setup(undefined, { modelProxyRequired: true }, named(proxyUrl, null));
      const error = await launch(handler).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      expect((error as Error).message).toBe("RUNTIME_UNAVAILABLE: this control plane has no boot hash for its worker image; run agentx upgrade");
    });

    it("boots the legacy deployment from boot-legacy.sh, whose hash is boot.sh's at the branch base, with no stage 2 hash", async () => {
      const seen: string[] = [];
      const { handler } = setup(undefined, { bootScript: (variant) => { seen.push(variant); return variant === "legacy" ? legacyBootScript : bootScript; } });
      const userData = gunzipSync(Buffer.from((await launch(handler)).userData, "base64")).toString("utf8");
      expect(seen).toEqual(["legacy"]);
      expect(userData).not.toContain("AGENTX_BOOT_STAGE2_SHA256");
      expect(userData).not.toContain("run_stage2");
      // The script after the exports is boot-legacy.sh without its shebang line, exactly.
      expect(userData.endsWith(`\n${legacyBootScript.replace(/^#!.*\n/, "")}`)).toBe(true);
      expect(createHash("sha256").update(legacyBootScript).digest("hex")).toBe("a731533fe3cd7bca59455befabed6d9f1747022b005a3a1db4e8bf8f5c4c19e1");
    });

    it("hands a named launch the named script", async () => {
      const seen: string[] = [];
      const { handler } = setup(undefined, { modelProxyRequired: true, bootScript: (variant) => { seen.push(variant); return bootScript; } }, named(proxyUrl));
      await launch(handler);
      expect(seen).toEqual(["named"]);
    });

    it("launches without a proxy when none is required (legacy)", async () => {
      const { handler } = setup();
      expect(gunzipSync(Buffer.from((await launch(handler)).userData, "base64")).toString("utf8")).not.toContain("export AGENTX_MODEL_PROXY_URL=");
    });
  });

  it("boots the worker with EXECUTOR_IMAGE when the release has set an executor image, and without it otherwise", async () => {
    const executorImage = `111122223333.dkr.ecr.us-east-1.amazonaws.com/agentx-worker-production-executor@sha256:${"e".repeat(64)}`;
    const launch = async (extra: { executorImage?: string }) => {
      const { handler } = setup(undefined, {}, (base) => ({ ...base, ...extra }));
      const result = await handler({ action: "launchConfiguration", workspaceId, generation: 2, volumeId: "vol-0123456789abcdef0", expectNewVolume: false }) as { userData: string };
      return gunzipSync(Buffer.from(result.userData, "base64")).toString("utf8");
    };
    expect(await launch({ executorImage })).toContain(`export EXECUTOR_IMAGE='${executorImage}'`);
    expect(await launch({})).not.toContain("export EXECUTOR_IMAGE=");
  });

  it("records the volume and instance, and marks the session ready, failed or deleted", async () => {
    const { handler, sessions } = setup();
    await handler({ action: "recordVolume", workspaceId, generation: 1, volumeId: "vol-0123456789abcdef0" });
    await handler({ action: "recordInstance", workspaceId, generation: 1, instanceId: "i-0123456789abcdef0", privateIp: "10.42.128.10" });
    expect(await handler({ action: "markReady", workspaceId, generation: 1 })).toEqual({ requeued: ["r"] });
    await handler({ action: "markFailed", workspaceId, generation: 1, error: "boom" });
    await handler({ action: "markDeleted", workspaceId });
    expect(sessions.markVolume).toHaveBeenCalledWith(workspaceId, 1, "vol-0123456789abcdef0");
    expect(sessions.markInstance).toHaveBeenCalledWith(workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10", undefined);
    expect(sessions.markFailed).toHaveBeenCalledWith(workspaceId, 1, "boom");
    expect(sessions.markDeleted).toHaveBeenCalledWith(workspaceId);
  });

  it("passes the features the probe heard on to the session when it marks it ready (LR-1), and records none when the step carries none", async () => {
    const { handler, sessions } = setup();
    await handler({ action: "markReady", workspaceId, generation: 1, workerFeatures: ["task.ownerRedirect.v1"] });
    expect(sessions.markReady).toHaveBeenLastCalledWith(workspaceId, 1, ["task.ownerRedirect.v1"]);
    await handler({ action: "markReady", workspaceId, generation: 1, workerFeatures: [] });
    expect(sessions.markReady).toHaveBeenLastCalledWith(workspaceId, 1, []);
    // A step from a machine that predates the field still parses; it records an unknown list.
    await handler({ action: "markReady", workspaceId, generation: 1 });
    expect(sessions.markReady).toHaveBeenLastCalledWith(workspaceId, 1, undefined);
    await expect(handler({ action: "markReady", workspaceId, generation: 1, workerFeatures: [""] })).rejects.toThrow();
    await expect(handler({ action: "markReady", workspaceId, generation: 1, workerFeatures: ["x".repeat(101)] })).rejects.toThrow();
    await expect(handler({ action: "markReady", workspaceId, generation: 1, workerFeatures: "task.ownerRedirect.v1" })).rejects.toThrow();
  });

  it("records the instance type a named environment's provisioner reports, and refuses one that is not an instance type", async () => {
    const { handler, sessions } = setup();
    await handler({ action: "recordInstance", workspaceId, generation: 1, instanceId: "i-0123456789abcdef0", privateIp: "10.42.128.10", instanceType: "m7g.large" });
    expect(sessions.markInstance).toHaveBeenCalledWith(workspaceId, 1, "i-0123456789abcdef0", "10.42.128.10", "m7g.large");
    await expect(handler({ action: "recordInstance", workspaceId, generation: 1, instanceId: "i-0123456789abcdef0", privateIp: "10.42.128.10", instanceType: "not a type" })).rejects.toThrow();
  });

  const pingCases: ReadonlyArray<[string, SessionStepsDependencies["ping"], { healthy: boolean; status: string; features: string[] }]> = [
    ["Healthy", async () => ({ status: "Healthy" }), { healthy: true, status: "Healthy", features: [] }],
    ["HealthyBusy", async () => ({ status: "HealthyBusy" }), { healthy: true, status: "HealthyBusy", features: [] }],
    ["Healthy, listing features", async () => ({ status: "Healthy", features: ["task.ownerRedirect.v1", "task.liveSteer.v1"] }), { healthy: true, status: "Healthy", features: ["task.ownerRedirect.v1", "task.liveSteer.v1"] }],
    ["unreachable", async () => { throw new Error("connect ECONNREFUSED"); }, { healthy: false, status: "Unreachable", features: [] }],
    ["no status", async () => undefined, { healthy: false, status: "Unreachable", features: [] }],
    ["an empty answer", async () => ({}), { healthy: false, status: "Unreachable", features: [] }],
  ];
  it.each(pingCases)("probes the worker's /ping on its private address: %s", async (_name, ping, expected) => {
    const { handler, ping: spy } = setup(ping);
    expect(await handler({ action: "probePing", privateIp: "10.42.128.10" })).toEqual(expected);
    expect(spy).toHaveBeenCalledWith("http://10.42.128.10:8080/ping");
  });

  // #211: a failed boot answers /ping with its reason, so the probe fails the provisioning at once
  // (ProbePing's Catch goes to Cleanup) instead of waiting out the 10 minute /ping window.
  it("fails the probe at once with the reason a failed boot reports", async () => {
    const { handler } = setup(async () => ({ status: "BootFailed", reason: "could not install Docker: package download failed after 5 tries" }));
    const probe = handler({ action: "probePing", privateIp: "10.42.128.10" });
    await expect(probe).rejects.toThrow("could not install Docker: package download failed after 5 tries");
    await expect(probe).rejects.toMatchObject({ name: "WorkerBootFailed", stack: "WorkerBootFailed: could not install Docker: package download failed after 5 tries" });
  });

  it("keeps a reported boot failure reason to one short line of plain text", async () => {
    const { handler } = setup(async () => ({ status: "BootFailed", reason: `bad\u0000\nline\t${"x".repeat(1_000)}` }));
    const error: Error = await handler({ action: "probePing", privateIp: "10.42.128.10" }).then(() => new Error("the probe did not fail"), (failure: unknown) => failure as Error);
    expect(error).toMatchObject({ name: "WorkerBootFailed" });
    expect(error.message.startsWith("bad line x")).toBe(true);
    expect(error.message).toHaveLength(300);
    const { handler: unexplained } = setup(async () => ({ status: "BootFailed", reason: 42 as unknown as string }));
    await expect(unexplained({ action: "probePing", privateIp: "10.42.128.10" })).rejects.toThrow("the boot script failed without a reason");
  });

  it("names a reported boot failure in plain words when the session is marked failed", async () => {
    const { handler, sessions } = setup();
    // What ProbePing's Catch hands MarkFailed: the Lambda error's type, then its payload as JSON.
    const cause = JSON.stringify({ errorType: "WorkerBootFailed", errorMessage: "could not install Docker: package download failed after 5 tries", trace: ["WorkerBootFailed: could not install Docker", "    at probe (session-steps.js:1:1)"] });
    await handler({ action: "markFailed", workspaceId, generation: 1, error: `WorkerBootFailed: ${cause}` });
    expect(sessions.markFailed).toHaveBeenCalledWith(workspaceId, 1, "worker boot failed: could not install Docker: package download failed after 5 tries");
    // Any other failure text is passed on as it is.
    await handler({ action: "markFailed", workspaceId, generation: 1, error: "worker did not answer /ping within 10 minutes" });
    expect(sessions.markFailed).toHaveBeenLastCalledWith(workspaceId, 1, "worker did not answer /ping within 10 minutes");
    // MarkFailed cuts its input at 4000 characters, which can leave the payload incomplete.
    await handler({ action: "markFailed", workspaceId, generation: 1, error: `WorkerBootFailed: ${cause.slice(0, 120)}` });
    expect(sessions.markFailed).toHaveBeenLastCalledWith(workspaceId, 1, "worker boot failed: could not install Docker: package download failed after 5 tries");
    await handler({ action: "markFailed", workspaceId, generation: 1, error: "WorkerBootFailed: not json" });
    expect(sessions.markFailed).toHaveBeenLastCalledWith(workspaceId, 1, "worker boot failed (no reason recorded)");
  });

  it("reads the worker's status, and a failed boot's reason, from /ping whatever the HTTP status", async () => {
    const answers: Record<string, [number, string]> = {
      "/healthy": [200, JSON.stringify({ status: "Healthy" })],
      "/failed": [503, JSON.stringify({ status: "BootFailed", reason: "could not download the worker image after 5 tries" })],
      "/featured": [200, JSON.stringify({ status: "Healthy", invocationFeatures: ["task.ownerRedirect.v1", "task.ownerRedirect.v1", 4, "", "x".repeat(101), "task.liveSteer.v1"] })],
      "/garbage": [500, "<html>"],
    };
    const server = createServer((request, response) => {
      const [status, body] = answers[request.url ?? ""] ?? [404, ""];
      response.writeHead(status, { "content-type": "application/json" }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await pingWorker(`${base}/healthy`)).toEqual({ status: "Healthy" });
      expect(await pingWorker(`${base}/failed`)).toEqual({ status: "BootFailed", reason: "could not download the worker image after 5 tries" });
      // The features it lists, as the session records them (LR-1): strings only, once each, within the bound.
      expect(await pingWorker(`${base}/featured`)).toEqual({ status: "Healthy", features: ["task.ownerRedirect.v1", "task.liveSteer.v1"] });
      await expect(pingWorker(`${base}/garbage`)).rejects.toThrow();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses unknown steps and anything but a private IPv4 address to probe", async () => {
    const { handler, ping } = setup();
    await expect(handler({ action: "launchInstance" })).rejects.toThrow();
    await expect(handler({ action: "probePing", privateIp: "example.com" })).rejects.toThrow();
    await expect(handler({ action: "markReady", workspaceId, generation: 1, extra: true })).rejects.toThrow();
    expect(ping).not.toHaveBeenCalled();
  });
});
