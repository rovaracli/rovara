// "How we work" (S1): starting work runs the project's process. `startCodeIntent` asks `projectProcessOf` for the project and runs that agent instead of always running the built-in
// Rovara Code; a pointer that no longer holds refuses the start with one message (never a quiet fall back to the built-in). Every start path goes through it, so the app route and the
// Slack start are covered here; the setup draft keeps the built-in. The broker is built with `agents: {}` as the deployed handler is.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as BrokerModule from "../../packages/broker/src/aws/broker.js";
import { AgentStore, resolveAgent } from "../../packages/broker/src/agents/store.js";
import { readRunRequest, runRequestFingerprint } from "../../packages/broker/src/agents/runs.js";
import { startCodeIntent } from "../../packages/broker/src/rovara-code/intent.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { ROVARA_CODE_AGENT_ID, projectPlaybookKey, recipeDigest, PROCESS_START_REFUSED_MESSAGE, type AgentId } from "../../packages/contracts/src/index.js";
import { githubInstallationKey, orgGithubInstallationKey, orgProjectCatalogKey, projectMemberKey, projectMetaKey, projectRevisionKey, setupDraftKey } from "../../packages/contracts/src/index.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, loadSlackBroker } from "../support/slack-broker.js";

const MESSAGE = "This project's way of working can't be used right now. A maintainer can fix it in How we work.";

let createCodeIntentDependencies: typeof BrokerModule.createCodeIntentDependencies;
beforeAll(async () => {
  await loadSlackBroker();
  ({ createCodeIntentDependencies } = await import("../../packages/broker/src/aws/broker.js"));
});

type TaskView = { taskId: string; agent?: { agentId: string; name: string; version: number | string; builtin: boolean } };

async function setup() {
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: { rovaraCodeV2Live: true } } });
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  await store.ensureBuiltinSettings(TEST_ORG, ROVARA_CODE_AGENT_ID);
  /** A project's process layer: a project-owned agent marked as a process that extends Rovara Code; published (version 1) unless told otherwise. */
  const processLayer = async (options: { publish?: boolean; project?: string } = {}): Promise<AgentId> => {
    const created = await store.create({
      orgId: TEST_ORG, name: `payments process ${randomUUID().slice(0, 6)}`, owner: { kind: "project", project: options.project ?? "payments" }, accountable: { developerId: MAYA.developerId },
      extends: ROVARA_CODE_AGENT_ID, overlay: {}, purpose: "process", createdBy: MAYA.developerId,
    });
    if (options.publish !== false) await publishNext(created.agentId);
    return created.agentId;
  };
  const publishNext = async (agentId: AgentId) => {
    const agent = (await store.get(TEST_ORG, agentId))!;
    await store.publish({ orgId: TEST_ORG, agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveAgent(store, TEST_ORG, agentId, "draft")), by: MAYA.developerId });
  };
  /** The project's playbook document, as the PUT writes it. */
  const point = (agentId: AgentId | undefined, project = "payments") => h.db.set({
    ...projectPlaybookKey(TEST_ORG, project), entityType: "PROJECT_PLAYBOOK", orgId: TEST_ORG, revision: 1,
    defaultProcess: agentId === undefined ? { kind: "builtin" } : { kind: "project_process", agentId },
  });
  const send = async (project = "payments") => h.dev(MAYA, "POST", `/v1/app/projects/${project}/code`, { requestId: randomUUID(), input: { text: "Fix the retry bug" }, path: "QUICK" });
  const meta = (taskId: string) => h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { agent?: Record<string, unknown>; sessionId?: string };
  const taskCount = () => h.db.find((item) => item.entityType === "DEVELOPER_TASK").length;
  const sessions = () => h.db.find((item) => item.entityType === "AGENT_SESSION");
  const charges = () => h.db.find((item) => item.entityType === "DEVELOPER_LIMIT" || item.entityType === "SLACK_LIMIT");
  const slackOwner = (owner: string) => {
    const developerId = developerIdForSlackUser(owner);
    seedMembership(h.db, developerId, { orgId: TEST_ORG, role: "member" });
    h.db.set({ ...projectMemberKey(TEST_ORG, developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "contributor" });
  };
  const slackStart = (owner: string, threadTs: string) => h.handler({
    source: "agentx.slack-ingress", action: "start-workflow", thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs }, userId: owner, instructions: "Add a greeting", workflowPath: "QUICK", requestId: randomUUID(),
  });
  return { ...h, store, processLayer, publishNext, point, send, meta, taskCount, sessions, charges, slackOwner, slackStart };
}

