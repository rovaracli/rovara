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

it("ready registration adds a cutover condition without adding any task-stop item", async () => {
 const { orgSettingsKey } = await import("@agentx/contracts"), { registerSlackProject } = await import("../support/slack-broker.js");
 const h = await createDeveloperTaskBroker({ register: false }), key = orgSettingsKey(TEST_ORG, "TASK_STOP_POLICY");
 h.db.set({ ...key, orgId: TEST_ORG, entityType: "ORG_TASK_STOP_POLICY", revision: 2, policy: { schemaVersion: 2, defaultPolicy: { kind: "limited", stopMicrousd: 1 } }, enrollment: { version: 1, state: "ready" }, enrollmentReview: { reviewId: "r", digest: "d".repeat(64), sourceDigest: "e".repeat(64), by: "a".repeat(64), at: new Date().toISOString(), tasksReviewed: 0 } });
 const before = h.db.transactions().length;await registerSlackProject(h.handler, { bind: false });
 const transactions = h.db.transactions().slice(before);
 expect(h.db.get(projectAiKey(TEST_ORG, "payments"))).toBeUndefined();
 expect(transactions.some(items => items.some(item => (item.ConditionCheck as { Key?: { pk?: string; sk?: string } } | undefined)?.Key?.pk === key.pk && (item.ConditionCheck as { Key?: { sk?: string } }).Key?.sk === key.sk))).toBe(true);
 expect(transactions.flat().some(item => (item.Put as { Item?: { entityType?: string } } | undefined)?.Item?.entityType === "PROJECT_AI")).toBe(false);
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
