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
 function person(id: string, role: "owner" | "admin" | "member" | "auditor") {
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
 it("accepts identity rows as a real sign-in writes them (no developerId attribute: the id is the key)", async () => {
  const f = fixture();f.person(admin, "admin");
  for (const id of [owner, admin]) { const { developerId: _id, ...row } = f.db.get(`DEVELOPER#${id}`, "META")!;void _id;f.db.set({ ...row, entityType: "DEVELOPER", provider: "slack" }); }
  const proof = await f.read(admin);
  expect(decideSecondPersonApproval(proof.decisionInput).mode).toBe("second_person");
 });
 it("still refuses an identity row that names another person", async () => {
  const f = fixture();f.person(admin, "admin");
  f.db.set({ pk: `DEVELOPER#${admin}`, sk: "META", developerId: member, revoked: false });
  await expect(f.read(admin)).rejects.toMatchObject({ code: "FORBIDDEN" });
 });
 it("accepts distinct live company people using server evidence", async () => {
  const f = fixture();f.person(admin, "admin");
  const proof = await f.read(admin);
  expect(decideSecondPersonApproval(proof.decisionInput).mode).toBe("second_person");
 });
 it("never counts an Auditor as a second person, and refuses one as the approver (I2)", async () => {
  const f = fixture();f.person("d".repeat(64), "auditor");
  const proof = await f.read();
  // The only owner with an Auditor beside them is still the sole eligible person: the exception applies, a second person does not.
  expect(decideSecondPersonApproval(proof.decisionInput).mode).toBe("sole_owner_exception");
  await expect(f.read("d".repeat(64))).rejects.toMatchObject({ code: "FORBIDDEN" });
  // The control: the same company with an admin in the Auditor's place has a second person.
  const g = fixture();g.person("d".repeat(64), "admin");
  const alone = (await g.read()).decisionInput;
  expect(() => decideSecondPersonApproval(alone)).toThrow("FORBIDDEN");
  expect(decideSecondPersonApproval((await g.read("d".repeat(64))).decisionInput).mode).toBe("second_person");
 });
 it("a roster row with a role that is not a role makes the evidence unavailable, never an eligible person (fix round 1)", async () => {
  const f = fixture();
  f.db.set({ ...orgMemberKey(orgId, "e".repeat(64)), orgId, developerId: "e".repeat(64), role: "garbage", joinedAt: "2026-10-01T00:00:00.000Z" });
  await expect(f.read()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
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

it("legacy companies approve with distinct live people and an absent-generation commit fence", async () => {
 const f = fixture();f.person(admin, "admin");const meta = { ...f.db.get(orgMetaKey(orgId)) };delete meta.approvalMembershipVersion;delete meta.approvalTrackingSince;f.db.set(meta);
 const proof = await f.read(admin);expect(decideSecondPersonApproval(proof.decisionInput).mode).toBe("second_person");
 await f.db.send(new TransactWriteCommand({ TransactItems: [...proof.conditions, { Put: { TableName: "state", Item: { pk: "LEGACY", sk: "APPROVED" } } }] }));
 expect(f.db.get({ pk: "LEGACY", sk: "APPROVED" })).toBeDefined();
 f.db.set({ ...meta, approvalMembershipVersion: 0 });
 await expect(f.db.send(new TransactWriteCommand({ TransactItems: [...proof.conditions, { Put: { TableName: "state", Item: { pk: "LEGACY", sk: "RACED" } } }] }))).rejects.toMatchObject({ name: "TransactionCanceledException" });
 expect(f.db.get({ pk: "LEGACY", sk: "RACED" })).toBeUndefined();
});
it("legacy companies without generation evidence cannot use the sole-owner exception", async () => {
 const f = fixture();const meta = { ...f.db.get(orgMetaKey(orgId)) };delete meta.approvalMembershipVersion;delete meta.approvalTrackingSince;f.db.set(meta);
 await expect(f.read()).rejects.toMatchObject({ code: "CHANGE_STALE" });
});