describe("starting work from the app", () => {
  it("runs the built-in Rovara Code, with the run request it always had, for a project with no playbook document", async () => {
    const t = await setup();
    const requestId = randomUUID();
    const reply = await t.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId, input: { text: "Fix the retry bug" }, path: "QUICK" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const task = reply.body.task as TaskView;
    expect(t.meta(task.taskId).agent).toMatchObject({ agentId: ROVARA_CODE_AGENT_ID, builtin: true });
    // The stored request fingerprint is the one the run request had before this change: the agent is the id alone, no version and nothing else.
    const stored = (await readRunRequest({ documentClient: t.db, tableName: "state", now: Date.now }, TEST_ORG, requestId))!;
    const before = runRequestFingerprint({
      requestId, orgId: TEST_ORG, project: "payments", agent: { agentId: ROVARA_CODE_AGENT_ID }, input: { text: "Fix the retry bug" }, origin: "app",
      owner: { developerId: MAYA.developerId }, startedBy: { developerId: MAYA.developerId }, payer: stored.payer!, codeIntent: { path: "QUICK" },
    });
    expect(stored.fingerprint).toBe(before);
    // And a repeat of the same request is the first task, as before.
    const again = await t.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId, input: { text: "Fix the retry bug" }, path: "QUICK" });
    expect((again.body.task as TaskView).taskId).toBe(task.taskId);
    expect(t.taskCount()).toBe(1);
  });

  it("runs the built-in for a document that says built-in, and for another project's pointer", async () => {
    const t = await setup();
    const other = await t.processLayer({ project: "ops" });
    t.point(other, "ops");
    t.point(undefined, "payments");
    const reply = await t.send();
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect((reply.body.task as TaskView).taskId).toBeDefined();
    expect(t.meta((reply.body.task as TaskView).taskId).agent).toMatchObject({ agentId: ROVARA_CODE_AGENT_ID, builtin: true });
  });

  it("runs the project's published process layer: the task records its agent id and version, and the task view shows them", async () => {
    const t = await setup();
    const agentId = await t.processLayer();
    t.point(agentId);
    const reply = await t.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text: "Fix the retry bug" }, path: "QUICK" }, { "x-agentx-task-view": "2" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const task = reply.body.task as TaskView;
    expect(task.agent).toMatchObject({ agentId, version: 1, builtin: false });
    expect(t.meta(task.taskId).agent).toMatchObject({ agentId, version: 1, builtin: false });
    expect(t.sessions()).toHaveLength(1);
    // Read back, the same task shows the same process.
    const read = await t.dev(MAYA, "GET", `/v1/dev/tasks/${task.taskId}`, undefined, { "x-agentx-task-view": "2" });
    expect((read.body.task as TaskView).agent).toMatchObject({ agentId, version: 1, builtin: false });
  });

  it("runs the layer's newest published version", async () => {
    const t = await setup();
    const agentId = await t.processLayer();
    t.point(agentId);
    const agent = (await t.store.get(TEST_ORG, agentId))!;
    await t.store.saveDraft({ orgId: TEST_ORG, agentId, overlay: { instructions: "Also run the linter." }, expectedRevision: agent.draftRevision, by: MAYA.developerId });
    await t.publishNext(agentId);
    const reply = await t.send();
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(t.meta((reply.body.task as TaskView).taskId).agent).toMatchObject({ agentId, version: 2, builtin: false });
  });

  it("refuses with the one message when the pointer is to a layer archived since, and starts nothing: no task, no session, no charge", async () => {
    const t = await setup();
    const agentId = await t.processLayer();
    t.point(agentId);
    await t.store.archive(TEST_ORG, agentId, MAYA.developerId);
    const reply = await t.send();
    expect(reply.status).toBe(400);
    expect(reply.body.error).toMatchObject({ code: "PROCESS_UNAVAILABLE", message: MESSAGE });
    expect(PROCESS_START_REFUSED_MESSAGE).toBe(MESSAGE);
    expect(t.taskCount()).toBe(0);
    expect(t.sessions()).toHaveLength(0);
    expect(t.charges()).toHaveLength(0);
  });

  it("refuses for a pointer to a layer with no published version, and for an unreadable document, rather than running the built-in", async () => {
    const t = await setup();
    t.point(await t.processLayer({ publish: false }));
    expect((await t.send()).body.error).toMatchObject({ code: "PROCESS_UNAVAILABLE", message: MESSAGE });
    t.db.set({ ...projectPlaybookKey(TEST_ORG, "payments"), entityType: "PROJECT_PLAYBOOK", orgId: TEST_ORG, revision: 2, defaultProcess: { kind: "somewhere_else" } });
    expect((await t.send()).body.error).toMatchObject({ code: "PROCESS_UNAVAILABLE", message: MESSAGE });
    expect(t.taskCount()).toBe(0);
  });
});

