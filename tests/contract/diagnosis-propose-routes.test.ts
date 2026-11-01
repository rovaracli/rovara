// Live interaction F4 on the real broker: "Propose this change" goes through the project's ordinary settings routes, as the person. The merge method is the code-settings save; the dev container's path
// is the project settings save. A stale `from`, a citation that does not hold, a person who is not a maintainer and the switch off each leave the settings exactly as they were.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ErrorRefSchema, githubInstallationKey, orgGithubInstallationKey, orgProjectCatalogKey, projectMemberKey, projectMetaKey, projectRevisionKey, type DiagnosisProposal, type DiagnosisRecord, type GithubInstallationRecord,
} from "../../packages/contracts/src/index.js";
import { admitDiagnosis, settleDiagnosis } from "../../packages/broker/src/diagnosis/store.js";
import { OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const NAME = "web";
const COMMIT = "a".repeat(40);
const KIT: Developer = { developerId: "4".repeat(64), name: "Kit Alvarez", provider: "oidc", sessionId: "s-kit" };
const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
} as const;
const ENV = process.env["LIVE_FIX_ENABLED"];
beforeEach(() => { process.env["LIVE_FIX_ENABLED"] = "1"; });
afterEach(() => { if (ENV === undefined) delete process.env["LIVE_FIX_ENABLED"]; else process.env["LIVE_FIX_ENABLED"] = ENV; });

function seedInstallation(db: FakeDynamoDb): void {
  const record: GithubInstallationRecord = {
    installationId: 7, orgId: TEST_ORG, accountLogin: "acme", accountId: 907, accountType: "Organization", repositorySelection: "all", installedByGithubUserId: "gh-1",
    boundByDeveloperId: OMAR.developerId, status: "active", boundAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  };
  db.set({ ...orgGithubInstallationKey(TEST_ORG, 7), entityType: "GITHUB_INSTALLATION", ...record });
  db.set({ ...githubInstallationKey(7), entityType: "GITHUB_INSTALLATION", ...record });
}

async function setup(files: Record<string, string> = { ".devcontainer/web/devcontainer.json": '{ "image": "node:22" }' }) {
  const getFileAtCommit = vi.fn(async (_url: string, path: string) => files[path]);
  const h = await createDeveloperTaskBroker({
    register: false,
    brokerExtra: {
      cloud: true, agents: {}, cloudProjects: { runtimeBinding: BINDING, githubCredentialRef: "github-app" },
      githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), getRepositoryIdentity: vi.fn(), getFileAtCommit, getDefaultBranchHead: vi.fn(async () => "c".repeat(40)) },
      checkRepositoryAccess: vi.fn(async () => undefined),
    },
  });
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  seedInstallation(h.db);
  h.db.set({
    ...projectRevisionKey(TEST_ORG, NAME, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: {
      name: NAME, revision: 1,
      repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      devcontainer: { repository: "web", configPath: ".devcontainer/devcontainer.json" },
      setup: [{ cwd: "repo/web", executable: "make", args: ["setup"], timeoutSeconds: 900 }], readiness: [{ cwd: "repo/web", executable: "make", args: ["test"], timeoutSeconds: 1800 }], orchestratorInstructions: "Delegate work.",
    },
  });
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, NAME), entityType: "PROJECT_CATALOG", name: NAME, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  h.db.set({
    ...projectMetaKey(TEST_ORG, NAME), entityType: "PROJECT_META", name: NAME, status: "active", description: "The site", createdAt: "2026-10-02T00:00:00.000Z", createdBy: OMAR.developerId,
    setupCheck: { revision: 0, startedAt: "2026-10-01T00:00:00.000Z", workspaceId: randomUUID() },
  });
  for (const who of [OMAR, KIT]) {
    await h.orgOf(who);
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  }
  seedMembership(h.db, KIT.developerId, { orgId: TEST_ORG, role: "member" });
  h.db.set({ ...projectMemberKey(TEST_ORG, KIT.developerId, NAME), entityType: "MEMBERSHIP", ownerKey: KIT.developerId, projectName: NAME, grantId: randomUUID(), role: "developer", projectRole: "contributor" });

  const store = { documentClient: h.db, tableName: "state", now: Date.now };
  /** A ready diagnosis of the project's outdated setup check, holding `proposals` after its explanation (stored as the broker stores a read answer). */
  const diagnosis = async (proposals: DiagnosisProposal[]) => {
    const shown = await h.dev(OMAR, "GET", `/v1/app/projects/${NAME}`);
    const errorRef = ErrorRefSchema.parse((shown.body.setup as { errorRef: unknown }).errorRef);
    const admitted = await admitDiagnosis(store, { orgId: TEST_ORG, developerId: OMAR.developerId, requestId: randomUUID(), tier: "light", errorRef, project: NAME, context: "x" });
    const record: DiagnosisRecord = {
      diagnosisId: admitted.diagnosisId, errorRef, tier: "light", proposals: [{ kind: "explain", text: "The settings are wrong." }, ...proposals], droppedProposals: 0, needsCode: false,
      model: "m", costCents: 0, createdAt: new Date().toISOString(), ttl: Math.floor(Date.now() / 1000) + 86_400,
    };
    await settleDiagnosis(store, TEST_ORG, { diagnosisId: admitted.diagnosisId, tier: "light", errorRef }, { state: "ready", record });
    return admitted.diagnosisId;
  };
  const propose = (who: Developer, id: string, index = 1) => h.dev(who, "POST", `/v1/app/diagnoses/${id}/propose`, { requestId: randomUUID(), index });
  const codeSettings = async () => (await h.dev(OMAR, "GET", `/v1/app/projects/${NAME}/code-settings`)).body.settings as { mergeMethod: string; revision: number };
  const definition = () => (h.db.find((item) => item.entityType === "PROJECT" && item.pk === projectRevisionKey(TEST_ORG, NAME, 1).pk)
    .sort((a, b) => Number((a.definition as { revision: number }).revision) - Number((b.definition as { revision: number }).revision)).at(-1)!.definition) as { revision: number; devcontainer?: { repository: string; configPath?: string } };
  return { ...h, diagnosis, propose, codeSettings, definition, getFileAtCommit };
}

