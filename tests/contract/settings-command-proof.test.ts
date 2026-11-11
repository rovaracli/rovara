// TE-4 (owner decision 2026-11-02): the project settings PUT does not write commands with no proof, whoever sends it.
//   A person in a browser saves at once; Rovara then checks exactly what was saved in the background (the TE-2/TE-3 candidate check, adopted as the project's own check), shows Proven or Unproven, tells the saver
//   when the check fails and lets a maintainer in a browser (signed in within ten minutes) go back to the last proved setup.
//   An API key's change to commands or the dev container is HELD: it is written only when its own check passes at the revision it was made against.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { developerOrgKey, githubInstallationKey, orgGithubInstallationKey, orgMemberKey, type GithubInstallationRecord } from "@agentx/cloud-contracts";
import { orgProjectCatalogKey, projectMemberKey, projectMetaKey, projectRevisionKey } from "@rovara-code/contracts";
import { type AppProjectDetail } from "@agentx/cloud-contracts";
import { createNotifierHandler, type NotifierDependencies } from "../../packages/broker/src/aws/developer-task-notifier.js";
import { noticesOf, type Notice } from "../../packages/broker/src/developer/notifications.js";
import { settingsProofKey } from "../../packages/broker/src/org/settings-proof.js";
import { APP_CSRF_HEADER, appCsrfTokenFor } from "../../packages/broker/src/developer/app-csrf.js";
import { DEV_ISSUER, MAYA, OMAR, createDeveloperTaskBroker, recordStream, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const NAME = "web";
const SETTINGS = `/v1/app/projects/${NAME}/settings`;
const PROJECT = `/v1/app/projects/${NAME}`;
const BINDING = {
  deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
  subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
} as const;
const command = (executable: string, args: string[], timeoutSeconds: number) => ({ cwd: "repo/web", executable, args, timeoutSeconds });
const OLD_SETUP = command("make", ["old-setup"], 900);
const OLD_TEST = command("make", ["old-test"], 1800);
const NEW_SETUP = command("npm", ["ci"], 900);
const NEW_TEST = command("npm", ["test"], 1800);

type Reply = { status: number; body: Record<string, unknown> };
type Candidate = { workspaceId: string; revision: number; digest: string; startedBy: string; setup: Array<Record<string, unknown>>; readiness: Array<Record<string, unknown>> };
type ProofItem = { proven?: { revision: number; provenAt: string; setup: unknown[]; readiness: unknown[] }; saved?: { status: string; reason?: string; noticeAt?: string; workspaceId?: string; slackUserId?: string }; held?: { status: string; workspaceId?: string; reason?: string; requestId: string }; lastUndo?: { requestId: string } };
const proofOf = (reply: Reply) => ((reply.body.project ?? reply.body) as AppProjectDetail).settingsProof!;
const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };

function seedInstallation(db: FakeDynamoDb): void {
  const record: GithubInstallationRecord = {
    installationId: 7, orgId: TEST_ORG, accountLogin: "acme", accountId: 907, accountType: "Organization", repositorySelection: "all", installedByGithubUserId: "gh-1",
    boundByDeveloperId: OMAR.developerId, status: "active", boundAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
  };
  db.set({ ...orgGithubInstallationKey(TEST_ORG, 7), entityType: "GITHUB_INSTALLATION", ...record });
  db.set({ ...githubInstallationKey(7), entityType: "GITHUB_INSTALLATION", ...record });
}

