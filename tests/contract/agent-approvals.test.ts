// Plan 3 Task 7 (PF18): the approvals core. A pending change is one APPROVAL# record with its open and approver index items;
// deciding it is Task 21 and Task 21a's.
import { describe, expect, it } from "vitest";
import {
  confirmUrlFor,
  createPendingChange,
  getApproval,
  getApprovalSubjectHandler,
  getApproverRule,
  registerApprovalSubjectHandler,
  registerApproverRule,
  type ApprovalStoreDependencies,
  type ApproverSpec,
  type ChangeSubject,
} from "../../packages/broker/src/agents/approvals.js";
import type { OrgId } from "../../packages/contracts/src/org.js";
import { approvalKey, approverIndexKey, openApprovalKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { WRITE_APPROVAL_TTL_DAYS } from "../../packages/contracts/src/spend.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const START = Date.parse("2026-10-20T09:00:00.000Z");
const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);
const CAROL = "c".repeat(64);
const REQUEST = "11111111-1111-4111-8111-111111111111";
const SUBJECT: ChangeSubject = { kind: "agent_publish", agentId: "agt_00000000000000000001", draftRevision: 3, digest: "d".repeat(64), expectedCurrentVersion: 1 };

const setup = () => {
  const db = new FakeDynamoDb();
  const deps: ApprovalStoreDependencies = { documentClient: db, tableName: "T", now: () => START };
  registerApproverRule("test_rule", async () => true);
  registerApprovalSubjectHandler("agent_publish", async () => undefined);
  registerApprovalSubjectHandler("agent_rollback", async () => undefined);
  return { db, deps };
};
const input = (overrides: Record<string, unknown> = {}) => ({
  orgId: ORG_A, requestId: REQUEST, requestedBy: ALICE, subject: SUBJECT, changes: ["Raises the agent's autonomy from prepare to run"],
  approvers: { kind: "rule" as const, rule: "test_rule", candidates: [BOB, CAROL, ALICE] }, ...overrides,
});
const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message.replace(`${String(error.code)}: `, "") }));

describe("createPendingChange", () => {
  it("writes the record, the open index item and one approver item per candidate", async () => {
    const { db, deps } = setup();
    const record = await createPendingChange(deps, input());
    expect(record).toMatchObject({
      orgId: ORG_A, kind: "change", subject: SUBJECT, status: "PENDING", requestedBy: ALICE,
      changes: ["Raises the agent's autonomy from prepare to run"], approvers: { kind: "rule", rule: "test_rule", candidates: [BOB, CAROL, ALICE] },
      createdAt: "2026-10-20T09:00:00.000Z",
    });
    expect(record.approvalId).toMatch(/^apr_[0-9a-z]{20}$/);
    expect(Date.parse(record.expiresAt) - START).toBe(WRITE_APPROVAL_TTL_DAYS * 86_400_000);
    expect(db.get(approvalKey(ORG_A, record.approvalId))).toMatchObject({ entityType: "APPROVAL", approvalId: record.approvalId, status: "PENDING" });
    expect(db.get(openApprovalKey(record.expiresAt, ORG_A, record.approvalId))).toMatchObject({ orgId: ORG_A, approvalId: record.approvalId });
    for (const developerId of [ALICE, BOB, CAROL]) {
      expect(db.get(approverIndexKey(ORG_A, developerId, record.approvalId)), developerId).toMatchObject({ approvalId: record.approvalId });
    }
    expect(db.find((item) => item.entityType === "APPROVER_INDEX")).toHaveLength(3);
    // The open index holds ids only, never the change.
    expect(Object.keys(db.get(openApprovalKey(record.expiresAt, ORG_A, record.approvalId)) ?? {}).sort()).toEqual(["approvalId", "entityType", "orgId", "pk", "sk"]);
  });

  it("lists the people an id approval names", async () => {
    const { db, deps } = setup();
    const record = await createPendingChange(deps, input({ approvers: { kind: "ids", ids: [BOB, BOB] } }));
    expect(db.find((item) => item.entityType === "APPROVER_INDEX").map((item) => item.pk)).toEqual([approverIndexKey(ORG_A, BOB, record.approvalId).pk]);
  });

  it("answers a replay of the same request with the same record and writes nothing more", async () => {
    const { db, deps } = setup();
    const first = await createPendingChange(deps, input());
    const items = db.find(() => true).length;
    const again = await createPendingChange(deps, input());
    expect(again).toEqual(first);
    expect(db.find(() => true)).toHaveLength(items);
  });

  it("refuses a request id used for another change, and treats another person's or org's as its own", async () => {
    const { deps } = setup();
    const first = await createPendingChange(deps, input());
    expect(await code(createPendingChange(deps, input({ subject: { ...SUBJECT, draftRevision: 4 } })))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await createPendingChange(deps, input({ requestedBy: BOB }))).approvalId).not.toBe(first.approvalId);
    expect((await createPendingChange(deps, input({ orgId: ORG_B }))).approvalId).not.toBe(first.approvalId);
  });

  it("refuses to wait on a rule or a kind nobody registered", async () => {
    const { deps } = setup();
    expect(await code(createPendingChange(deps, input({ approvers: { kind: "rule", rule: "nobody_registered", candidates: [] } })))).toEqual({
      code: "CONFIG_INVALID", message: 'no one can decide this: the rule "nobody_registered" is not registered',
    });
    expect(await code(createPendingChange(deps, input({ subject: { kind: "opt_out" } })))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("keeps the org apart: the same approval id in another org is not found", async () => {
    const { deps } = setup();
    const record = await createPendingChange(deps, input());
    expect((await getApproval(deps, ORG_A, record.approvalId))?.approvalId).toBe(record.approvalId);
    expect(await getApproval(deps, ORG_B, record.approvalId)).toBeUndefined();
  });

  it("lists at most 90 people and honours an earlier expiry", async () => {
    const { db, deps } = setup();
    const many = Array.from({ length: 120 }, (_, index) => index.toString(16).padStart(64, "0"));
    const record = await createPendingChange(deps, input({ approvers: { kind: "rule", rule: "test_rule", candidates: many }, expiresAt: "2026-10-21T00:00:00.000Z" }));
    expect(db.find((item) => item.entityType === "APPROVER_INDEX")).toHaveLength(90);
    expect(record.expiresAt).toBe("2026-10-21T00:00:00.000Z");
    // The record still names every candidate: the index only decides who sees it listed.
    expect((record.approvers as Extract<ApproverSpec, { kind: "rule" }>).candidates).toHaveLength(120);
  });
});

describe("the registries", () => {
  it("hands back what was registered, and nothing for what was not", () => {
    const rule = async () => true;
    const handler = async () => undefined;
    registerApproverRule("registry_rule", rule);
    registerApprovalSubjectHandler("guardrails", handler);
    expect(getApproverRule("registry_rule")).toBe(rule);
    expect(getApprovalSubjectHandler("guardrails")).toBe(handler);
    expect(getApproverRule("never_registered")).toBeUndefined();
    expect(getApprovalSubjectHandler("opt_out")).toBeUndefined();
  });

  it("gives the page's link for an approval", () => {
    expect(confirmUrlFor({ confirmOrigin: "https://cell.example.com" }, { approvalId: "apr_00000000000000000009" })).toBe("https://cell.example.com/v1/app/approve/apr_00000000000000000009");
  });
});
