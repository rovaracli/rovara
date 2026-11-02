// SH25 review M1: the pull login exchange. The worker names nothing; the broker decides from the grant, the running preparation and the digest it recorded with the operation.
import { describe, expect, it } from "vitest";
import { exchangeSavedEnvLoginCore, type SavedEnvLoginContext } from "../../packages/broker/src/test-env/saved-env-login.js";

const REGISTRY = "111122223333.dkr.ecr.us-west-2.amazonaws.com";
const REPOSITORY = "rovara-env/test/oaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PASSWORD = ["login", "-", "p".repeat(30)].join("");
const DIGEST = `sha256:${"d".repeat(64)}`;
const login = { registry: REGISTRY, repository: REPOSITORY, username: "AWS" as const, password: PASSWORD, expiresAt: "2026-11-02T13:00:00.000Z" };

function context(over: Partial<SavedEnvLoginContext> & { operation?: Partial<Awaited<ReturnType<SavedEnvLoginContext["readOperation"]>>> } = {}) {
  const asked: unknown[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const base: SavedEnvLoginContext = {
    enabled: true,
    inspectGrant: () => ({ workspaceId: "ws", operationId: "op" }),
    readOperation: async () => ({ kind: "prepare", status: "RUNNING", savedEnvDigest: DIGEST, orgId: "org-1", projectName: "payments", workspace: { status: "PREPARING", activeOperationId: "op" }, ...over.operation }),
    login: async (input) => { asked.push(input); return login; },
    log: (event) => { logged.push(event); },
  };
  const rest: Partial<SavedEnvLoginContext> = { ...over };
  delete (rest as { operation?: unknown }).operation;
  return { context: { ...base, ...rest }, asked, logged };
}
const call = (c: SavedEnvLoginContext, over: { grant?: string | undefined; body?: unknown; workspaceId?: string; operationId?: string } = {}) =>
  exchangeSavedEnvLoginCore(c, { grant: "grant" in over ? over.grant : "g", workspaceId: over.workspaceId ?? "ws", operationId: over.operationId ?? "op", body: "body" in over ? over.body : {} });

describe("the saved environment login exchange", () => {
  it("gives the login for the digest recorded WITH THE OPERATION, for the workspace's own org and project, and logs the digest and expiry but never the login", async () => {
    const { context: c, asked, logged } = context();
    expect(await call(c)).toEqual({ login });
    expect(asked).toEqual([{ orgId: "org-1", projectName: "payments", digest: DIGEST }]);
    expect(JSON.stringify(logged)).toContain(DIGEST);
    expect(JSON.stringify(logged)).not.toContain(PASSWORD);
  });

  it("is refused when the switch is off, there is no grant, or the grant is for another workspace or operation", async () => {
    await expect(call(context({ enabled: false }).context)).rejects.toThrow();
    await expect(call(context().context, { grant: undefined })).rejects.toThrow();
    await expect(call(context().context, { workspaceId: "ws-2" })).rejects.toThrow();
    await expect(call(context().context, { operationId: "op-2" })).rejects.toThrow();
    await expect(call(context({ inspectGrant: () => { throw new Error("forbidden"); } }).context)).rejects.toThrow();
  });

  it("is given to a running PREPARE only: not to a task, a finished or queued-out preparation, or one that is no longer the workspace's active operation", async () => {
    for (const operation of [{ kind: "task" }, { status: "SUCCEEDED" }, { status: "FAILED" }, { workspace: { status: "READY", activeOperationId: "op" } }, { workspace: { status: "PREPARING", activeOperationId: "other" } }]) {
      const { context: c, asked } = context({ operation });
      await expect(call(c)).rejects.toThrow();
      expect(asked).toEqual([]);
    }
  });

  it("an operation that was told no image gets no login, and the request cannot name an image or a project: any field in the body is refused", async () => {
    const { context: c, asked } = context({ operation: { savedEnvDigest: undefined } });
    await expect(call(c)).rejects.toThrow();
    for (const body of [{ digest: DIGEST }, { orgId: "org-2" }, [], null, "x"]) await expect(call(context().context, { body })).rejects.toThrow();
    expect(asked).toEqual([]);
  });

  it("no login from the registry (the image went stale, the project moved on) is a refusal, and a login for another shape is not passed on", async () => {
    await expect(call(context({ login: async () => undefined }).context)).rejects.toThrow();
    await expect(call(context({ login: async () => ({ ...login, registry: "evil.example.com" }) }).context)).rejects.toThrow();
  });
});