/** A cloud install with the project `web` at revision 1 (a setup and a test command) and Omar, an org owner, who saves in a browser and with a token. */
async function setup(options: { memberLimit?: number } = {}) {
  const audit = capturingAuditDeps();
  const getRepositoryIdentity = vi.fn(async (url: string) => {
    const match = /github\.com\/([^/]+)\/([^/.]+)/u.exec(url);
    return match === null ? undefined : { fullName: `${match[1]}/${match[2]}`, defaultBranch: "main", githubRepositoryId: 4242 };
  });
  const h = await createDeveloperTaskBroker({
    register: false, audit, ...(options.memberLimit === undefined ? {} : { memberLimit: options.memberLimit }),
    brokerExtra: {
      cloud: true, agents: {}, cloudProjects: { runtimeBinding: BINDING, githubCredentialRef: "github-app" },
      githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), getRepositoryIdentity, getFileAtCommit: vi.fn(), getDefaultBranchHead: vi.fn(async () => "c".repeat(40)) },
      checkRepositoryAccess: vi.fn(async () => undefined),
    },
  });
  const stream = recordStream(h.db);
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  seedInstallation(h.db);
  h.db.set({
    ...projectRevisionKey(TEST_ORG, NAME, 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
    definition: {
      name: NAME, revision: 1,
      repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [OLD_SETUP], readiness: [OLD_TEST], orchestratorInstructions: "Delegate work.",
    },
  });
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, NAME), entityType: "PROJECT_CATALOG", name: NAME, latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
  h.db.set({ ...projectMetaKey(TEST_ORG, NAME), entityType: "PROJECT_META", name: NAME, status: "active", description: "The site", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });

  const person = async (who: Developer, orgRole: "member" | "admin", grant?: "viewer" | "contributor" | "maintainer") => {
    await h.orgOf(who);
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }), firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role: orgRole });
    if (grant !== undefined) h.db.set({ ...projectMemberKey(TEST_ORG, who.developerId, NAME), entityType: "MEMBERSHIP", ownerKey: who.developerId, projectName: NAME, grantId: randomUUID(), role: grant === "viewer" ? "viewer" : "developer", projectRole: grant });
  };
  // A request the way the web app sends it: the session cookie, the origin and the CSRF header. `authAgoMs` is how long ago the person signed in.
  const sessions = new Map<string, string>();
  const browserSessionOf = (who: Developer, authAgoMs = 0): string => {
    const key = `${who.developerId}:${String(authAgoMs)}`;
    let id = sessions.get(key);
    if (id === undefined) {
      id = randomUUID();
      h.db.set({ pk: `SESSION#${id}`, sk: "META", sessionId: id, developerId: who.developerId, amr: who.provider, ...(who.slackUserId === undefined ? {} : { slackUserId: who.slackUserId }), startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800, reviewExpiresAt: Math.floor(Date.now() / 1000) + 3600, authTime: new Date(Date.now() - authAgoMs).toISOString() });
      sessions.set(key, id);
    }
    return id;
  };
  const web = async (who: Developer, method: string, path: string, body?: unknown, authAgoMs = 0): Promise<Reply> => {
    const id = browserSessionOf(who, authAgoMs);
    const response = await h.handler({
      rawPath: path.replace("/v1/app/", "/v1/web/"), rawQueryString: "", routeKey: "ANY /v1/web/{proxy+}",
      headers: { cookie: `__Host-agentx_review_session=${id}`, "sec-fetch-site": "same-origin", origin: new URL(DEV_ISSUER).origin, [APP_CSRF_HEADER]: appCsrfTokenFor(id) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), requestContext: { requestId: "r", http: { method } },
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  const key = (who: Developer, method: string, path: string, body?: unknown): Promise<Reply> => h.dev(who, method, path, body);

  const candidates = () => h.db.find((item) => item.entityType === "TEST_ENV_CANDIDATE_CHECK") as unknown as Candidate[];
  const prepareOf = (workspaceId: string) => String((h.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const workspaceStatus = (workspaceId: string) => (h.db.get(`WORKSPACE#${workspaceId}`, "META") as { status: string }).status;
  /** Plays the worker's report on a check's workspace. */
  const finishCheck = async (workspaceId: string, status: "SUCCEEDED" | "FAILED", error?: string) => { await h.finish(workspaceId, prepareOf(workspaceId), status, error === undefined ? {} : { error }); };
  const reportNewest = async (status: "SUCCEEDED" | "FAILED", error?: string): Promise<Candidate> => { const record = candidates().at(-1)!; await finishCheck(record.workspaceId, status, error); return record; };
  const definitions = () => h.db.find((item) => item.entityType === "PROJECT" && item.pk === projectRevisionKey(TEST_ORG, NAME, 1).pk)
    .map((item) => item.definition as { revision: number; setup: Array<Record<string, unknown>>; readiness: Array<Record<string, unknown>>; devcontainer?: { repository: string }; network?: { allowedDomains: string[] } })
    .sort((a, b) => a.revision - b.revision);
  const latest = () => definitions().at(-1)!;
  const meta = () => h.db.get(projectMetaKey(TEST_ORG, NAME)) as { description?: string; setupCheck?: { workspaceId: string; revision: number } };
  const proofItem = () => h.db.get(settingsProofKey(TEST_ORG, NAME).pk, settingsProofKey(TEST_ORG, NAME).sk) as unknown as ProofItem | undefined;
  const view = (who: Developer = OMAR) => web(who, "GET", PROJECT);
  const settle = async () => { await view(); };
  /** Proves revision 1 the way a person does: presses "Check setup" and the worker passes it. */
  const proveCurrent = async () => {
    const started = await web(OMAR, "POST", `${PROJECT}/setup-check`, { requestId: randomUUID() });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    await finishCheck(meta().setupCheck!.workspaceId, "SUCCEEDED");
    await settle();
    expect(proofItem()?.proven).toBeDefined();
  };
  const browserSave = (changes: Record<string, unknown>, who: Developer = OMAR) => web(who, "PUT", SETTINGS, { requestId: randomUUID(), expectedRevision: latest().revision, ...changes });
  const tokenSave = (changes: Record<string, unknown>, who: Developer = OMAR, requestId: string = randomUUID()) => key(who, "PUT", SETTINGS, { requestId, expectedRevision: latest().revision, ...changes });
  const COMMANDS = { setupCommands: ["npm ci"], testCommands: ["npm test"] };
  /** The project's prepare payload of a task started now: what the worker would be sent as the project. */
  const taskProject = async () => {
    const started = await key(OMAR, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: NAME, instructions: "Fix the retry bug", client: "test-client" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const task = h.db.get(`DEVTASK#${String((started.body.task as { taskId: string }).taskId)}`, "META") as unknown as { workspaceId: string };
    const operation = h.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === task.workspaceId && item.kind === "prepare")[0]!;
    const outbox = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operation.id)[0] as unknown as { invocation: { payload: { project: { setup: unknown[]; readiness: unknown[] } } } };
    return outbox.invocation.payload.project;
  };
  return { ...h, audit, stream, person, web, key, candidates, finishCheck, reportNewest, workspaceStatus, definitions, latest, meta, proofItem, view, settle, proveCurrent, browserSave, tokenSave, COMMANDS, taskProject };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const lists = (setupCommands: unknown[], readiness: unknown[]) => ({ setup: setupCommands, readiness });

// ---- a person in a browser

describe("a browser save of commands (TE-4)", () => {
  it("takes effect at once; then exactly the saved commands are checked in the background, and that check is the project's own (not run twice)", async () => {
    const t = await setup();
    const saved = await t.browserSave(t.COMMANDS);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    // Immediate: the new revision holds the new commands, as it always did.
    expect(t.latest()).toMatchObject({ revision: 2, setup: [NEW_SETUP], readiness: [NEW_TEST] });
    // One check of exactly those commands, at the new revision, and it is the project's check.
    expect(t.candidates()).toHaveLength(1);
    expect(t.candidates()[0]).toMatchObject({ revision: 2, startedBy: OMAR.developerId, ...lists([NEW_SETUP], [NEW_TEST]) });
    expect(t.meta().setupCheck).toMatchObject({ workspaceId: t.candidates()[0]!.workspaceId, revision: 2 });
    const project = saved.body.project as AppProjectDetail;
    expect(project.setup.status).toBe("checking");
    expect(project.settingsProof).toMatchObject({ status: "checking", canUndo: false });
    expect(project.settingsProof?.held).toBeUndefined();
    // Reading the page again starts nothing more.
    await t.settle();
    expect(t.candidates()).toHaveLength(1);
  });

  it("shows Proven once the check passes, and records it as the last proved setup", async () => {
    const t = await setup();
    await t.browserSave(t.COMMANDS);
    await t.reportNewest("SUCCEEDED");
    const reply = await t.view();
    expect(proofOf(reply)).toMatchObject({ status: "proven", canUndo: false });
    expect(proofOf(reply).provenAt).toBeDefined();
    expect(proofOf(reply).notice).toBeUndefined();
    expect((reply.body as unknown as AppProjectDetail).setup.status).toBe("ready");
    expect(t.proofItem()?.proven).toMatchObject({ revision: 2, ...lists([NEW_SETUP], [NEW_TEST]) });
    expect(t.proofItem()?.saved?.status).toBe("proven");
  });

  it("when the check fails: Unproven with the reason, a notice for the saver, no undo when nothing was ever proved, and one message to the saver", async () => {
    const t = await setup();
    await t.person(MAYA, "member", "maintainer");
    const saved = await t.browserSave(t.COMMANDS, OMAR);
    expect(saved.status).toBe(200);
    await t.reportNewest("FAILED", "readiness check 0 (npm test) exited with code 1: 3 tests failed");
    const reply = await t.view();
    expect(proofOf(reply).status).toBe("unproven");
    expect(proofOf(reply).reason).toContain("npm test");
    expect(proofOf(reply).canUndo).toBe(false);
    expect(proofOf(reply).lastProvenAt).toBeUndefined();
    expect(proofOf(reply).notice?.message).toContain("nothing to go back to");
    expect(t.proofItem()?.saved).toMatchObject({ status: "failed", noticeAt: expect.any(String) as string });
    // The settings are as saved: the failure changes nothing by itself.
    expect(t.latest().revision).toBe(2);
    // Nobody can undo what was never proved.
    const refused = await t.web(OMAR, "POST", `${SETTINGS}/undo`, { requestId: randomUUID(), expectedRevision: 2 });
    expect(refused.status).toBe(400);
    expect(errorOf(refused).message).toContain("nothing to go back to");
    expect(t.latest().revision).toBe(2);
  });

  it("when the check fails after a proved setup: the notice offers Undo, and Undo writes the last proved commands back as a new revision, audited, and shows Proven", async () => {
    const t = await setup();
    await t.proveCurrent();
    await t.browserSave(t.COMMANDS);
    await t.reportNewest("FAILED", "setup step 0 (npm ci) exited with code 1");
    const failed = await t.view();
    expect(proofOf(failed)).toMatchObject({ status: "unproven", canUndo: true, notice: { message: expect.stringContaining("go back to the last setup that passed") as string } });
    expect(proofOf(failed).reason).toContain("npm ci");
    const undone = await t.web(OMAR, "POST", `${SETTINGS}/undo`, { requestId: randomUUID(), expectedRevision: 2 });
    expect(undone.status, JSON.stringify(undone.body)).toBe(200);
    // A new revision (never a rewrite of the failed one) holding exactly the proved commands.
    expect(t.latest()).toMatchObject({ revision: 3, setup: [OLD_SETUP], readiness: [OLD_TEST] });
    expect(t.definitions().map((definition) => definition.revision)).toEqual([1, 2, 3]);
    expect(proofOf(undone)).toMatchObject({ status: "proven", canUndo: false });
    expect(proofOf(undone).notice).toBeUndefined();
    const events = t.audit.recordedBy("project.setup_restored");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { kind: "member", id: OMAR.developerId }, facts: { revision: 3, fromRevision: 2, provenRevision: 1 } });
    // No command is in the audit event.
    expect(JSON.stringify(events[0])).not.toContain("old-setup");
  });

  it("the failure banner and the way back are shown to a maintainer; a contributor sees Unproven and the reason only", async () => {
    const t = await setup();
    await t.person(MAYA, "member", "contributor");
    await t.proveCurrent();
    await t.browserSave(t.COMMANDS);
    await t.reportNewest("FAILED", "setup step 0 (npm ci) exited with code 1");
    const seen = await t.view(MAYA);
    expect(proofOf(seen)).toMatchObject({ status: "unproven", canUndo: false });
    expect(proofOf(seen).notice).toBeUndefined();
    expect(proofOf(await t.view(OMAR)).notice).toBeDefined();
  });

  it("undo is for a maintainer in a browser signed in within ten minutes, once per press, at the revision the person saw", async () => {
    const t = await setup();
    await t.person(MAYA, "member", "contributor");
    await t.proveCurrent();
    await t.browserSave(t.COMMANDS);
    await t.reportNewest("FAILED", "setup step 0 (npm ci) exited with code 1");
    await t.settle();
    const body = (revision = 2) => ({ requestId: randomUUID(), expectedRevision: revision });
    // A token is never a browser.
    const token = await t.key(OMAR, "POST", `${SETTINGS}/undo`, body());
    expect(token.status).toBe(403);
    // An old sign-in is asked to sign in again.
    const stale = await t.web(OMAR, "POST", `${SETTINGS}/undo`, body(), 11 * 60_000);
    expect(stale.status).toBe(403);
    expect(errorOf(stale).code).toBe("REAUTH_REQUIRED");
    // A contributor may not change settings.
    const contributor = await t.web(MAYA, "POST", `${SETTINGS}/undo`, body());
    expect(contributor.status).toBe(403);
    // The settings moved on since the person looked.
    const moved = await t.web(OMAR, "POST", `${SETTINGS}/undo`, body(1));
    expect(moved.status).toBe(409);
    expect(t.latest().revision).toBe(2);
    // The press that works, and its repeat (same request id) writes nothing more.
    const press = body();
    expect((await t.web(OMAR, "POST", `${SETTINGS}/undo`, press)).status).toBe(200);
    expect((await t.web(OMAR, "POST", `${SETTINGS}/undo`, press)).status).toBe(200);
    expect(t.latest().revision).toBe(3);
    expect(t.audit.recordedBy("project.setup_restored")).toHaveLength(1);
  });

  it("a save that changes no command, or only the description, starts no check", async () => {
    const t = await setup();
    const same = await t.browserSave({ setupCommands: ["make old-setup"], testCommands: ["make old-test"] });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    const described = await t.browserSave({ description: "A new description" });
    expect(described.status).toBe(200);
    expect(t.candidates()).toHaveLength(0);
    expect(t.meta().description).toBe("A new description");
  });

  it("a dev container is part of the check: the check is prepared with the container that was saved", async () => {
    const t = await setup();
    const saved = await t.browserSave({ devcontainer: { repository: "web", configPath: ".devcontainer/devcontainer.json" } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(t.latest().devcontainer).toMatchObject({ repository: "web" });
    expect(t.candidates()).toHaveLength(1);
    const operation = t.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === t.candidates()[0]!.workspaceId && item.kind === "prepare")[0]!;
    const outbox = t.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operation.id)[0] as unknown as { invocation: { payload: { project: { devcontainer?: { repository: string } } } } };
    expect(outbox.invocation.payload.project.devcontainer).toMatchObject({ repository: "web" });
  });

  it("a newer save supersedes the older check: one check in flight, the older workspace is closed and the newer is the project's", async () => {
    const t = await setup();
    await t.browserSave(t.COMMANDS);
    const first = t.candidates()[0]!;
    await t.browserSave({ testCommands: ["npm run verify"] });
    expect(t.candidates()).toHaveLength(2);
    const second = t.candidates().find((candidate) => candidate.workspaceId !== first.workspaceId)!;
    expect(t.workspaceStatus(first.workspaceId)).toBe("CLOSED");
    // S4: a prepare the dispatcher has not claimed is failed, and the dispatcher claims only an accepted one: nothing is started for it later.
    expect(t.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === first.workspaceId).map((item) => item.status)).toEqual(["FAILED"]);
    expect(t.meta().setupCheck).toMatchObject({ workspaceId: second.workspaceId, revision: 3 });
    expect(t.proofItem()?.saved).toMatchObject({ status: "checking", workspaceId: second.workspaceId });
  });

  it("S4: a check the dispatcher has claimed is not stopped under it (its machine may be starting); it finishes by itself", async () => {
    const t = await setup();
    await t.browserSave(t.COMMANDS);
    const first = t.candidates()[0]!;
    const operation = t.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === first.workspaceId)[0]!;
    t.db.set({ ...operation, status: "DISPATCHING" });
    await t.browserSave({ testCommands: ["npm run verify"] });
    expect(t.workspaceStatus(first.workspaceId)).toBe("PREPARING");
    expect(t.candidates()).toHaveLength(2);
  });

  it("a save that cannot start its check still saves; the settings say Unproven, not checked", async () => {
    // The person is at the workspace limit: the check cannot be admitted.
    const t = await setup({ memberLimit: 0 });
    const saved = await t.browserSave(t.COMMANDS);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(t.latest()).toMatchObject({ revision: 2, setup: [NEW_SETUP] });
    expect(t.candidates()).toHaveLength(0);
    expect(proofOf(saved)).toMatchObject({ status: "unproven", reason: expect.stringContaining("limit") as string });
    expect(proofOf(await t.view())).toMatchObject({ status: "unproven" });
  });
});

