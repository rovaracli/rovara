// Meta repo lane A, fix round 1 (I3 and I4 on the broker side): a task never writes to the project's meta repository from a builder session, and the broker pins the commit it
// sends a worker. Driven through the real broker handler with a project that has a code repository (demo) and a separate meta repository (service-meta).
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { codeRepositoriesOf, StoredProjectDefinitionSchema } from "../../packages/contracts/src/index.js";
import { issueRepositoryGrant } from "../../packages/broker/src/aws/broker/admin-and-helpers.js";
import { createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall } from "../support/slack-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });

const HEAD = "c".repeat(40);
const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000009`;
const user = "U0123456789";
const metaRepository = { name: "service-meta", url: "https://github.com/example/service-meta.git", path: "repo/service-meta", defaultBranch: "main", credentialRef: "github-app", role: "meta" };

async function harness(options: { head?: () => Promise<string> } = {}) {
  const getDefaultBranchHead = vi.fn(options.head ?? (async () => HEAD));
  const { handler, db, brokerInput } = createBroker({ extra: { githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), getDefaultBranchHead } } });
  await registerSlackProject(handler, { extraRepositories: [metaRepository] });
  return { handler, db, brokerInput, getDefaultBranchHead };
}

describe("a project with a separate meta repository", () => {
  it("prepares a workspace with the meta request, pinning the head the broker read and keeping it on the operation", async () => {
    const h = await harness();
    const workspace = await ensureWorkspace(h.handler, thread, user);
    expect(workspace.status, JSON.stringify(workspace.body)).toBe(200);
    const operationId = workspace.body.operationId as string;
    expect(h.getDefaultBranchHead).toHaveBeenCalledWith("https://github.com/example/service-meta.git", "main", { system: "private-install" });
    const outbox = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as { payload: { meta?: { commit: string; repository: { name: string } }; project: { repositories: Array<{ name: string }> } } };
    expect(outbox.payload.meta).toMatchObject({ commit: HEAD, repository: { name: "service-meta" } });
    // The worker's project does not list the meta repository as code.
    expect(outbox.payload.project.repositories.map((entry) => entry.name)).toEqual(["demo"]);
    expect(h.db.get(`WORKSPACE#${workspace.body.workspaceId as string}`, `OPERATION#${operationId}`)).toMatchObject({ kind: "prepare", knowledgeCommit: HEAD });
  });

  it("refuses to prepare, and writes nothing, when the meta repo's head cannot be read", async () => {
    const h = await harness({ head: async () => { throw new Error("503 secret-detail"); } });
    const workspace = await ensureWorkspace(h.handler, thread, user);
    expect(workspace.status).toBe(503);
    expect(JSON.stringify(workspace.body)).not.toContain("secret-detail");
    expect(h.db.find((item) => item.entityType === "OUTBOX")).toEqual([]);
    expect(h.db.find((item) => item.entityType === "WORKSPACE")).toEqual([]);
  });

  it("opens a pull request in a code repository, and refuses one naming the meta repository: no operation, no outbox item, no push grant", async () => {
    const h = await harness();
    const workspace = await ensureWorkspace(h.handler, thread, user);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(h.db, workspaceId);
    const outboxBefore = h.db.find((item) => item.entityType === "OUTBOX").length;
    const refused = await serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/pull-requests`, { requestId: randomUUID(), repository: "service-meta", title: "Edit the rules" });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("repository is not registered for this project");
    expect(h.db.find((item) => item.entityType === "OUTBOX").length).toBe(outboxBefore);
    const accepted = await serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/pull-requests`, { requestId: randomUUID(), repository: "demo", title: "A change" });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
  });
});

describe("repository grants", () => {
  const definition = StoredProjectDefinitionSchema.parse({
    name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "x",
    repositories: [{ name: "api", url: "https://github.com/acme/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" }, { ...metaRepository, url: "https://github.com/acme/service-meta.git" }],
  });
  const project = { definition, runtimeBinding: {} } as never;
  const issued: Array<{ repositories: Array<{ repositoryUrl: string; access: string }> }> = [];
  const grants = new RepositoryGrantService(Buffer.alloc(32, 4), async () => ({ token: "unused" }));
  const dependencies = { repositoryGrants: { issue: (input: { repositories: Array<{ repositoryUrl: string; access: string }> }) => { issued.push(input); return grants.issue(input as never); } } } as never;

  it("lets a worker clone the meta repository but never push to it", () => {
    issued.length = 0;
    issueRepositoryGrant(dependencies, project, "owner", "w", "o", "clone");
    issueRepositoryGrant(dependencies, project, "owner", "w", "o", "push");
    issueRepositoryGrant(dependencies, project, "owner", "w", "o", "push", "service-meta");
    expect(issued[0]!.repositories).toEqual([{ credentialRef: "github-app", repositoryUrl: "https://github.com/acme/api.git", access: "clone", hostKind: "github" }, { credentialRef: "github-app", repositoryUrl: "https://github.com/acme/service-meta.git", access: "clone", hostKind: "github" }]);
    expect(issued[1]!.repositories).toEqual([{ credentialRef: "github-app", repositoryUrl: "https://github.com/acme/api.git", access: "push", hostKind: "github" }]);
    expect(issued[2]!.repositories).toEqual([]);
  });

  it("still pushes to a repository that is both meta and code", () => {
    issued.length = 0;
    const self = { definition: StoredProjectDefinitionSchema.parse({ ...definition, repositories: [{ ...metaRepository, alsoCode: true }] }), runtimeBinding: {} } as never;
    issueRepositoryGrant(dependencies, self, "owner", "w", "o", "push");
    expect(issued[0]!.repositories).toHaveLength(1);
    expect(codeRepositoriesOf(StoredProjectDefinitionSchema.parse({ ...definition, repositories: [{ ...metaRepository, alsoCode: true }] }))).toHaveLength(1);
  });
});
