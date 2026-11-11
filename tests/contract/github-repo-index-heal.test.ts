// Plan 4 Task 22 Step 0: the index GitHub's events find a project by (`GITHUB_REPO#<id>`) is healed. A project registered before Task 21 has no rows, so its GitHub triggers never fired.
// Two things keep it right: a repeat of a revision that is already stored writes the rows the project's LATEST revision holds (and only those), and an older revision registered
// after a newer one never changes the rows the newer one holds.
import { describe, expect, it } from "vitest";
import { githubRepoProjectKey } from "@agentx/cloud-contracts";
import { orgProjectCatalogKey, projectRevisionKey } from "@rovara-code/contracts";
import type { OrgId } from "@rovara-code/contracts";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const registerProjectFor = async (...args: unknown[]) =>
  (await import("../../packages/broker/src/aws/broker.js") as unknown as { registerProjectFor: (...input: unknown[]) => Promise<{ duplicate: boolean }> }).registerProjectFor(...args);

const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
} as const;
const OTHER_ORG: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const actor = { orgId: TEST_ORG, ownerKey: MAYA.developerId };
const repository = (name: string, pin?: { installationId: number; githubRepositoryId: number }) => ({
  name, url: `https://github.com/acme/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: "github-app", ...(pin ?? {}),
});
const definition = (name: string, revision: number, repositories: ReturnType<typeof repository>[]) => ({ name, revision, repositories, setup: [], readiness: [], orchestratorInstructions: "Delegate work." });
const register = (h: Awaited<ReturnType<typeof createDeveloperTaskBroker>>, value: ReturnType<typeof definition>) =>
  registerProjectFor(h.brokerInput, actor, { definition: value, runtimeBinding: BINDING }, { creatorMembership: "none" });
const rows = (db: FakeDynamoDb) => db.find((item) => String(item.pk).startsWith("GITHUB_REPO#")).map((item) => `${String(item.pk)}|${String(item.sk)}`).sort();
const WEB = repository("web", { installationId: 55, githubRepositoryId: 101 });
const API = repository("api", { installationId: 55, githubRepositoryId: 202 });
const UNPINNED = repository("docs");
const row = (id: number, project = "web", org: OrgId = TEST_ORG) => `${githubRepoProjectKey(id, org, project).pk}|${org}#${project}`;

describe("registering a project keeps the GitHub index of its latest revision", () => {
  it("heals the missing rows when a revision that is already stored is registered again, for the repositories the latest revision pins and no others", async () => {
    const h = await createDeveloperTaskBroker({ register: false });
    await register(h, definition("web", 1, [WEB]));
    // A project that predates the index: the revision and its catalog entry are there, the rows are not.
    h.db.delete(githubRepoProjectKey(101, TEST_ORG, "web"));
    expect(rows(h.db)).toEqual([]);
    const again = await register(h, definition("web", 1, [WEB]));
    expect(again.duplicate).toBe(true);
    expect(rows(h.db)).toEqual([row(101)]);
    expect(h.db.get(githubRepoProjectKey(101, TEST_ORG, "web"))).toMatchObject({ entityType: "GITHUB_REPO_PROJECT", orgId: TEST_ORG, project: "web", installationId: 55, githubRepositoryId: 101 });
  });

  it("writes the rows of the LATEST revision when an older one is repeated, none for an unpinned repository, and none under another org or project", async () => {
    const h = await createDeveloperTaskBroker({ register: false });
    await register(h, definition("web", 1, [WEB]));
    await register(h, definition("web", 2, [API, UNPINNED]));
    expect(rows(h.db)).toEqual([row(202)]);
    h.db.delete(githubRepoProjectKey(202, TEST_ORG, "web"));
    h.db.set({ ...githubRepoProjectKey(303, OTHER_ORG, "web"), entityType: "GITHUB_REPO_PROJECT", orgId: OTHER_ORG, project: "web", installationId: 9, githubRepositoryId: 303 });
    await register(h, definition("web", 1, [WEB]));
    // Revision 1 pins repository 101, which revision 2 no longer holds: only 202 comes back.
    expect(rows(h.db)).toEqual([row(202), row(303, "web", OTHER_ORG)].sort());
  });

  it("changes nothing when the repeat finds every row in place", async () => {
    const h = await createDeveloperTaskBroker({ register: false });
    await register(h, definition("web", 1, [WEB]));
    const before = rows(h.db);
    await register(h, definition("web", 1, [WEB]));
    expect(rows(h.db)).toEqual(before);
  });

  it("leaves the rows alone when an older revision is registered after a newer one: only the latest revision may change them", async () => {
    const h = await createDeveloperTaskBroker({ register: false });
    // Revision 1 of the project is stored late, after revision 3 (which holds the API repository) is already the latest.
    await register(h, definition("web", 3, [API]));
    expect(rows(h.db)).toEqual([row(202)]);
    await register(h, definition("web", 1, [WEB]));
    expect(rows(h.db)).toEqual([row(202)]);
    expect(h.db.get(orgProjectCatalogKey(TEST_ORG, "web"))).toMatchObject({ latestRevision: 3 });
    expect(h.db.get(projectRevisionKey(TEST_ORG, "web", 1))).toBeDefined();
  });
});
