import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { orgMetaKey, orgMemberKey } from "@agentx/cloud-contracts";
import { projectMetaKey, projectMemberKey, type OrgId } from "@rovara-code/contracts";
import { setProjectMember, removeProjectMember } from "../../packages/broker/src/org/project-members.js";
import { grantProjectAccess, revokeProjectAccess } from "../../packages/broker/src/aws/admin-actions.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const at = "2026-10-29T21:00:00.000Z";
function setup() {
  const db = new FakeDynamoDb();
  db.set({ ...orgMetaKey(orgId), entityType: "ORG", approvalMembershipVersion: 4 });
  db.set({ ...orgMemberKey(orgId, "member"), entityType: "ORG_MEMBER", developerId: "member", role: "member" });
  db.set({ ...projectMetaKey(orgId, "payments"), entityType: "PROJECT_META", status: "active" });
  // srv/project-people: a second own maintainer, so taking "member"'s maintainer role away is not refused as the project's last one.
  db.set({ ...orgMemberKey(orgId, "keeper"), entityType: "ORG_MEMBER", developerId: "keeper", role: "member" });
  db.set({ ...projectMemberKey(orgId, "keeper", "payments"), entityType: "MEMBERSHIP", ownerKey: "keeper", grantId: randomUUID(), projectName: "payments", role: "developer", projectRole: "maintainer" });
  const deps = { documentClient: db, tableName: "T", now: () => new Date(at) };
  const input = () => ({ requestId: randomUUID(), developerId: "member", actor: { developerId: "owner" } });
  return { db, deps, input };
}

describe("approval generation for project grants", () => {
  it("moves the org generation when a maintainer is added and preserves it on replay", async () => {
    const { db, deps, input } = setup();
    const request = { ...input(), role: "maintainer" as const };
    await setProjectMember(deps, orgId, "payments", request);
    expect(db.get(orgMetaKey(orgId))?.approvalMembershipVersion).toBe(5);
    await setProjectMember(deps, orgId, "payments", request);
    expect(db.get(orgMetaKey(orgId))?.approvalMembershipVersion).toBe(5);
  });
  it("records project-specific eligibility loss on maintainer demotion", async () => {
    const { db, deps, input } = setup();
    await setProjectMember(deps, orgId, "payments", { ...input(), role: "maintainer" });
    await setProjectMember(deps, orgId, "payments", { ...input(), role: "viewer" });
    expect(db.get(orgMetaKey(orgId))?.approvalMembershipVersion).toBe(6);
    expect(db.get(projectMetaKey(orgId, "payments"))?.approvalLastMaintainerLossAt).toBe(at);
  });
  it("records project-specific eligibility loss when a maintainer grant is revoked", async () => {
    const { db, deps, input } = setup();
    await setProjectMember(deps, orgId, "payments", { ...input(), role: "maintainer" });
    await removeProjectMember(deps, orgId, "payments", input());
    expect(db.get(orgMetaKey(orgId))?.approvalMembershipVersion).toBe(6);
    expect(db.get(projectMetaKey(orgId, "payments"))?.approvalLastMaintainerLossAt).toBe(at);
    expect(db.get(projectMemberKey(orgId, "member", "payments"))).toBeUndefined();
  });
});


describe("operator grant writers invalidate company approval snapshots", () => {
  it("moves generation on a new operator-created project grant", async () => {
    const { db, deps } = setup();
    await grantProjectAccess({ ...deps, now: () => Date.parse(at), limitDefaults: { member: 1, organization: 2 } }, orgId, { issuer: "operator", subject: "operator" }, "payments", "member");
    expect(db.get(orgMetaKey(orgId))?.approvalMembershipVersion).toBe(5);
  });
  it("records scoped eligibility loss when operator revokes a maintainer", async () => {
    const { db, deps, input } = setup();
    await setProjectMember(deps, orgId, "payments", { ...input(), role: "maintainer" });
    await revokeProjectAccess({ ...deps, now: () => Date.parse(at), limitDefaults: { member: 1, organization: 2 } }, orgId, "payments", "member");
    expect(db.get(orgMetaKey(orgId))?.approvalMembershipVersion).toBe(6);
    expect(db.get(projectMetaKey(orgId, "payments"))?.approvalLastMaintainerLossAt).toBe(at);
  });
});

it("never shortens maintainer cool-off when a later writer has an older clock", async () => {
  const { db, deps, input } = setup();
  await setProjectMember(deps, orgId, "payments", { ...input(), role: "maintainer" });
  await setProjectMember(deps, orgId, "payments", { ...input(), role: "viewer" });
  const loss = db.get(projectMetaKey(orgId, "payments"))?.approvalLastMaintainerLossAt;
  await setProjectMember(deps, orgId, "payments", { ...input(), role: "maintainer" });
  deps.now = () => new Date(Date.parse(at) - 60_000);
  await setProjectMember(deps, orgId, "payments", { ...input(), role: "viewer" });
  expect(Date.parse(String(db.get(projectMetaKey(orgId, "payments"))?.approvalLastMaintainerLossAt))).toBeGreaterThanOrEqual(Date.parse(String(loss)));
});


it.each(["demote", "revoke"] as const)("records a maintainer loss when a concurrent promotion races %s", async action => {
  const { db, deps, input } = setup();
  await setProjectMember(deps, orgId, "payments", { ...input(), role: "contributor" });
  const send = db.send.bind(db);let race = true;
  db.send = async command => {
    if (race && command instanceof TransactWriteCommand) {
      race = false;
      db.set({ ...db.get(projectMemberKey(orgId, "member", "payments")), projectRole: "maintainer" });
    }
    return send(command);
  };
  if (action === "demote") await setProjectMember(deps, orgId, "payments", { ...input(), role: "viewer" });
  else await removeProjectMember(deps, orgId, "payments", input());
  expect(db.get(projectMetaKey(orgId, "payments"))?.approvalLastMaintainerLossAt).toBe(at);
});