const mergeChange = (extra: Record<string, unknown> = {}): DiagnosisProposal => ({ kind: "settings_change", target: "code_settings", path: "mergeMethod", from: "squash", to: "merge", citations: ['doc:merge-method "merge commit"'], ...extra });
const deviceChange = (extra: Record<string, unknown> = {}): DiagnosisProposal => ({ kind: "settings_change", target: "setup_item", path: "devcontainer.configPath", from: ".devcontainer/devcontainer.json", to: ".devcontainer/web/devcontainer.json", citations: [`repo:web:.devcontainer/web/devcontainer.json@${COMMIT} "node:22"`], ...extra });

describe("Propose this change, on the real broker", () => {
  it("the merge method: a maintainer presses it and the project's code settings change, once, through the ordinary save", async () => {
    const t = await setup();
    const id = await t.diagnosis([mergeChange()]);
    expect(await t.codeSettings()).toMatchObject({ mergeMethod: "squash" });
    const reply = await t.propose(OMAR, id);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toMatchObject({ diagnosisId: id, index: 1, target: "code_settings", outcome: "applied" });
    expect(await t.codeSettings()).toMatchObject({ mergeMethod: "merge", revision: 1 });
    // The diagnosis changed nothing about itself.
    expect((await t.dev(OMAR, "GET", `/v1/app/diagnoses/${id}`)).body).toMatchObject({ state: "ready" });
  });

  it("is refused when the setting moved since the diagnosis: the stale check", async () => {
    const t = await setup();
    const id = await t.diagnosis([mergeChange()]);
    const put = await t.dev(OMAR, "PUT", `/v1/app/projects/${NAME}/code-settings`, { requestId: randomUUID(), expectedRevision: 0, mergeMethod: "merge" });
    expect(put.status).toBe(200);
    const reply = await t.propose(OMAR, id);
    expect(reply.status).toBe(400);
    expect((reply.body.error as { message: string }).message).toContain("out of date");
    expect(await t.codeSettings()).toMatchObject({ mergeMethod: "merge", revision: 1 });
  });

  it("the dev container's path: the project settings save makes the next revision with the new path, and a citation that does not hold changes nothing", async () => {
    const t = await setup();
    const id = await t.diagnosis([deviceChange()]);
    const reply = await t.propose(OMAR, id);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(t.definition()).toMatchObject({ revision: 2, devcontainer: { repository: "web", configPath: ".devcontainer/web/devcontainer.json" } });
    expect(t.getFileAtCommit).toHaveBeenCalledWith("https://github.com/acme/web.git", ".devcontainer/web/devcontainer.json", COMMIT, expect.anything(), expect.anything());

    const wrong = await setup({ ".devcontainer/web/devcontainer.json": "{ }" });
    const wrongId = await wrong.diagnosis([deviceChange()]);
    const refused = await wrong.propose(OMAR, wrongId);
    expect(refused.status).toBe(400);
    expect((refused.body.error as { message: string }).message).toContain("did not find it");
    expect(wrong.definition()).toMatchObject({ revision: 1, devcontainer: { configPath: ".devcontainer/devcontainer.json" } });
    const missing = await setup({});
    const missingId = await missing.diagnosis([deviceChange()]);
    expect((await missing.propose(OMAR, missingId)).status).toBe(400);
    expect(missing.definition().revision).toBe(1);
  });

  it("a person who is not a maintainer cannot see the diagnosis of a project error or propose its change; the switch off is NOT_FOUND", async () => {
    const t = await setup();
    const id = await t.diagnosis([mergeChange()]);
    const kit = await t.propose(KIT, id);
    expect(kit.status).toBe(404);
    expect(await t.codeSettings()).toMatchObject({ mergeMethod: "squash", revision: 0 });
    delete process.env["LIVE_FIX_ENABLED"];
    expect((await t.propose(OMAR, id)).status).toBe(404);
    expect(await t.codeSettings()).toMatchObject({ mergeMethod: "squash", revision: 0 });
  });
});
