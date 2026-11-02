// SH25: the prepare invocation's saved environment field: its schema, the feature a worker lists for it, and the options the worker builds from it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREPARE_SAVED_ENV_FEATURE, PrepareSavedEnvSchema, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, savedEnvRepositoryName } from "../../packages/contracts/src/index.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { savedEnvOptionsOf } from "../../packages/worker/src/saved-env/use.js";

afterEach(() => vi.restoreAllMocks());
const repository = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "payments" });
const secret = ["login", "-", "p".repeat(30)].join("");
const payload = { use: { repository, digest: `sha256:${"d".repeat(64)}`, testEnvRevision: 4, environmentKey: "a".repeat(64), auth: { registry: "111122223333.dkr.ecr.us-west-2.amazonaws.com", repository, username: "AWS", password: secret, expiresAt: "2026-11-02T13:00:00.000Z" } }, taskTestEnvRevision: 4 };

describe("the saved environment field", () => {
  it("is strict: a tag, another registry, a login for another repository, an extra field and a missing pin are refused", () => {
    expect(PrepareSavedEnvSchema.safeParse(payload).success).toBe(true);
    const other = savedEnvRepositoryName({ env: "test", orgId: "org-2", projectId: "payments" });
    for (const bad of [
      { ...payload, use: { ...payload.use, digest: "latest" } },
      { ...payload, use: { ...payload.use, auth: { ...payload.use.auth, registry: "evil.example.com" } } },
      { ...payload, use: { ...payload.use, auth: { ...payload.use.auth, repository: other } } },
      { ...payload, extra: 1 },
      { use: payload.use },
      { ...payload, taskTestEnvRevision: 0 },
    ]) expect(PrepareSavedEnvSchema.safeParse(bad).success).toBe(false);
  });

  it("rides on a prepare invocation, and only a prepare invocation's strict payload takes it", () => {
    const base = { protocolVersion: 1, kind: "prepare", operationId: "7c0f4b9e-1111-4222-8333-444455556666", workspaceId: "7c0f4b9e-1111-4222-8333-444455557777", fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64) };
    const project = { name: "payments", revision: 1, repositories: [{ name: "svc", url: "https://github.com/acme/svc.git", path: "svc", defaultBranch: "main", credentialRef: "svc-read" }], setup: [], readiness: [], orchestratorInstructions: "x" };
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { project, repositoryGrant: "g", savedEnv: payload } }).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { project, repositoryGrant: "g", savedEnv: { ...payload, junk: true } } }).success).toBe(false);
  });

  it("is a feature the schema knows and this worker lists", () => {
    expect(PREPARE_SAVED_ENV_FEATURE).toBe("prepare.savedEnv.v1");
    expect(WORKER_INVOCATION_FEATURES).toContain(PREPARE_SAVED_ENV_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES).toContain(PREPARE_SAVED_ENV_FEATURE);
  });

  it("the worker builds its options from it, and a fallback is a log line with the digest and the step and no credential", () => {
    const docker = { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const options = savedEnvOptionsOf(PrepareSavedEnvSchema.parse(payload), docker);
    expect(options).toMatchObject({ taskTestEnvRevision: 4, use: payload.use, docker });
    options.onFallback?.("pull");
    const line = String(log.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({ component: "worker", event: "saved-env.fallback", digest: payload.use.digest, step: "pull" });
    expect(line).not.toContain(secret);
  });
});