// ---- an API key

describe("an API-key save of commands (TE-4)", () => {
  it("is held: the settings do not change, the reply and the page say so, and the check of exactly those commands starts", async () => {
    const t = await setup();
    const reply = await t.tokenSave(t.COMMANDS);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.held).toMatchObject({ status: "checking", fields: ["setupCommands", "testCommands"] });
    // Nothing was written.
    expect(t.latest()).toMatchObject({ revision: 1, setup: [OLD_SETUP], readiness: [OLD_TEST] });
    expect((reply.body.project as AppProjectDetail).settings.setupCommands).toEqual(["make old-setup"]);
    expect(proofOf(reply).held).toMatchObject({ status: "checking" });
    expect(t.candidates()).toHaveLength(1);
    expect(t.candidates()[0]).toMatchObject({ revision: 1, ...lists([NEW_SETUP], [NEW_TEST]) });
    // Looking at the page while it runs writes nothing and starts nothing.
    await t.settle();
    expect(t.latest().revision).toBe(1);
    expect(t.candidates()).toHaveLength(1);
  });

  it("is written when its check passes, exactly the checked commands, at a revision that still matches, and that check is the project's own", async () => {
    const t = await setup();
    await t.tokenSave(t.COMMANDS);
    await t.reportNewest("SUCCEEDED");
    const reply = await t.view();
    expect(t.latest()).toMatchObject({ revision: 2, setup: [NEW_SETUP], readiness: [NEW_TEST] });
    const project = reply.body as unknown as AppProjectDetail;
    expect(project.settings.setupCommands).toEqual(["npm ci"]);
    expect(project.settingsProof).toMatchObject({ status: "proven" });
    expect(project.settingsProof?.held).toBeUndefined();
    expect(project.setup.status).toBe("ready");
    expect(t.meta().setupCheck).toMatchObject({ workspaceId: t.candidates()[0]!.workspaceId, revision: 2 });
    expect(t.candidates()).toHaveLength(1);
    expect(t.proofItem()?.proven).toMatchObject({ revision: 2 });
    // The write is the person's own: audited as the settings change it is.
    await t.settle();
    expect(t.latest().revision).toBe(2);
  });

  it("is never written when its check fails, and the reply says why", async () => {
    const t = await setup();
    await t.tokenSave(t.COMMANDS);
    await t.reportNewest("FAILED", "setup step 0 (npm ci) exited with code 1");
    const reply = await t.view();
    expect(t.latest()).toMatchObject({ revision: 1, setup: [OLD_SETUP] });
    expect(proofOf(reply).held).toMatchObject({ status: "failed", reason: expect.stringContaining("npm ci") as string });
    await t.settle();
    await t.settle();
    expect(t.latest().revision).toBe(1);
    expect(t.definitions()).toHaveLength(1);
  });

  it("changes the other fields at once, as before, and holds only the commands", async () => {
    const t = await setup();
    const reply = await t.tokenSave({ description: "From CI", ...t.COMMANDS });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(t.meta().description).toBe("From CI");
    expect(t.latest()).toMatchObject({ revision: 1, setup: [OLD_SETUP] });
    expect(reply.body.held).toMatchObject({ status: "checking" });
  });

  it("a save that changes no command is a plain save (nothing held, no check)", async () => {
    const t = await setup();
    const reply = await t.tokenSave({ description: "Only this", setupCommands: ["make old-setup"] });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.held).toBeUndefined();
    expect(t.candidates()).toHaveLength(0);
    expect(t.meta().description).toBe("Only this");
  });

  it("refuses commands sent together with repository changes, and commands it cannot read, before anything is held", async () => {
    const t = await setup();
    const together = await t.tokenSave({ addRepositories: ["acme/lib"], ...t.COMMANDS });
    expect(together.status).toBe(400);
    expect(errorOf(together).message).toContain("separate requests");
    const unreadable = await t.tokenSave({ setupCommands: ["npm ci \"unterminated"] });
    expect(unreadable.status).toBe(400);
    expect(t.candidates()).toHaveLength(0);
    expect(t.proofItem()?.held).toBeUndefined();
  });

  it("a viewer or contributor is refused as ever, and nothing is held", async () => {
    const t = await setup();
    await t.person(MAYA, "member", "contributor");
    const refused = await t.tokenSave(t.COMMANDS, MAYA);
    expect(refused.status).toBe(403);
    expect(t.candidates()).toHaveLength(0);
    expect(t.proofItem()?.held).toBeUndefined();
  });

  it("a race: when the settings moved while the check ran, a passed check writes nothing", async () => {
    const t = await setup();
    await t.tokenSave(t.COMMANDS);
    // Someone else's save moved the revision (the same commands, a new domain list: nothing about the held lists).
    t.db.set({ ...projectRevisionKey(TEST_ORG, NAME, 2), entityType: "PROJECT", registeredBy: "x", registeredAt: "2026-10-03T00:00:00.000Z", runtimeBinding: BINDING, definition: { ...t.latest(), revision: 2, orchestratorInstructions: "Delegate work, now with a note." } });
    await t.reportNewest("SUCCEEDED");
    const reply = await t.view();
    expect(t.definitions().map((definition) => definition.revision)).toEqual([1, 2]);
    expect(t.latest().setup).toEqual([OLD_SETUP]);
    expect(proofOf(reply).held).toMatchObject({ status: "stale" });
  });

  it("a race: two readers settling at once write the change once", async () => {
    const t = await setup();
    await t.tokenSave(t.COMMANDS);
    await t.reportNewest("SUCCEEDED");
    const replies = await Promise.all([t.view(), t.view(), t.view()]);
    expect(replies.every((reply) => reply.status === 200)).toBe(true);
    expect(t.definitions().map((definition) => definition.revision)).toEqual([1, 2]);
    expect(t.latest()).toMatchObject({ setup: [NEW_SETUP], readiness: [NEW_TEST] });
  });

  it("a check that ran other commands than the held ones is never written", async () => {
    const t = await setup();
    await t.tokenSave(t.COMMANDS);
    const record = t.candidates()[0]!;
    const stored = t.db.find((item) => item.entityType === "TEST_ENV_CANDIDATE_CHECK")[0]!;
    t.db.set({ ...stored, setup: [command("sh", ["-c", "true"], 900)] });
    await t.finishCheck(record.workspaceId, "SUCCEEDED");
    await t.settle();
    expect(t.latest()).toMatchObject({ revision: 1, setup: [OLD_SETUP] });
    expect(t.proofItem()?.held?.status).toBe("failed");
  });

  it("a newer save supersedes the older held one: the older check is closed and only the newer is ever written; the same request again starts nothing", async () => {
    const t = await setup();
    const requestId = randomUUID();
    await t.tokenSave({ setupCommands: ["make one"] }, OMAR, requestId);
    expect(t.candidates()).toHaveLength(1);
    const again = await t.tokenSave({ setupCommands: ["make one"] }, OMAR, requestId);
    expect(again.status).toBe(200);
    expect(t.candidates()).toHaveLength(1);
    const first = t.candidates()[0]!;
    await t.tokenSave({ setupCommands: ["make two"] });
    expect(t.candidates()).toHaveLength(2);
    expect(t.workspaceStatus(first.workspaceId)).toBe("CLOSED");
    await t.reportNewest("SUCCEEDED");
    await t.settle();
    expect(t.latest()).toMatchObject({ revision: 2, setup: [command("make", ["two"], 900)] });
    await t.settle();
    expect(t.latest().revision).toBe(2);
  });

  it("one check in flight per project: a held change waits while a browser save is under its check, and a browser save stops a held change", async () => {
    const t = await setup();
    await t.browserSave(t.COMMANDS);
    const busy = await t.tokenSave({ setupCommands: ["make other"] });
    expect(busy.status).toBe(409);
    expect(errorOf(busy).code).toBe("WORKSPACE_BUSY");
    expect(t.candidates()).toHaveLength(1);
    await t.reportNewest("SUCCEEDED");
    await t.settle();
    const held = await t.tokenSave({ setupCommands: ["make held"] });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const heldWorkspace = t.candidates().at(-1)!.workspaceId;
    await t.browserSave({ testCommands: ["npm run verify"] });
    expect(t.workspaceStatus(heldWorkspace)).toBe("CLOSED");
    expect(proofOf(await t.view()).held).toMatchObject({ status: "stale" });
    expect(t.latest().setup).toEqual([NEW_SETUP]);
  });

  it("is never written if the person who sent it has left the organization", async () => {
    const t = await setup();
    await t.person(MAYA, "member", "maintainer");
    await t.tokenSave(t.COMMANDS, MAYA);
    t.db.delete(orgMemberKey(TEST_ORG, MAYA.developerId));
    t.db.delete(developerOrgKey(MAYA.developerId));
    await t.reportNewest("SUCCEEDED");
    await t.settle();
    expect(t.latest()).toMatchObject({ revision: 1, setup: [OLD_SETUP] });
  });

  it("no unproven API change ever reaches a task's prepared definition", async () => {
    const t = await setup({ memberLimit: 20 });
    await t.tokenSave(t.COMMANDS);
    // Held and under check: a task started now is prepared with the commands saved now.
    expect(await t.taskProject()).toMatchObject({ setup: [OLD_SETUP], readiness: [OLD_TEST] });
    await t.reportNewest("FAILED", "setup step 0 (npm ci) exited with code 1");
    await t.settle();
    expect(await t.taskProject()).toMatchObject({ setup: [OLD_SETUP], readiness: [OLD_TEST] });
    // A change whose check passes is in the next task, and not before.
    await t.tokenSave({ testCommands: ["npm test"] });
    expect(await t.taskProject()).toMatchObject({ readiness: [OLD_TEST] });
    await t.reportNewest("SUCCEEDED");
    await t.settle();
    expect(await t.taskProject()).toMatchObject({ setup: [OLD_SETUP], readiness: [NEW_TEST] });
  });

  it("a dev container sent with an API key is held and checked too, and removing it is a change that is checked", async () => {
    const t = await setup();
    const reply = await t.tokenSave({ devcontainer: { repository: "web" } });
    expect(reply.body.held).toMatchObject({ status: "checking", fields: ["devcontainer"] });
    expect(t.latest().devcontainer).toBeUndefined();
    await t.reportNewest("SUCCEEDED");
    await t.settle();
    expect(t.latest().devcontainer).toMatchObject({ repository: "web" });
    const removed = await t.tokenSave({ devcontainer: null });
    expect(removed.body.held).toMatchObject({ status: "checking" });
    expect(t.latest().devcontainer).toMatchObject({ repository: "web" });
    await t.reportNewest("SUCCEEDED");
    await t.settle();
    expect(t.latest().devcontainer).toBeUndefined();
  });
});