describe("starting work from Slack", () => {
  it("uses the same lookup: a thread started on a project with a process layer runs it", async () => {
    const t = await setup();
    const agentId = await t.processLayer();
    t.point(agentId);
    const owner = "U0SLACKPROC1";
    t.slackOwner(owner);
    const started = await t.slackStart(owner, "1695500000.000931");
    expect(started.statusCode, started.body).toBe(200);
    const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
    expect(t.meta(taskId)).toMatchObject({ origin: "slack", agent: { agentId, version: 1, builtin: false } });
  });

  it("is refused with the message for an archived layer, and starts nothing", async () => {
    const t = await setup();
    const agentId = await t.processLayer();
    t.point(agentId);
    await t.store.archive(TEST_ORG, agentId, MAYA.developerId);
    const owner = "U0SLACKPROC2";
    t.slackOwner(owner);
    const started = await t.slackStart(owner, "1695500000.000932");
    expect(started.statusCode).toBe(400);
    expect(JSON.parse(started.body)).toMatchObject({ error: { code: "PROCESS_UNAVAILABLE", message: MESSAGE } });
    expect(t.taskCount()).toBe(0);
  });
});

describe("a deployment without agents", () => {
  it("starts the plain task as it did and never looks the process up (there are no agents to run one)", async () => {
    const t = await setup();
    const caller = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: MAYA.provider, name: MAYA.name, orgId: TEST_ORG, orgRole: "member" as const };
    const dependencies = createCodeIntentDependencies(t.brokerInput as never, caller)!;
    const plain = vi.fn(async () => ({ task: { taskId: "plain-task" } as never }));
    const lookup = vi.fn(async () => { throw new Error("must not be asked"); });
    await startCodeIntent({ ...dependencies, starter: undefined, startPlainTask: plain, projectProcess: lookup }, caller, { requestId: randomUUID(), project: "payments", input: { text: "Fix the retry bug" }, source: "app", path: "QUICK" });
    expect(plain).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("the setup draft", () => {
  it("still runs the built-in Rovara Code, whatever the project's process is", async () => {
    const BINDING = {
      deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
      subnets: [{ availabilityZone: "us-west-2a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3",
    } as const;
    const h = await createDeveloperTaskBroker({
      register: false,
      brokerExtra: {
        cloud: true, agents: {}, cloudProjects: { runtimeBinding: BINDING, githubCredentialRef: "github-app" },
        githubPullRequests: { reconcilePullRequest: vi.fn(), getPullRequest: vi.fn(), updatePullRequest: vi.fn(), getRepositoryIdentity: vi.fn(async () => undefined) },
        checkRepositoryAccess: vi.fn(async () => undefined),
      },
    });
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const record = {
      installationId: 7, orgId: TEST_ORG, accountLogin: "acme", accountId: 907, accountType: "Organization", repositorySelection: "all", installedByGithubUserId: "gh-1",
      boundByDeveloperId: OMAR.developerId, status: "active", boundAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    };
    h.db.set({ ...orgGithubInstallationKey(TEST_ORG, 7), entityType: "GITHUB_INSTALLATION", ...record });
    h.db.set({ ...githubInstallationKey(7), entityType: "GITHUB_INSTALLATION", ...record });
    h.db.set({
      ...projectRevisionKey(TEST_ORG, "web", 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: BINDING,
      definition: {
        name: "web", revision: 1,
        repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
        setup: [{ cwd: "repo/web", executable: "make", args: ["old-setup"], timeoutSeconds: 900 }], readiness: [{ cwd: "repo/web", executable: "make", args: ["old-test"], timeoutSeconds: 1800 }], orchestratorInstructions: "Delegate work.",
      },
    });
    h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web", latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
    h.db.set({ ...projectMetaKey(TEST_ORG, "web"), entityType: "PROJECT_META", name: "web", status: "active", description: "The site", createdAt: "2026-10-02T00:00:00.000Z", createdBy: MAYA.developerId });
    // The project points at a process layer that is gone: a normal start would be refused, the setup draft is not.
    h.db.set({ ...projectPlaybookKey(TEST_ORG, "web"), entityType: "PROJECT_PLAYBOOK", orgId: TEST_ORG, revision: 1, defaultProcess: { kind: "project_process", agentId: `agt_${"y".repeat(20)}` } });
    const reply = await h.dev(OMAR, "POST", "/v1/app/projects/web/setup-draft", { requestId: randomUUID() });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    const taskId = (h.db.get(setupDraftKey(TEST_ORG, "web")) as { taskId: string }).taskId;
    expect((h.db.get(`DEVTASK#${taskId}`, "META") as { agent?: Record<string, unknown> }).agent).toMatchObject({ agentId: ROVARA_CODE_AGENT_ID, builtin: true });
  });
});
