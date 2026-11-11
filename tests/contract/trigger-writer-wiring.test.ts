// Plan 4 Task 18 (hand-off M-1 of the Task 7 and 8 review): the trigger store reaches the autonomous write rule through the REAL broker wiring, on both paths a decision takes.
// The ticket path (`POST /v1/app/approvals/{id}/confirm-link`, which mints a decide ticket only for someone who may decide) and the decide path (the confirmation page,
// which runs `decideApproval`). The creator of the trigger that started an event run holds only `start_tasks` on the project, so only the rule's (a) lets them in, and
// (a) reads the trigger's creator now: after a trigger moves, the new creator decides and the old one does not. Nothing here uses the chain-gate world.
import { createHash, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { approvalKey, chainRunKey, orgProjectCatalogKey, projectMetaKey, projectRevisionKey, type ConnectorResult, type GrantedTool, type ToolFacts } from "@rovara-code/contracts";
import { registerAgentApprovals } from "../../packages/broker/src/agents/changes.js";
import { memoryRunCache } from "../../packages/broker/src/agents/run-cache.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { decideWrite, type ClassifyContext, type WriteGateRuntime } from "../../packages/broker/src/agents/write-gate.js";
import type { ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";
import type { ClassifyAgentWriteDependencies } from "../../packages/broker/src/agents/write-class.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor } from "../../packages/broker/src/developer/decide-session.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { TriggerStore } from "../../packages/broker/src/triggers/store.js";
import { DEV_ISSUER, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });

const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // org admin
const MAX = person("2", "Max"); // maintainer of web
const CARL = person("3", "Carl"); // contributor on web: created the trigger
const PRIYA = person("4", "Priya"); // contributor on web: did not
const CELL = new URL(DEV_ISSUER).origin;
const TASK = "11111111-1111-4111-8111-111111111111";
const RUN = `crn_${"r".repeat(20)}`;
const TRIGGER = `ctr_${"t".repeat(20)}`;
const CHAIN = `chn_${"c".repeat(20)}`;
const CONNECTION = "con_aaaaaaaaaaaaaaaaaaaa";
const TEAM = "c408e946-78aa-4db8-923e-f78053dd954f";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const SAVE_ISSUE: GrantedTool = {
  connector: "linear", type: "linear", upstreamName: "save_issue", presentedName: "linear__save_issue", access: "write",
  facts: { connector: "linear", upstreamName: "save_issue", access: "write", itemArguments: ["id"] } satisfies ToolFacts,
};
const CLASSIFY: ClassifyContext = { rules: { alwaysAsk: [] }, autonomy: "run", allowMentions: false };

/** The real broker with the confirmation page, an event-started run of a project-owned chain, the trigger that started it and a write the run's step waits to make. */
async function brokerWorld() {
  const members = new FakeProjectMembers();
  const h = await createDeveloperTaskBroker({ register: false, brokerExtra: { agents: { projectMembers: members }, decide: {} } });
  for (const [who, role] of [[DANA, "admin"], [MAX, "member"], [CARL, "member"], [PRIYA, "member"]] as const) {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId: TEST_ORG, role });
  }
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "web"), entityType: "PROJECT_CATALOG", name: "web" });
  h.db.set({ ...projectMetaKey(TEST_ORG, "web"), entityType: "PROJECT_META", name: "web", status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: DANA.developerId });
  h.db.set({
    ...projectRevisionKey(TEST_ORG, "web", 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z", runtimeBinding: { deploymentMode: "ec2-ebs" },
    definition: {
      name: "web", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [{ cwd: "repo/web", executable: "npm", args: ["ci"], timeoutSeconds: 900 }], readiness: [{ cwd: "repo/web", executable: "npm", args: ["test"], timeoutSeconds: 900 }], orchestratorInstructions: "Delegate work.",
      integrations: { connectors: [{ name: "linear", type: "linear", credentialRef: CONNECTION, scopes: [{ alias: "eng", teamId: TEAM }], tools: [{ name: "save_issue", access: "write" }] }] },
    },
  });
  members.grant(TEST_ORG, "web", MAX.developerId, "maintainer");
  members.grant(TEST_ORG, "web", CARL.developerId, "contributor");
  members.grant(TEST_ORG, "web", PRIYA.developerId, "contributor");
  registerAgentApprovals();

  // The run, its task and the trigger, as the trigger code and the runner leave them in the broker's own table.
  const triggers = new TriggerStore({ documentClient: h.db, tableName: "state", now: Date.now });
  await triggers.create({
    record: { orgId: TEST_ORG, triggerId: TRIGGER, target: { kind: "chain", chainId: CHAIN }, project: "web", spec: { kind: "event", source: "sentry", type: "issue.created" }, hookId: `hk_${"h".repeat(26)}`, enabled: true, maxRunsPerHour: 30, createdBy: CARL.developerId },
  });
  h.db.set({
    ...chainRunKey(TEST_ORG, RUN, "META"), entityType: "CHAIN_RUN", orgId: TEST_ORG, runId: RUN, chainId: CHAIN, project: "web", chainOwner: { kind: "project", project: "web" }, owner: { developerId: CARL.developerId },
    startedBy: { kind: "event", triggerId: TRIGGER, eventKey: "sentry:1", source: "sentry", type: "issue.created", title: "Refund errors" }, status: "running",
  });
  h.db.set({
    ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: TEST_ORG, developerId: CARL.developerId, developerName: "Carl", provider: "oidc", project: "web", workspaceId: "ws-1",
    ownerKey: "owner-key-carl", createdAt: "2026-10-22T08:00:00.000Z", updatedAt: "2026-10-22T08:00:00.000Z", chain: { chainRunId: RUN, stepId: "work" },
  });

  // The write waits for approval under Plan 3's own rule, then is named for the autonomous rule the selector would have chosen for this run.
  const store = new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now });
  const runtime: WriteGateRuntime = {
    classify: { documentClient: h.db, tableName: "state", now: Date.now, labelListers: {}, runCache: () => memoryRunCache() } as unknown as ClassifyAgentWriteDependencies,
    runConnector: async (call): Promise<ConnectorResult> => ({ requestId: call.request.requestId, status: "SUCCEEDED", text: JSON.stringify({ id: "CHA-9" }), truncated: false, replayed: false }),
    regrant: async () => ({ tool: SAVE_ISSUE, classify: CLASSIFY }),
    recordedResult: async () => undefined,
    requireRunAuthority: async () => undefined,
  };
  const deps: ApprovalDependencies = {
    store, projectMembers: members, documentClient: h.db, tableName: "state", signInStore: new DeveloperSignInStore({ documentClient: h.db, tableName: "signin", now: Date.now }),
    now: Date.now, confirmOrigin: CELL, writeGate: runtime, log: () => undefined,
  };
  const decision = await decideWrite(deps, {
    orgId: TEST_ORG, taskId: TASK, operationId: "22222222-2222-4222-8222-222222222222", stepId: "work", agentId: "agt_00000000000000000007", agentName: "Triage bot", tool: SAVE_ISSUE,
    call: { scope: "eng", schemaHash: "a".repeat(64), arguments: { id: "ENG-12", stateId: "s1" } }, classify: CLASSIFY, run: { project: "web", owner: { developerId: CARL.developerId, name: "Carl" } },
  });
  if (decision.outcome !== "wait") throw new Error(`expected a wait, got ${JSON.stringify(decision)}`);
  const approvalId = decision.approvalId;
  const key = approvalKey(TEST_ORG, approvalId);
  const stored = h.db.get(key.pk, key.sk)!;
  h.db.set({ ...stored, approvers: { kind: "rule", rule: "chain_autonomous_writer", candidates: [CARL.developerId, DANA.developerId, MAX.developerId] } });
  const status = () => (h.db.get(key.pk, key.sk) as { status: string }).status;
  const decideStore = new DecideStore({ documentClient: h.db, tableName: "signin", now: Date.now });
  const session = async (who: Developer) => {
    const cookie = `cookie-${randomUUID()}-${"x".repeat(20)}`;
    const signedInAt = Math.floor(Date.now() / 1000) - 30;
    await decideStore.putSession(cookie, { orgId: TEST_ORG, developerId: who.developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
    return cookie;
  };
  const raw = async (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
    h.handler({ version: "2.0", rawPath: path.split("?")[0], rawQueryString: path.split("?")[1] ?? "", headers, ...(body === undefined ? {} : { body }), requestContext: { requestId: randomUUID(), http: { method } } }) as Promise<{ statusCode: number; body: string }>;
  const page = async (who: Developer, decisionWord: "approve" | "decline" = "approve") => {
    const cookie = await session(who);
    const headers = { cookie: `${DECIDE_COOKIE}=${cookie}`, origin: CELL, "content-type": "application/x-www-form-urlencoded" };
    return raw("POST", `/v1/app/approve/${approvalId}`, headers, new URLSearchParams({ decision: decisionWord, csrf: csrfTokenFor(cookie) }).toString());
  };
  const confirmLink = (who: Developer) => h.dev(who, "POST", `/v1/app/approvals/${approvalId}/confirm-link`, {});
  const moveTrigger = async (to: Developer) => {
    const trigger = (await triggers.get(TEST_ORG, TRIGGER))!;
    await triggers.update({ trigger, patch: { createdBy: to.developerId } });
  };
  return { ...h, members, approvalId, status, page, confirmLink, moveTrigger, raw, session };
}

describe("the creator of the trigger that started an event run, through the real broker", () => {
  it("gets a decide ticket on the token path, and decides on the page, as a contributor of the project", async () => {
    const b = await brokerWorld();
    const asked = await b.confirmLink(CARL);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body).toMatchObject({ ticketed: true, confirmUrl: expect.stringMatching(new RegExp(`^${CELL}/v1/app/approve/${b.approvalId}\\?ticket=[A-Za-z0-9_-]{43}$`)) as string });
    expect(b.status()).toBe("PENDING");
    const done = await b.page(CARL);
    expect(done.statusCode, done.body).toBe(200);
    expect(b.status()).not.toBe("PENDING");
    expect(b.status()).not.toBe("DECLINED");
  });

  it("keeps a contributor who did not create the trigger out on both paths, with no ticket and a refused decision", async () => {
    const b = await brokerWorld();
    const asked = await b.confirmLink(PRIYA);
    expect(asked.body).not.toMatchObject({ ticketed: true });
    expect(b.db.find((item) => String(item.pk).startsWith("DECIDE_TICKET#"))).toEqual([]);
    const refused = await b.page(PRIYA);
    expect(refused.statusCode).not.toBe(200);
    expect(b.status()).toBe("PENDING");
  });

  it("follows the trigger when it moves: the new creator gets the ticket and decides, the old one does not", async () => {
    const b = await brokerWorld();
    await b.moveTrigger(PRIYA);
    expect((await b.confirmLink(CARL)).body).not.toMatchObject({ ticketed: true });
    expect((await b.page(CARL)).statusCode).not.toBe(200);
    expect(b.status()).toBe("PENDING");
    expect((await b.confirmLink(PRIYA)).body).toMatchObject({ ticketed: true });
    const done = await b.page(PRIYA);
    expect(done.statusCode, done.body).toBe(200);
    expect(b.status()).not.toBe("PENDING");
  });

  it("still lets every maintainer of the project decide, and a trigger that is gone leaves only them", async () => {
    const b = await brokerWorld();
    const trigger = (await new TriggerStore({ documentClient: b.db, tableName: "state", now: Date.now }).get(TEST_ORG, TRIGGER))!;
    await new TriggerStore({ documentClient: b.db, tableName: "state", now: Date.now }).delete({ trigger });
    expect((await b.confirmLink(CARL)).body).not.toMatchObject({ ticketed: true });
    expect((await b.confirmLink(MAX)).body).toMatchObject({ ticketed: true });
  });
});