// ---- the message to the saver

describe("the message to the person whose saved commands failed (TE-4)", () => {
  it("is produced once by the failed check and sent once through the notifier, with the check's reason", async () => {
    const t = await setup();
    const maya = { ...MAYA };
    await t.person(maya, "member", "maintainer");
    // The saver's Slack identity is on the caller; the harness gives Maya one.
    const saved = await t.web(maya, "PUT", SETTINGS, { requestId: randomUUID(), expectedRevision: 1, ...t.COMMANDS });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    t.stream.take();
    await t.reportNewest("FAILED", "readiness check 0 (npm test) exited with code 1");
    await t.settle();
    const queued: Notice[] = [];
    const posted: Array<{ channel: string; text: string }> = [];
    const deps: NotifierDependencies = { documentClient: t.db, tableName: "state", enqueue: async (notices) => { queued.push(...notices); }, retryLater: async () => undefined,
      post: async (message: { channel: string; text: string }) => { posted.push(message); return { ts: "1.2", channel: "D1" }; }, now: () => Date.now(), log: () => undefined, deliveryFailed: () => undefined };
    const handler = createNotifierHandler(deps);
    await handler({ Records: t.stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    const proof = queued.filter((notice) => notice.kind === "settings_proof");
    expect(t.proofItem()?.saved?.slackUserId).toBe(maya.slackUserId);
    expect(proof).toHaveLength(1);
    const message = { eventSource: "aws:sqs", messageId: "m1", receiptHandle: "r1", body: JSON.stringify(proof[0]), attributes: { ApproximateReceiveCount: "1" } };
    await handler({ Records: [message] });
    await handler({ Records: [{ ...message, messageId: "m2" }] });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain("npm test");
    expect(posted[0]!.text).toContain("web");
  });

  it("the stream produces a notice only when a saved check turns failed, for a person with a linked Slack identity, and not again for the same check", () => {
    const item = (saved: Record<string, unknown>) => ({ pk: `ORG#x#PROJECT#web`, sk: "SETTINGS_PROOF", entityType: "PROJECT_SETTINGS_PROOF", orgId: "x", project: "web", saved });
    const failed = { status: "failed", checkRequestId: "c1", noticeAt: "2026-11-02T10:00:00.000Z", slackUserId: "U1" };
    const at = "2026-11-02T10:00:00.000Z";
    expect(noticesOf(item({ status: "checking", checkRequestId: "c1", slackUserId: "U1" }), item(failed), at, "e1")).toEqual([expect.objectContaining({ kind: "settings_proof", proofCheckId: "c1", proofItem: { pk: "ORG#x#PROJECT#web", sk: "SETTINGS_PROOF" } })]);
    expect(noticesOf(item(failed), item({ ...failed, notifiedAt: at }), at, "e2")).toEqual([]);
    // A held change that ends without being written is told too, once, as its own notice.
    const heldItem = (held: Record<string, unknown>) => ({ ...item({}), held });
    expect(noticesOf(undefined, heldItem({ status: "stale", checkRequestId: "h1", noticeAt: at, slackUserId: "U1" }), at, "e5")).toEqual([expect.objectContaining({ kind: "settings_proof", proofPart: "held", proofCheckId: "h1" })]);
    expect(noticesOf(undefined, heldItem({ status: "applied", checkRequestId: "h1", slackUserId: "U1" }), at, "e6")).toEqual([]);
    expect(noticesOf(undefined, item({ ...failed, status: "checking" }), at, "e3")).toEqual([]);
    expect(noticesOf(undefined, item({ ...failed, slackUserId: undefined }), at, "e4")).toEqual([]);
  });
});

// ---- review round 1 (Opus): B1, B2, S1 to S5

describe("a body that adds a repository and carries commands or a dev container (B1)", () => {
  const BODY = { addRepositories: ["acme/lib"], devcontainer: { repository: "lib" }, setupCommands: ["curl evil"] };

  it("an API key is refused: nothing is written, held or checked", async () => {
    const t = await setup();
    const reply = await t.tokenSave(BODY);
    expect(reply.status, JSON.stringify(reply.body)).toBe(400);
    expect(errorOf(reply).message).toContain("separate requests");
    expect(t.definitions()).toHaveLength(1);
    expect(t.candidates()).toHaveLength(0);
    expect(t.proofItem()?.held).toBeUndefined();
  });

  it("an API key's commands with a dev container that is not a repository of the project are refused as the save refuses them, never written", async () => {
    const t = await setup();
    const reply = await t.tokenSave({ devcontainer: { repository: "lib" }, setupCommands: ["curl evil"] });
    expect(reply.status).toBe(400);
    expect(errorOf(reply).code).toBe("CONFIG_INVALID");
    expect(t.definitions()).toHaveLength(1);
    expect(t.candidates()).toHaveLength(0);
  });

  it("a browser session saves it at once and the saved commands and dev container are checked", async () => {
    const t = await setup();
    const reply = await t.browserSave(BODY);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(t.latest()).toMatchObject({ revision: 2, devcontainer: { repository: "lib" } });
    expect(t.latest().setup.map((entry) => entry.executable)).toEqual(["curl"]);
    expect(t.candidates()).toHaveLength(1);
    expect(t.candidates()[0]).toMatchObject({ revision: 2 });
    expect(t.candidates()[0]!.setup.map((entry) => entry.executable)).toEqual(["curl"]);
    expect(proofOf(reply)).toMatchObject({ status: "checking" });
  });

  it("a browser session's body the save refuses is refused, and nothing is written", async () => {
    const t = await setup();
    const reply = await t.browserSave({ devcontainer: { repository: "nowhere" }, setupCommands: ["curl evil"] });
    expect(reply.status).toBe(400);
    expect(t.definitions()).toHaveLength(1);
    expect(t.candidates()).toHaveLength(0);
  });

  it("a browser save that adds a repository and leaves the commands as they were starts no check", async () => {
    const t = await setup();
    const reply = await t.browserSave({ addRepositories: ["acme/lib"], setupCommands: ["make old-setup"] });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(t.latest().revision).toBe(2);
    expect(t.candidates()).toHaveLength(0);
  });
});

describe("a check that reports is acted on at once (B2)", () => {
  it("a held change is written when its check passes, with nobody reading the project", async () => {
    const t = await setup();
    await t.tokenSave(t.COMMANDS);
    await t.reportNewest("SUCCEEDED");
    expect(t.latest()).toMatchObject({ revision: 2, setup: [NEW_SETUP], readiness: [NEW_TEST] });
    expect(t.proofItem()?.proven).toMatchObject({ revision: 2 });
    expect(t.meta().setupCheck).toMatchObject({ revision: 2 });
  });

  it("a held change whose check fails is dropped, and the person who sent it is told, with nobody reading the project", async () => {
    const t = await setup();
    await t.person(MAYA, "member", "maintainer");
    await t.tokenSave(t.COMMANDS, MAYA);
    t.stream.take();
    await t.reportNewest("FAILED", "setup step 0 (npm ci) exited with code 1");
    expect(t.latest().revision).toBe(1);
    expect(t.proofItem()?.held).toMatchObject({ status: "failed", noticeAt: expect.any(String) as string });
  });

  it("a browser save whose check fails sends the failure to the saver with nobody reading the project", async () => {
    const t = await setup();
    await t.person(MAYA, "member", "maintainer");
    await t.web(MAYA, "PUT", SETTINGS, { requestId: randomUUID(), expectedRevision: 1, ...t.COMMANDS });
    await t.reportNewest("FAILED", "readiness check 0 (npm test) exited with code 1");
    expect(t.proofItem()?.saved).toMatchObject({ status: "failed", noticeAt: expect.any(String) as string });
  });

  it("a held change is told to the person who sent it through the notifier", async () => {
    const t = await setup();
    await t.person(MAYA, "member", "maintainer");
    await t.tokenSave(t.COMMANDS, MAYA);
    t.stream.take();
    await t.reportNewest("FAILED", "setup step 0 (npm ci) exited with code 1");
    const queued: Notice[] = [];
    const posted: Array<{ channel: string; text: string }> = [];
    const handler = createNotifierHandler({ documentClient: t.db, tableName: "state", enqueue: async (notices) => { queued.push(...notices); }, retryLater: async () => undefined,
      post: async (message: { channel: string; text: string }) => { posted.push(message); return { ts: "1.2", channel: "D1" }; }, now: () => Date.now(), log: () => undefined, deliveryFailed: () => undefined });
    await handler({ Records: t.stream.take().map((record) => ({ ...record, eventSource: "aws:dynamodb" })) });
    const proof = queued.filter((notice) => notice.kind === "settings_proof");
    expect(proof).toHaveLength(1);
    expect(proof[0]).toMatchObject({ proofPart: "held" });
    await handler({ Records: [{ eventSource: "aws:sqs", messageId: "m1", receiptHandle: "r1", body: JSON.stringify(proof[0]), attributes: { ApproximateReceiveCount: "1" } }] });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain("was not saved");
    expect(posted[0]!.text).toContain("npm ci");
  });

  it("a held change does not die silently: one whose check never reported is dropped after a while with a notice, and one whose check passed too late is dropped with a notice", async () => {
    const t = await setup();
    await t.tokenSave(t.COMMANDS);
    const item = t.proofItem()!.held as unknown as Record<string, unknown>;
    t.db.set({ ...(t.db.get(settingsProofKey(TEST_ORG, NAME).pk, settingsProofKey(TEST_ORG, NAME).sk) as Record<string, unknown>), held: { ...item, heldAt: new Date(Date.now() - 4 * 3_600_000).toISOString() } });
    await t.settle();
    expect(t.proofItem()?.held).toMatchObject({ status: "failed", reason: expect.stringContaining("did not finish in time") as string, noticeAt: expect.any(String) as string });
    expect(t.latest().revision).toBe(1);
    // A check older than seven days is not trusted.
    await t.tokenSave({ testCommands: ["npm run verify"] });
    const stored = t.db.find((entry) => entry.entityType === "TEST_ENV_CANDIDATE_CHECK").at(-1)!;
    t.db.set({ ...stored, startedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    await t.reportNewest("SUCCEEDED");
    expect(t.latest().revision).toBe(1);
    expect(t.proofItem()?.held).toMatchObject({ status: "failed", noticeAt: expect.any(String) as string });
  });
});

describe("what a held change is written as, and what is recorded (S1 to S5)", () => {
  it("S1: proven and the project's check are recorded at the revision the held write made, even when another save lands right after it", async () => {
    const t = await setup();
    await t.tokenSave(t.COMMANDS);
    const real = t.db.send.bind(t.db);
    const second = projectRevisionKey(TEST_ORG, NAME, 2);
    let armed = true;
    (t.db as unknown as { send: unknown }).send = async (sent: { constructor: { name: string }; input?: unknown }) => {
      const answer = await real(sent as never);
      if (armed && sent.constructor.name === "TransactWriteCommand" && JSON.stringify(sent.input).includes(second.sk)) {
        armed = false;
        // Another save lands between the held write and the next read: revision 3 with other commands.
        t.db.set({ ...second, sk: projectRevisionKey(TEST_ORG, NAME, 3).sk, entityType: "PROJECT", registeredBy: "x", registeredAt: "2026-11-03T00:00:00.000Z", runtimeBinding: BINDING, definition: { ...t.latest(), revision: 3, setup: [command("sh", ["-c", "true"], 900)] } });
      }
      return answer;
    };
    await t.reportNewest("SUCCEEDED");
    expect(armed).toBe(false);
    expect(t.proofItem()?.proven).toMatchObject({ revision: 2, ...lists([NEW_SETUP], [NEW_TEST]) });
    expect(t.meta().setupCheck).toMatchObject({ revision: 2 });
  });

  it("S2: a revoked key's held change is never written, and its sender is told", async () => {
    const t = await setup();
    await t.person(MAYA, "member", "maintainer");
    await t.tokenSave(t.COMMANDS, MAYA);
    const session = t.db.get(`SESSION#${MAYA.sessionId}`, "META") as Record<string, unknown>;
    t.db.set({ ...session, revokedAt: new Date().toISOString() });
    await t.reportNewest("SUCCEEDED");
    expect(t.latest()).toMatchObject({ revision: 1, setup: [OLD_SETUP] });
    expect(t.proofItem()?.held).toMatchObject({ status: "refused", noticeAt: expect.any(String) as string });
  });

  it("S2: a sender who lost the right to change settings is not written either", async () => {
    const t = await setup();
    await t.person(MAYA, "member", "maintainer");
    await t.tokenSave(t.COMMANDS, MAYA);
    t.db.set({ ...(t.db.get(projectMemberKey(TEST_ORG, MAYA.developerId, NAME)) as Record<string, unknown>), projectRole: "viewer", role: "viewer" });
    await t.reportNewest("SUCCEEDED");
    expect(t.latest().revision).toBe(1);
    expect(t.proofItem()?.held).toMatchObject({ status: "refused", noticeAt: expect.any(String) as string });
  });

  it("S5: a change is not replaced while the one before it is being written, and an older write cannot land after it was replaced", async () => {
    const t = await setup();
    await t.tokenSave(t.COMMANDS);
    const key = settingsProofKey(TEST_ORG, NAME);
    const whole = () => t.db.get(key.pk, key.sk) as Record<string, unknown>;
    const held = whole().held as Record<string, unknown>;
    // Being written right now: a newer change waits.
    t.db.set({ ...whole(), held: { ...held, status: "applying", claimedAt: new Date().toISOString() } });
    const busy = await t.tokenSave({ setupCommands: ["make newer"] });
    expect(busy.status).toBe(409);
    expect(errorOf(busy).code).toBe("WORKSPACE_BUSY");
    // Replaced between the claim and the write: the old write lands nowhere.
    t.db.set({ ...whole(), held });
    const real = t.db.send.bind(t.db);
    let armed = true;
    (t.db as unknown as { send: unknown }).send = async (command: { constructor: { name: string }; input?: { Key?: { pk?: string } } }) => {
      if (armed && command.constructor.name === "GetCommand" && String(command.input?.Key?.pk).startsWith("SESSION#")) {
        armed = false;
        t.db.set({ ...whole(), held: { ...held, checkRequestId: randomUUID(), status: "checking" } });
      }
      return real(command as never);
    };
    await t.reportNewest("SUCCEEDED");
    expect(t.latest()).toMatchObject({ revision: 1, setup: [OLD_SETUP] });
  });
});

describe("a check that ends with no result callback is acted on by the recovery run (B2 remainder)", () => {
  const recovery = (t: Setup) => t.handler({ source: "agentx.workflow-merge-recovery" });
  const watches = (t: Setup) => t.db.find((item) => item.entityType === "SETTINGS_PROOF_WATCH");
  /** What the 50-minute sweep (or a failed dispatch) leaves: the prepare FAILED and the workspace PREPARATION_FAILED, and no callback. */
  const endedWithNoCallback = (t: Setup, workspaceId: string) => {
    const workspace = t.db.get(`WORKSPACE#${workspaceId}`, "META") as Record<string, unknown>;
    const operation = t.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId)[0]!;
    t.db.set({ ...operation, status: "FAILED", error: "did not finish within 50 minutes" });
    t.db.set({ ...workspace, status: "PREPARATION_FAILED", activeOperationId: undefined });
  };

  it("a held change whose check ended with no callback is dropped and its sender told, and the watch ends", async () => {
    const t = await setup();
    await t.person(MAYA, "member", "maintainer");
    await t.tokenSave(t.COMMANDS, MAYA);
    expect(watches(t)).toHaveLength(1);
    endedWithNoCallback(t, t.candidates()[0]!.workspaceId);
    expect((await recovery(t)).statusCode).toBe(200);
    expect(t.proofItem()?.held).toMatchObject({ status: "failed", noticeAt: expect.any(String) as string });
    expect(t.latest().revision).toBe(1);
    expect(watches(t)).toHaveLength(0);
  });

  it("a browser save whose check ended with no callback is marked failed for its saver, and the watch ends", async () => {
    const t = await setup();
    await t.browserSave(t.COMMANDS);
    endedWithNoCallback(t, t.candidates()[0]!.workspaceId);
    await recovery(t);
    expect(t.proofItem()?.saved).toMatchObject({ status: "failed", noticeAt: expect.any(String) as string });
    expect(watches(t)).toHaveLength(0);
  });

  it("a held change whose check never reports is dropped with a notice after a while, with nobody reading; one still waiting stays watched", async () => {
    const t = await setup();
    await t.tokenSave(t.COMMANDS);
    await recovery(t);
    expect(t.proofItem()?.held?.status).toBe("checking");
    expect(watches(t)).toHaveLength(1);
    const key = settingsProofKey(TEST_ORG, NAME);
    const whole = t.db.get(key.pk, key.sk) as Record<string, unknown>;
    t.db.set({ ...whole, held: { ...(whole.held as object), heldAt: new Date(Date.now() - 4 * 3_600_000).toISOString() } });
    await recovery(t);
    expect(t.proofItem()?.held).toMatchObject({ status: "failed", reason: expect.stringContaining("did not finish in time") as string, noticeAt: expect.any(String) as string });
    expect(watches(t)).toHaveLength(0);
  });
});

describe("S4: the stop is one conditional write", () => {
  it("a check the dispatcher claims between the look and the stop is left running", async () => {
    const t = await setup();
    await t.browserSave(t.COMMANDS);
    const first = t.candidates()[0]!;
    const real = t.db.send.bind(t.db);
    let armed = true;
    (t.db as unknown as { send: unknown }).send = async (sent: { constructor: { name: string }; input?: { Key?: { pk?: string; sk?: string } } }) => {
      const answer = await real(sent as never);
      // The first read of the check's operation: then the dispatcher claims it.
      if (armed && sent.constructor.name === "GetCommand" && sent.input?.Key?.pk === `WORKSPACE#${first.workspaceId}` && String(sent.input.Key.sk).startsWith("OPERATION#")) {
        armed = false;
        const operation = t.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === first.workspaceId)[0]!;
        t.db.set({ ...operation, status: "DISPATCHING" });
      }
      return answer;
    };
    await t.browserSave({ testCommands: ["npm run verify"] });
    expect(armed).toBe(false);
    expect(t.workspaceStatus(first.workspaceId)).toBe("PREPARING");
    expect(t.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === first.workspaceId).map((item) => item.status)).toEqual(["DISPATCHING"]);
  });
});

// UX4B-CMD-OPTS: changing ONE line of the command list leaves the other commands' own timeout and env alone (a line carries neither); the changed list still goes through proof exactly as before.
describe("editing one command keeps the others' own timeout and env", () => {
  const ONE = { ...command("make", ["one"], 111), env: { A: "1" } };
  const TWO = { ...command("make", ["two"], 222), env: { B: "2" } };
  const THREE = command("make", ["three"], 333);
  /** Revision 1 holds three setup commands with options of their own (and the usual test command). */
  const withThree = async () => {
    const t = await setup();
    const stored = t.db.get(projectRevisionKey(TEST_ORG, NAME, 1)) as { definition: Record<string, unknown> } & Record<string, unknown>;
    t.db.set({ ...stored, definition: { ...stored.definition, setup: [ONE, TWO, THREE] } });
    return t;
  };
  const defaults = (args: string[]) => command("make", args, 900);

  it("a browser save of one changed line: the other two are stored exactly as they were, the changed one takes the defaults, and the saved commands are checked", async () => {
    const t = await withThree();
    const saved = await t.browserSave({ setupCommands: ["make one", "make two-changed", "make three"] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(t.latest().setup).toEqual([ONE, defaults(["two-changed"]), THREE]);
    expect(t.candidates()).toHaveLength(1);
    expect(t.candidates()[0]).toMatchObject({ revision: 2, setup: [ONE, defaults(["two-changed"]), THREE] });
  });

  it("a reorder and a deletion keep each command's own options, and are checked", async () => {
    const t = await withThree();
    expect((await t.browserSave({ setupCommands: ["make three", "make one", "make two"] })).status).toBe(200);
    expect(t.latest().setup).toEqual([THREE, ONE, TWO]);
    expect(t.candidates().at(-1)).toMatchObject({ revision: 2, setup: [THREE, ONE, TWO] });
    expect((await t.browserSave({ setupCommands: ["make three", "make two"] })).status).toBe(200);
    expect(t.latest().setup).toEqual([THREE, TWO]);
    expect(t.candidates().at(-1)).toMatchObject({ revision: 3, setup: [THREE, TWO] });
  });

  it("a line never inherits another command's env, and an added line takes the defaults", async () => {
    const t = await withThree();
    await t.browserSave({ setupCommands: ["make one", "make one --more", "make two", "make three"] });
    expect(t.latest().setup).toEqual([ONE, defaults(["one", "--more"]), TWO, THREE]);
  });

  it("an API key's change of one line is held with the other lines' options kept, nothing is written before its check passes, and what is written is the checked lists", async () => {
    const t = await withThree();
    const reply = await t.tokenSave({ setupCommands: ["make one", "make two", "make three-changed"] });
    expect(reply.body.held).toMatchObject({ status: "checking", fields: ["setupCommands"] });
    expect(t.latest()).toMatchObject({ revision: 1, setup: [ONE, TWO, THREE] });
    const expected = [ONE, TWO, defaults(["three-changed"])];
    expect(t.candidates()[0]).toMatchObject({ revision: 1, setup: expected });
    await t.reportNewest("SUCCEEDED");
    await t.view();
    expect(t.latest()).toMatchObject({ revision: 2, setup: expected });
  });

  it("a save that resends the same lines changes nothing and starts no check", async () => {
    const t = await withThree();
    await t.browserSave({ setupCommands: ["make one", "make two", "make three"] });
    expect(t.latest()).toMatchObject({ revision: 1, setup: [ONE, TWO, THREE] });
    expect(t.candidates()).toHaveLength(0);
  });
});
