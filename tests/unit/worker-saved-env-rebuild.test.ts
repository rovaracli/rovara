// Saved project images (SV wiring): the worker's half of a rebuild job. The build is given exactly the job's commits and the worker's OWN view of what else runs here and what is secret; its commands go through the
// sandbox target; the push login and the result use the job's lease and the preparation's grant; a result is always posted.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrepareSavedEnvBuildSchema, TestEnvironmentBodySchema, savedEnvRepositoryName, testEnvDigest, type SavedEnvBuildResult, type WorkerInvocation } from "../../packages/contracts/src/index.js";
import { forbiddenValuesOf, liveTaskSandboxes, runSavedEnvRebuild, workspaceBuildSandbox, type SavedEnvRebuildDependencies } from "../../packages/worker/src/saved-env/rebuild.js";
import type { SavedEnvBuildInput, SavedEnvBuildPorts } from "../../packages/worker/src/saved-env/build.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

afterEach(() => { vi.restoreAllMocks(); });
const COMMIT = "d".repeat(40);
const LEASE = ["lease", "x".repeat(30)].join("-");
const GRANT = ["grant", "g".repeat(30)].join("-");
const CAPABILITY = ["cap", "c".repeat(40)].join("-");
const REPOSITORY = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "proj-1" });
const cmd = (executable: string, args: string[]) => ({ cwd: "svc", executable, args, timeoutSeconds: 600 });
const environment = TestEnvironmentBodySchema.parse({
  tier: "sandbox", repos: [{ repositoryId: "svc", setupCommands: [cmd("npm", ["ci"])], checks: [{ id: "unit", label: "Unit tests", command: cmd("npm", ["test"]), kind: "test" }] }],
  roundBudgetMin: 30, selection: { method: "full", alwaysRun: [], fullSuiteOn: [] }, nightly: { enabled: false, cronUtc: "0 6 * * *", branch: "main" },
  services: [], data: { seeds: [], generator: "faker_seeded", seed: 1 }, accounts: [], prodDeny: { accountIds: [], hosts: [], arnPrefixes: [] }, capture: { screenshots: "failed", video: false, traces: false },
});
const job = (over: Record<string, unknown> = {}) => PrepareSavedEnvBuildSchema.parse({
  jobId: "job-1", leaseToken: LEASE, reason: "no_image", approved: { revision: 1, digest: testEnvDigest(environment) }, repository: REPOSITORY, environment, commits: { svc: COMMIT },
  detectorGlobs: ["**/x"], secretNames: ["NPM_TOKEN"], baseImageDigest: `sha256:${"b".repeat(64)}`, ...over,
});
const invocation = (build: ReturnType<typeof job> | null = job()): Extract<WorkerInvocation, { kind: "prepare" }> => ({
  protocolVersion: 1, kind: "prepare", operationId: "22222222-2222-4222-8222-222222222222", workspaceId: "11111111-1111-4111-8111-111111111111", fence: 1, projectRevision: 1, callbackCapability: CAPABILITY,
  payload: { project: { name: "demo", revision: 1, repositories: [{ name: "svc", url: "https://github.com/acme/svc.git", path: "svc", defaultBranch: "main", credentialRef: "svc-read" }], setup: [], readiness: [], orchestratorInstructions: "x" }, repositoryGrant: GRANT, readOnly: true, pins: [{ repository: "svc", commit: COMMIT }], ...(build === null ? {} : { savedEnvBuild: build }) },
} as never);
const docker = (stdout = ""): DockerCli => ({ run: async () => ({ exitCode: 0, stdout, stderr: "" }) });

interface Posted { url: string; headers: Record<string, string>; body: Record<string, unknown> }
function bench(over: Partial<SavedEnvRebuildDependencies> & { build?: SavedEnvRebuildDependencies["build"]; answers?: Array<Response | Error>; during?: (ports: SavedEnvBuildPorts) => Promise<void> } = {}) {
  const { during, answers: _answers, ...rest } = over;
  void _answers;
  const posted: Posted[] = [];
  const answers = over.answers ?? [];
  const calls: { input?: SavedEnvBuildInput; ports?: SavedEnvBuildPorts } = {};
  const fetchImplementation = (async (url: string, init: RequestInit) => {
    posted.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) as Record<string, unknown> });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response("{}", { status: 200 });
  }) as typeof fetch;
  const ok: SavedEnvBuildResult = { ok: false, reason: "not_proved" };
  const sandbox = { start: vi.fn(async () => undefined), dispose: vi.fn(async () => undefined), runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false })), bashOperations: vi.fn() };
  const deps: SavedEnvRebuildDependencies = {
    rootPath: "/mnt/workspace", controlPlaneUrl: "https://cp.example.test/", invocation: invocation(), manifest: { repositories: [{ name: "svc", path: "svc", defaultBranch: "main", resolvedCommit: COMMIT, resolvedAt: "x", completedAt: "x" }] },
    docker: docker(), otherOperations: async () => [], environment: { PATH: "/usr/bin" }, fetchImplementation, sandbox: () => sandbox as never, postAttempts: 3,
    build: async (input, ports) => { calls.input = input; calls.ports = ports; await during?.(ports); return ok; },
    ...rest,
  };
  return { deps, posted, calls, sandbox, fetchImplementation };
}

