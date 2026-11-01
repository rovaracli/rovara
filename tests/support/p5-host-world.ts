// Enterprise foundations P5d/P5e: a broker's dependencies over a fake table, with GitHub (a stand-in provider that must never be asked about the fake or unknown repositories) and a registered fake
// code host. The project `demo` holds a GitHub repository, one on the fake host, one on a host this install has not registered, and a meta repository on each of GitHub and the fake host.
import { expect, vi } from "vitest";
import { editionPolicy } from "../../packages/contracts/src/index.js";
import type { rewriteDescriptionsOfTask } from "../../packages/broker/src/aws/broker/attribution-erasure.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { createPluginRegistry } from "../../packages/broker/src/plugins/registry.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { TEST_ORG } from "./orgs.js";
import { projectRow, pullRequestDetails, type TestRepository } from "./p5-world.js";

export const GITHUB_URL = "https://github.com/acme/web.git";
export const FAKE_URL = "https://git.example.test/acme/api";
export const MYSTERY_URL = "https://git.example.test/acme/mystery";
export const FAKE_META_URL = "https://git.example.test/acme/api-meta";
export const GITHUB_META_URL = "https://github.com/acme/web-meta";
export const TASK = "11111111-1111-4111-8111-111111111111";
export const WORKSPACE = "ws-1";
export const SCOPE = { system: "private-install" } as const;

export const REPOSITORIES: TestRepository[] = [
  { name: "web", url: GITHUB_URL },
  { name: "api", url: FAKE_URL, host: { kind: "fake", ref: "r1" } },
  { name: "mystery", url: MYSTERY_URL, host: { kind: "gitfarm" } },
  { name: "web-meta", url: GITHUB_META_URL, role: "meta" },
  { name: "api-meta", url: FAKE_META_URL, role: "meta", host: { kind: "fake", ref: "r2" } },
];

/** A broker's dependencies over a fake table: GitHub (a stand-in provider that must never be asked about the fake or unknown repositories) and a registered fake host. */
export function world(options: { repositories?: TestRepository[]; github?: Record<string, unknown> } = {}) {
  const db = new FakeDynamoDb();
  db.set(projectRow(options.repositories ?? REPOSITORIES));
  db.set({ ...taskKey(TASK), entityType: "DEVTASK", taskId: TASK, workspaceId: WORKSPACE, orgId: TEST_ORG, project: "demo", startingRevision: 1, ownerKey: "owner" });
  db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "META", entityType: "WORKSPACE", id: WORKSPACE, orgId: TEST_ORG, ownerKey: "owner", projectName: "demo", projectRevision: 1, status: "READY", fence: 1 });
  const model = new FakeHostModel({ url: FAKE_URL, id: "7", fullName: "acme/api" });
  const metaModel = new FakeHostModel({ url: FAKE_META_URL, id: "8", fullName: "acme/api-meta" });
  const fakeHost = new FakeCodeHost(model);
  const fakeMetaHost = new FakeCodeHost(metaModel);
  // One registered `fake` host per kind: the meta repository gets its own model by being served through a router that answers by the record's `ref`.
  const github = {
    getPullRequest: vi.fn(async (_url: string, number: number) => pullRequestDetails(number)), updatePullRequest: vi.fn(async (_url: string, number: number) => pullRequestDetails(number)),
    reconcilePullRequest: vi.fn(async () => ({ number: 9, url: "https://github.com/acme/web/pull/9", reconciled: false })),
    getFileAtCommit: vi.fn(async () => "file"), getPullRequestStatus: vi.fn(), getRepositoryPermission: vi.fn(async () => "write" as const),
    getDefaultBranchHead: vi.fn(async () => "a".repeat(40)), getCommitTree: vi.fn(async () => "b".repeat(40)), getBranchHead: vi.fn(async () => "c".repeat(40)),
    getPullRequestFeedback: vi.fn(), verifyWebhookRepository: vi.fn(async () => true), ...(options.github ?? {}),
  };
  const registry = createPluginRegistry({ codeHosts: [githubCodeHost(github as never, { credentialRef: "github-app" }), fakeHost], checkRunners: [], policy: editionPolicy("enterprise") });
  const dependencies = { documentClient: db, tableName: "state", environmentName: "test", githubPullRequests: github, codeHost: registry.codeHost };
  return { db, model, metaModel, fakeHost, fakeMetaHost, github, registry, dependencies: dependencies as never as Parameters<typeof rewriteDescriptionsOfTask>[0] };
}

export const refusal = (message: string): unknown => expect.objectContaining({ code: "CONFIG_INVALID", message: expect.stringContaining(message) as unknown });

