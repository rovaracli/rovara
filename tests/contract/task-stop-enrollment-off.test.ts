import { expect, it } from "vitest";
import { projectAiKey } from "@agentx/contracts";
import { createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { TEST_ORG } from "../support/orgs.js";
it("unenrolled project registration preserves absent AI settings and emits no M47 seed audit", async () => {
 const audit = capturingAuditDeps(), h = await createDeveloperTaskBroker({ audit });
 expect(h.db.get(projectAiKey(TEST_ORG, "payments"))).toBeUndefined();
 expect(audit.recordedBy("spending.policy_seeded")).toEqual([]);
});

it("ready registration seeds inheritance and fences the company snapshot", async () => {
 const { orgSettingsKey } = await import("@agentx/contracts"), { registerSlackProject } = await import("../support/slack-broker.js");
 const h = await createDeveloperTaskBroker({ register: false }), key = orgSettingsKey(TEST_ORG, "TASK_STOP_POLICY");
 h.db.set({ ...key, orgId: TEST_ORG, entityType: "ORG_TASK_STOP_POLICY", revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 1 } }, enrollment: { version: 1, state: "ready" }, enrollmentReview: { reviewId: "r", digest: "d".repeat(64), sourceDigest: "e".repeat(64), by: "a".repeat(64), at: new Date().toISOString(), tasksReviewed: 0 } });
 const before = h.db.transactions().length;await registerSlackProject(h.handler, { bind: false });
 const transactions = h.db.transactions().slice(before);
 expect(h.db.get(projectAiKey(TEST_ORG, "payments"))).toMatchObject({ taskStopPolicy: { schemaVersion: 2, kind: "inherit" } });
 expect(transactions.some(items => items.some(item => (item.ConditionCheck as { Key?: { pk?: string; sk?: string } } | undefined)?.Key?.pk === key.pk && (item.ConditionCheck as { Key?: { sk?: string } }).Key?.sk === key.sk))).toBe(true);
 expect(transactions.flat().some(item => (item.Put as { Item?: { entityType?: string } } | undefined)?.Item?.entityType === "PROJECT_AI")).toBe(true);
 // The newly registered project needs no manual Spending repair to cancel/review/enable.
 const { randomUUID } = await import("node:crypto"), { MAYA } = await import("../support/developer-task-broker.js");
 const { BUILTIN_AGENT_IDS, builtinSettingsKey, orgMemberKey, developerOrgKey, orgMetaKey, agentGuardrailsKey, DEFAULT_AGENT_GUARDRAILS, orgScoped } = await import("@agentx/contracts");
 const { reviewTaskStopEnrollment, writeTaskStopEnrollment } = await import("../../packages/broker/src/org/task-stop-enrollment.js");
 const now = Date.now(), audit = capturingAuditDeps({ db: h.db });audit.audit.documentClient = h.db as never;
 h.db.set({ ...orgMemberKey(TEST_ORG, MAYA.developerId), orgId: TEST_ORG, developerId: MAYA.developerId, role: "owner" });
 h.db.set({ ...developerOrgKey(MAYA.developerId), orgId: TEST_ORG, role: "owner" });h.db.set({ ...orgMetaKey(TEST_ORG), orgId: TEST_ORG });
 h.db.set({ pk: `DEVELOPER#${MAYA.developerId}`, sk: "META", developerId: MAYA.developerId, provider: "cloud", revoked: false });
 h.db.set({ ...h.db.get({ pk: `SESSION#${MAYA.sessionId}`, sk: "META" })!, authTime: new Date(now - 60_000).toISOString() });
 for (const id of BUILTIN_AGENT_IDS) h.db.set({ ...builtinSettingsKey(TEST_ORG, id), orgId: TEST_ORG, entityType: "BUILTIN_AGENT_SETTINGS", agentId: id, revision: 1, stopKind: "inherit" });
 h.db.set({ ...agentGuardrailsKey(TEST_ORG), orgId: TEST_ORG, entityType: "AGENT_GUARDRAILS", revision: 1, guardrails: DEFAULT_AGENT_GUARDRAILS });
 h.db.set({ pk: orgScoped(TEST_ORG, "TASK_STOP_SEED"), sk: "V1#bootstrap", orgId: TEST_ORG, entityType: "TASK_STOP_SEED", version: 1, source: "bootstrap", outcome: "created", policyRevision: 1 });
 const deps = { documentClient: h.db, tableName: "state", now: () => now, audit: audit.audit, developer: { issuer: "https://cell.example", env: "test", signInTableName: "signin", methods: { cloud: true, slack: false, oidc: false }, verifyAccessToken: async () => ({}), channelMembers: async () => ({ ok: true as const, memberOf: [] }) } };
 const caller = { orgId: TEST_ORG, developerId: MAYA.developerId, orgRole: "owner" as const, name: MAYA.name, amr: "cloud" as const, sessionId: MAYA.sessionId };
 await writeTaskStopEnrollment(deps, caller, { requestId: randomUUID(), expectedRevision: 2, state: "disabled" });
 const review = await reviewTaskStopEnrollment(deps, caller, { requestId: randomUUID(), expectedRevision: 3 });
 const terms = { reviewId: review.reviewId, expectedReviewDigest: review.digest };
 await writeTaskStopEnrollment(deps, caller, { requestId: randomUUID(), expectedRevision: 3, state: "ready", ...terms });
 expect(await writeTaskStopEnrollment(deps, caller, { requestId: randomUUID(), expectedRevision: 4, state: "enabled", ...terms })).toMatchObject({ state: "enabled", revision: 5 });

});
it("registration racing ready-to-enabled refuses then retry seeds inheritance", async () => {
 const { orgSettingsKey } = await import("@agentx/contracts"), { registerSlackProject } = await import("../support/slack-broker.js"), { TransactWriteCommand } = await import("@aws-sdk/lib-dynamodb");
 const h = await createDeveloperTaskBroker({ register: false }), key = orgSettingsKey(TEST_ORG, "TASK_STOP_POLICY");
 h.db.set({ ...key, orgId: TEST_ORG, entityType: "ORG_TASK_STOP_POLICY", revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 1 } }, enrollment: { version: 1, state: "ready" } });
 const send = h.db.send.bind(h.db);let raced = false;
 h.db.send = async command => {
  if (!raced && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "PROJECT")) { raced = true;h.db.set({ ...h.db.get(key)!, revision: 3, enrollment: { version: 1, state: "enabled" } }); }
  return send(command);
 };
 await expect(registerSlackProject(h.handler, { bind: false })).rejects.toThrow("PROJECT_REVISION_MISMATCH");expect(raced).toBe(true);
 expect(h.db.get(projectAiKey(TEST_ORG, "payments"))).toBeUndefined();
 await registerSlackProject(h.handler, { bind: false });expect(h.db.get(projectAiKey(TEST_ORG, "payments"))).toMatchObject({ taskStopPolicy: { schemaVersion: 2, kind: "inherit" } });
});

it("disabled registration is unaffected by an unrelated company policy edit", async () => {
 const { orgSettingsKey } = await import("@agentx/contracts"), { registerSlackProject } = await import("../support/slack-broker.js"), { TransactWriteCommand } = await import("@aws-sdk/lib-dynamodb");
 const h = await createDeveloperTaskBroker({ register: false }), key = orgSettingsKey(TEST_ORG, "TASK_STOP_POLICY");
 h.db.set({ ...key, orgId: TEST_ORG, entityType: "ORG_TASK_STOP_POLICY", revision: 1, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 1 } }, enrollment: { version: 1, state: "disabled" } });
 const send = h.db.send.bind(h.db);let edited = false;
 h.db.send = async command => {
  if (!edited && command instanceof TransactWriteCommand && command.input.TransactItems?.some(item => item.Put?.Item?.entityType === "PROJECT")) { edited = true;h.db.set({ ...h.db.get(key)!, revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 2 } } }); }
  return send(command);
 };
 await registerSlackProject(h.handler, { bind: false });expect(edited).toBe(true);
 expect(h.db.get(projectAiKey(TEST_ORG, "payments"))).toBeUndefined();expect(h.db.get(key)?.revision).toBe(2);
});
