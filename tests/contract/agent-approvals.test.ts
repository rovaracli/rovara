// Plan 3 Task 7 (PF18): the approvals core. A pending change is one APPROVAL# record with its open and approver index items;
// deciding it is Task 21 and Task 21a's.
import { readFileSync } from "node:fs";
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
import { listedFor } from "../../packages/broker/src/agents/approvals-store.js";
import type { OrgId } from "@rovara-code/contracts";
import { approvalKey, approverIndexKey, openApprovalKey } from "@rovara-code/contracts";
import { CHANGE_APPROVAL_TTL_DAYS } from "../../packages/cloud-contracts/src/spend.js";
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
    expect(Date.parse(record.expiresAt) - START).toBe(CHANGE_APPROVAL_TTL_DAYS * 86_400_000);
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
    expect(await code(createPendingChange(deps, input({ subject: { ...SUBJECT, draftRevision: 4 } })))).toMatchObject({ code: "CONFIG_INVALID", message: "requestId: this request ID was already used for a different request" });
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

// Final fix wave, access m-3: the cap of 90 listed approvers never drops the person the approval is about.
describe("the cap on listed approvers keeps the people a mover finds an approval through", () => {
  const many = Array.from({ length: 120 }, (_, index) => index.toString(16).padStart(64, "0"));

  it("a change keeps its first candidate (the agent's owner) and its requester, whatever their ids sort to", async () => {
    const { db, deps } = setup();
    const owner = many[119]!;
    const requester = many[118]!;
    const candidates = [owner, ...many.slice(0, 119)];
    const record = await createPendingChange(deps, input({ requestedBy: requester, approvers: { kind: "rule", rule: "test_rule", candidates } }));
    const indexed = db.find((item) => item.entityType === "APPROVER_INDEX").map((item) => item.pk);
    expect(indexed).toHaveLength(90);
    expect(indexed).toContain(approverIndexKey(ORG_A, owner, record.approvalId).pk);
    expect(indexed).toContain(approverIndexKey(ORG_A, requester, record.approvalId).pk);
    // Ending the approval drops exactly the items that were written.
    expect(listedFor(record)).toHaveLength(90);
    expect(listedFor(record)).toEqual(expect.arrayContaining([owner, requester]));
  });

  it("a write or a step keeps the run's owner first, though the owner sorts after everyone else", () => {
    const owner = many[119]!;
    for (const kind of ["write", "step"] as const) {
      const listed = listedFor({ kind, approvers: { kind: "rule", rule: "test_rule", candidates: many }, owner: { developerId: owner } });
      expect(listed[0], kind).toBe(owner);
      expect(listed.length, kind).toBeLessThanOrEqual(88);
    }
  });
});

describe("getApproval validates what it reads", () => {
  it("answers a record that is not shaped like an approval as missing", async () => {
    const { db, deps } = setup();
    const record = await createPendingChange(deps, input());
    expect(CHANGE_APPROVAL_TTL_DAYS).toBe(7);
    // Both constants are 7 today; the source says which one a change approval's expiry follows, so the write TTL can move alone.
    const source = readFileSync("packages/broker/src/agents/approvals-store.ts", "utf8");
    expect(source).toContain("CHANGE_APPROVAL_TTL_DAYS");
    expect(source).not.toContain("WRITE_APPROVAL_TTL_DAYS");
    db.set({ ...approvalKey(ORG_A, record.approvalId), entityType: "APPROVAL", orgId: ORG_A, approvalId: record.approvalId, kind: "change", subject: "nope", status: "SOMETHING" });
    expect(await getApproval(deps, ORG_A, record.approvalId)).toBeUndefined();
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
