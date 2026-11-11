// Enterprise foundations P5c: the working-branch review is bound to the GitHub installation and repository id a project pinned. It reads those pins from the repository's HOST record (task P7;
// the old top-level fields read as before), and a repository whose record names another code host is refused, never read through GitHub by its address.
import { describe, expect, it, vi } from "vitest";
import { AgentXError, orgProjectCatalogKey, projectMetaKey, projectRevisionKey } from "@rovara-code/contracts";
import { StoredProjectDefinitionSchema } from "@agentx/cloud-contracts";
import { developerOrgKey, orgMemberKey, orgMetaKey } from "@agentx/cloud-contracts";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { githubPinsOf, tryGithubPinsOf } from "../../packages/broker/src/org/project-working-branch-host.js";
import { readProjectWorkingBranchContext } from "../../packages/broker/src/org/project-working-branch-context.js";
import { readProjectWorkingBranchPage } from "../../packages/broker/src/org/project-working-branch-list.js";
import { readProjectWorkingBranchPreview } from "../../packages/broker/src/org/project-working-branch.js";
import { createWorkingBranchProvider } from "../../packages/broker/src/org/project-working-branch-provider.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", actor = "a".repeat(64), name = "payments", commit = "c".repeat(40);
type Repo = Record<string, unknown>;

function fixture(repositories: Repo[]) {
  const db = new FakeDynamoDb();
  db.set({ ...orgMetaKey(A), orgId: A, name: "Company", plan: "team" });
  db.set({ ...orgMemberKey(A, actor), orgId: A, developerId: actor, role: "owner" });
  db.set({ ...developerOrgKey(actor), orgId: A, role: "owner" });
  const definition = StoredProjectDefinitionSchema.parse({ name, revision: 1, repositories, setup: [], readiness: [], orchestratorInstructions: "Synthetic private fixture" });
  db.set({ ...orgProjectCatalogKey(A, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1 });
  db.set({ ...projectRevisionKey(A, name, 1), entityType: "PROJECT", definition });
  db.set({ ...projectMetaKey(A, name), entityType: "PROJECT_META", name, status: "active", archiveRevision: 2 });
  const caller: DeveloperCaller = { orgId: A, developerId: actor, orgRole: "owner", name: "Person", sessionId: "fixture", amr: "cloud" };
  const check = vi.fn<(orgId: string, repository: unknown) => Promise<{ installationId: number; repositoryId: number }>>(() => Promise.resolve({ installationId: 11, repositoryId: 22 }));
  const resolve = vi.fn(async (_orgId: string, _repository: unknown, branch: string) => ({ installationId: 11, repositoryId: 22, fullName: "acme/payments", branch, commit }));
  const list = vi.fn(async (_orgId: string, _repository: unknown, page: number) => ({ branches: ["main"], page, mayHaveMore: false, omittedUnsupported: false }));
  const deps = { documentClient: db, tableName: "state", now: () => Date.parse("2026-10-31T10:00:00Z"), checkRepository: check, resolveBranch: resolve, listBranches: list };
  const body = { expectedOrgId: A, expectedRevision: 2, expectedProjectRevision: 1, repository: "web" };
  const code = async (run: () => Promise<unknown>) => run().then(() => "OK", (error: unknown) => (error instanceof AgentXError ? error.code : "OTHER"));
  return { deps, caller, body, check, resolve, list, code };
}

const web = { name: "web", url: "https://github.com/acme/payments.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" };
const legacy = { ...web, installationId: 11, githubRepositoryId: 22 };
const hostOnly = { ...web, host: { kind: "github", installationId: 11, repositoryId: 22 } };
const elsewhere = { ...web, host: { kind: "fake", ref: "r1" } };

describe("the pins of a repository, from its host record", () => {
  it("reads the old top-level pins and the host's pins as the same thing, and nothing for an unpinned GitHub record", () => {
    expect(githubPinsOf(legacy)).toEqual({ installationId: 11, githubRepositoryId: 22 });
    expect(githubPinsOf(hostOnly)).toEqual({ installationId: 11, githubRepositoryId: 22 });
    expect(githubPinsOf({ ...web, installationId: undefined })).toEqual({ installationId: undefined, githubRepositoryId: undefined });
  });

  it("tryGithubPinsOf answers undefined for another host (the save check reads that as a mismatch, not as an invalid request) and the pins for GitHub", () => {
    expect(tryGithubPinsOf(elsewhere)).toBeUndefined();
    expect(tryGithubPinsOf(hostOnly)).toEqual({ installationId: 11, githubRepositoryId: 22 });
  });

  it("refuses a repository on another code host with a fixed sentence that does not echo the kind", () => {
    expect(() => githubPinsOf(elsewhere)).toThrow(/code host does not support working branch review/u);
    expect(() => githubPinsOf({ ...web, host: { kind: "examplehost" } })).not.toThrow(/examplehost/u);
  });
});

describe("the working-branch review routes by the repository's record", () => {
  it("lists branches of a GitHub repository that only the host record pins, with the host's pins bound and checked", async () => {
    const f = fixture([hostOnly]);
    const page = await readProjectWorkingBranchPage(f.deps, f.caller, name, f.body);
    expect(page).toMatchObject({ repository: "web", repositoryFullName: "acme/payments", branches: ["main"] });
    expect(f.list).toHaveBeenCalledTimes(1);
    // A host whose pins differ from what the connection check answers is refused, as for the top-level pins.
    f.check.mockResolvedValue({ installationId: 12, repositoryId: 22 });
    expect(await f.code(() => readProjectWorkingBranchPage(f.deps, f.caller, name, f.body))).toBe("RUNTIME_UNAVAILABLE");
  });

  it("refuses to list, preview or offer a repository on another code host, before any provider is asked", async () => {
    const f = fixture([elsewhere]);
    expect(await f.code(() => readProjectWorkingBranchPage(f.deps, f.caller, name, f.body))).toBe("CONFIG_INVALID");
    expect(await f.code(() => readProjectWorkingBranchPreview(f.deps, f.caller, name, { ...f.body, branch: "main" }))).toBe("CONFIG_INVALID");
    expect(f.check).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
    // The context offers only what the review can do: the other host's repository is left out and the answer says some were.
    const context = await readProjectWorkingBranchContext(f.deps, f.caller, name, { expectedOrgId: A });
    expect(context).toMatchObject({ repositories: [], omittedUnsupported: true });
  });

  it("offers a repository the host record pins, next to one on another host that it leaves out", async () => {
    const f = fixture([hostOnly, { ...elsewhere, name: "api", path: "repo/api" }]);
    expect(await readProjectWorkingBranchContext(f.deps, f.caller, name, { expectedOrgId: A })).toMatchObject({ repositories: [{ name: "web", fullName: "acme/payments" }], omittedUnsupported: true });
  });

  it("the provider seam asks GitHub only for a GitHub record, with that record's pins", async () => {
    const calls: unknown[][] = [];
    const provider = createWorkingBranchProvider({
      readWorkingBranchRepository: async (...args: unknown[]) => { calls.push(args); return { installationId: 11, repositoryId: 22 }; },
      readWorkingBranch: async () => undefined,
    });
    await provider.checkRepository(A, hostOnly);
    expect(calls).toEqual([[web.url, { installationId: 11, repositoryId: 22 }, { orgId: A }]]);
    await expect(provider.checkRepository(A, elsewhere as never)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(calls).toHaveLength(1);
  });
});
