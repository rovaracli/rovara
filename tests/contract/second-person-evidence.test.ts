import { describe, expect, it } from "vitest";
import { TransactWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { orgMetaKey, orgMemberKey, developerOrgKey, projectMetaKey, projectMemberKey, type OrgId } from "../../packages/contracts/src/index.js";
import { readSecondPersonApprovalEvidence } from "../../packages/broker/src/org/second-person-evidence.js";
import { decideSecondPersonApproval } from "../../packages/broker/src/org/second-person-approval.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const owner = "a".repeat(64), admin = "b".repeat(64), member = "c".repeat(64);
const at = "2026-10-29T21:00:00.000Z";
function fixture() {
 const db = new FakeDynamoDb();
 db.set({ ...orgMetaKey(orgId), orgId, entityType: "ORG", createdAt: "2026-10-01T00:00:00.000Z", approvalMembershipVersion: 7, approvalTrackingSince: "2026-10-01T00:00:00.000Z" });
 db.set({ ...projectMetaKey(orgId, "payments"), entityType: "PROJECT_META", name: "payments", status: "active", createdAt: "2026-10-01T00:00:00.000Z", archiveRevision: 0 });
 function person(id: string, role: "owner" | "admin" | "member") {
  db.set({ ...orgMemberKey(orgId, id), orgId, developerId: id, role, joinedAt: "2026-10-01T00:00:00.000Z" });
  db.set({ ...developerOrgKey(id), orgId, role });
  db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, revoked: false });
 }
 person(owner, "owner");
 const deps = { documentClient: db, tableName: "state", signInTableName: "signin", now: () => Date.parse(at) };
 const read = (approverId = owner) => readSecondPersonApprovalEvidence(deps, { orgId, project: "payments", proposerId: owner, approverId });
 return { db, deps, person, read };
}

describe("live shared approval evidence", () => {
 it("accepts distinct live company people using server evidence", async () => {
  const f = fixture();f.person(admin, "admin");
  const proof = await f.read(admin);
  expect(decideSecondPersonApproval(proof.decisionInput).mode).toBe("second_person");
 });
 it("permits a sole-owner exception only with complete eligibility and history", async () => {
  const f = fixture();const proof = await f.read();
  expect(decideSecondPersonApproval(proof.decisionInput).mode).toBe("sole_owner_exception");
 });
 it("refuses the exception when another live project maintainer could approve", async () => {
  const f = fixture();f.person(member, "member");
  f.db.set({ ...projectMemberKey(orgId, member, "payments"), ownerKey: member, projectName: "payments", role: "developer", projectRole: "maintainer", grantId: "grant" });
  const proof = await f.read();expect(() => decideSecondPersonApproval(proof.decisionInput)).toThrow();
 });
 it("refuses an approver whose global identity was revoked", async () => {
  const f = fixture();f.person(admin, "admin");f.db.set({ pk: `DEVELOPER#${admin}`, sk: "META", developerId: admin, revoked: true });
  await expect(f.read(admin)).rejects.toMatchObject({ code: "FORBIDDEN" });
 });
 it("cannot infer 24-hour history from a newly initialized legacy counter", async () => {
  const f = fixture();f.db.set({ ...f.db.get(orgMetaKey(orgId)), approvalTrackingSince: at });
  const proof = await f.read();expect(() => decideSecondPersonApproval(proof.decisionInput)).toThrow();
 });
 it("refuses a recent company eligibility loss", async () => {
  const f = fixture();f.db.set({ ...f.db.get(orgMetaKey(orgId)), approvalLastCompanyEligibleLossAt: "2026-10-29T20:59:00.000Z" });
  const proof = await f.read();expect(() => decideSecondPersonApproval(proof.decisionInput)).toThrow();
 });
 it("supplies transaction conditions that stop a later generation without a partial change", async () => {
  const f = fixture();f.person(admin, "admin");const proof = await f.read(admin);
  f.db.set({ ...f.db.get(orgMetaKey(orgId)), approvalMembershipVersion: 8 });
  await expect(f.db.send(new TransactWriteCommand({ TransactItems: [...proof.conditions, { Put: { TableName: "state", Item: { pk: "CHANGE", sk: "RESULT" } } }] }))).rejects.toMatchObject({ name: "TransactionCanceledException" });
  expect(f.db.get({ pk: "CHANGE", sk: "RESULT" })).toBeUndefined();
 });
});

it("does not mistake an old session-end timestamp for a later global revocation time", async () => {
 const f = fixture();f.person(admin, "admin");
 f.db.set({ pk: `DEVELOPER#${admin}`, sk: "META", developerId: admin, revoked: true, sessionsEndedAt: "2026-10-01T00:00:00Z" });
 const proof = await f.read();expect(() => decideSecondPersonApproval(proof.decisionInput)).toThrow();
});
it("retains project-specific eligibility loss for the sole-owner cool-off", async () => {
 const f = fixture();f.db.set({ ...f.db.get(projectMetaKey(orgId, "payments")), approvalLastMaintainerLossAt: at });
 const proof = await f.read();expect(() => decideSecondPersonApproval(proof.decisionInput)).toThrow();
});
it("fences a global identity revocation after evidence was read", async () => {
 const f = fixture();f.person(admin, "admin");const proof = await f.read(admin);
 f.db.set({ ...f.db.get({ pk: `DEVELOPER#${admin}`, sk: "META" }), revoked: true });
 await expect(f.db.send(new TransactWriteCommand({ TransactItems: [...proof.conditions, { Put: { TableName: "state", Item: { pk: "CHANGE", sk: "RESULT" } } }] }))).rejects.toMatchObject({ name: "TransactionCanceledException" });
 expect(f.db.get({ pk: "CHANGE", sk: "RESULT" })).toBeUndefined();
});


it("refuses a directory cursor outside the company's member partition", async () => {
 const f = fixture(), send = f.db.send.bind(f.db);let first = true;
 f.db.send = async command => {
  const result = await send(command);
  if (first && command instanceof QueryCommand) { first = false;return { ...(result as Record<string, unknown>), LastEvaluatedKey: { pk: "ORG#foreign", sk: `MEMBER#${admin}` } }; }
  return result;
 };
 await expect(f.read()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});
it("refuses an eligibility directory changed while it was enumerated", async () => {
 const f = fixture(), send = f.db.send.bind(f.db);let first = true;
 f.db.send = async command => {
  const result = await send(command);
  if (first && command instanceof QueryCommand) { first = false;f.db.set({ ...f.db.get(orgMetaKey(orgId)), approvalMembershipVersion: 8 }); }
  return result;
 };
 await expect(f.read()).rejects.toMatchObject({ code: "CHANGE_STALE" });
});