describe("the job", () => {
  it("gives the build the job's commits and environment, and the worker's own view of what else runs here and what is secret", async () => {
    const credentialProvider = vi.fn(async () => ({ token: "clone-token-value-0123" }));
    const { deps, calls } = bench({ otherOperations: async () => [{ id: "another-operation", rootPath: "/mnt/workspace" }], credentialProvider, environment: { PATH: "/usr/bin", MODEL_API_KEY: "model-key-value-4567" } });
    await runSavedEnvRebuild(deps);
    const input = calls.input!;
    expect(input).toMatchObject({
      repository: REPOSITORY, approved: { revision: 1, digest: testEnvDigest(environment) }, repositories: [{ repositoryId: "svc", directory: "svc", defaultBranch: "main", commit: COMMIT }],
      detectorGlobs: ["**/x"], secretNames: ["NPM_TOKEN"], baseImageDigest: `sha256:${"b".repeat(64)}`, notFrom: [{ id: "another-operation", rootPath: "/mnt/workspace" }],
    });
    expect(input.environment).toEqual(environment);
    // the forbidden values: the grant, the capability, the lease, the clone credential and the credential-shaped variables
    expect(new Set(input.forbiddenValues)).toEqual(new Set([GRANT, CAPABILITY, LEASE, "clone-token-value-0123", "model-key-value-4567"]));
  });

  it("takes notFrom from the worker's own registry, never from the payload: another running task sandbox is listed too", async () => {
    const { deps, calls } = bench({ docker: docker("agentx-task-abc\nagentx-task-def\n") });
    await runSavedEnvRebuild(deps);
    expect(calls.input!.notFrom.map((other) => other.id)).toEqual(["agentx-task-abc", "agentx-task-def"]);
    await expect(liveTaskSandboxes({ run: async () => ({ exitCode: 1, stdout: "", stderr: "" }) }, "/mnt/workspace", "")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("builds nothing when the clone is not at the job's commits, and says so", async () => {
    const build = vi.fn(async (): Promise<SavedEnvBuildResult> => ({ ok: false, reason: "not_proved" }));
    const { deps, posted } = bench({ build, manifest: { repositories: [{ name: "svc", path: "svc", defaultBranch: "main", resolvedCommit: "e".repeat(40), resolvedAt: "x", completedAt: "x" }] } });
    expect(await runSavedEnvRebuild(deps)).toEqual({ ok: false, reason: "not_default_branch", step: "commits" });
    expect(build).not.toHaveBeenCalled();
    expect(posted.at(-1)!.body.result).toEqual({ ok: false, reason: "not_default_branch", step: "commits" });
  });

  it("refuses a job with no lease token, which it could not report anything with", async () => {
    const { deps, posted } = bench({ invocation: invocation(job({ leaseToken: undefined })) });
    await expect(runSavedEnvRebuild(deps)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(posted).toEqual([]);
    await expect(runSavedEnvRebuild({ ...deps, invocation: invocation(null) })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("the broker calls", () => {
  const goodLogin = { registry: "111122223333.dkr.ecr.us-west-2.amazonaws.com", repository: REPOSITORY, username: "AWS", password: "p".repeat(30), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };

  it("asks for the push login with the preparation's grant and the job's lease, and hands the build a login only for the repository it asked for", async () => {
    const seen: unknown[] = [];
    const { deps, posted } = bench({ answers: [new Response(JSON.stringify({ login: goodLogin }), { status: 200 }), new Response(JSON.stringify({ login: { ...goodLogin, repository: savedEnvRepositoryName({ env: "test", orgId: "org-2", projectId: "proj-9" }) } }), { status: 200 })], during: async (ports) => { seen.push(await ports.pushSession({ repository: REPOSITORY })); seen.push(await ports.pushSession({ repository: REPOSITORY })); } });
    await runSavedEnvRebuild(deps);
    expect(seen).toEqual([goodLogin, undefined]);
    expect(posted[0]).toMatchObject({ url: "https://cp.example.test/v1/internal/workspaces/11111111-1111-4111-8111-111111111111/operations/22222222-2222-4222-8222-222222222222/saved-env-push-login", headers: { "x-agentx-repository-grant": GRANT } });
    expect(posted[0]!.body).toEqual({ jobId: "job-1", leaseToken: LEASE });
  });

  it("gets no login when the broker refuses or cannot be reached", async () => {
    const seen: unknown[] = [];
    const { deps } = bench({ answers: [new Response("no", { status: 403 }), new Error("down")], during: async (ports) => { seen.push(await ports.pushSession({ repository: REPOSITORY })); seen.push(await ports.pushSession({ repository: REPOSITORY })); } });
    await runSavedEnvRebuild(deps);
    expect(seen).toEqual([undefined, undefined]);
  });

  it("posts the result with the job's lease and the grant, whatever the result is, and retries a broker that does not answer", async () => {
    const { deps, posted } = bench({ answers: [new Error("down"), new Response("no", { status: 503 }), new Response("{}", { status: 200 })] });
    const result = await runSavedEnvRebuild(deps);
    expect(posted).toHaveLength(3);
    for (const call of posted) {
      expect(call.url).toMatch(/\/saved-env-result$/u);
      expect(call.headers).toMatchObject({ "x-agentx-repository-grant": GRANT });
      expect(call.body).toEqual({ jobId: "job-1", leaseToken: LEASE, result });
    }
  });

  it("gives up after its attempts, and a build that throws is reported as a failure with a fixed word", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { deps, posted } = bench({ answers: [new Error("a"), new Error("b"), new Error("c")], build: async () => { throw new Error(`boom ${LEASE}`); } });
    expect(await runSavedEnvRebuild(deps)).toEqual({ ok: false, reason: "build_failed", step: "unexpected" });
    expect(posted).toHaveLength(3);
    // the line names the job and the word, never the lease
    expect(String(log.mock.calls.at(-1)![0])).not.toContain(LEASE);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ event: "saved-env.rebuild", ok: false, reason: "build_failed", posted: false });
  });
});

describe("the sandbox", () => {
  it("is over the prepared workspace, not started until asked, runs project commands through the sandbox target, and stops without removing the workspace", async () => {
    const { deps, calls, sandbox } = bench();
    await runSavedEnvRebuild(deps);
    const fresh = await calls.ports!.makeFresh();
    expect(fresh).toMatchObject({ rootPath: "/mnt/workspace" });
    expect(fresh.hasStarted()).toBe(false);
    expect(sandbox.start).not.toHaveBeenCalled();
    await fresh.start();
    expect(fresh.hasStarted()).toBe(true);
    expect(sandbox.start).toHaveBeenCalledTimes(1);
    await fresh.ports.runCommand({ cwd: "svc", executable: "npm", args: ["ci"], timeoutSeconds: 60 }, new AbortController().signal);
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
    await fresh.stopProcesses();
    expect(sandbox.dispose).toHaveBeenCalledTimes(1);
  });

  it("cannot start an environment's services, and a dispose removes the sandbox and only the repositories' checkouts", async () => {
    const sandbox = { start: vi.fn(), dispose: vi.fn(async () => undefined), runCommand: vi.fn() };
    const fresh = workspaceBuildSandbox({ rootPath: "/nonexistent-root-for-test", operationId: "op", checkouts: ["svc"], sandbox: sandbox as never });
    await expect(fresh.ports.startMock({} as never, new AbortController().signal)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(fresh.ports.probePreprod({} as never, new AbortController().signal)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await fresh.dispose();
    expect(sandbox.dispose).toHaveBeenCalled();
  });
});

describe("forbidden values", () => {
  it("never includes a short value, and survives a clone credential that cannot be had", async () => {
    const values = await forbiddenValuesOf({ invocation: invocation(), environment: { PATH: "/usr/bin", AWS_ACCESS_KEY_ID: "short", SOME_TOKEN: "a-long-enough-token-value" }, credentialProvider: async () => { throw new Error("no"); } }, LEASE);
    expect(values).toContain("a-long-enough-token-value");
    expect(values).not.toContain("short");
    expect(values).toEqual(expect.arrayContaining([GRANT, CAPABILITY, LEASE]));
  });
});
