// Explicit membership setup for older low-level writer fixtures. Actor-loss tests seed membership explicitly; this helper prepares unrelated setup/competing writes.
import { createHash } from "node:crypto";
import { OrgRoleSchema, developerOrgKey, orgMemberKey, orgMetaKey, projectMemberKey, type OrgId } from "@agentx/contracts";
import type { BudgetActor } from "../../packages/broker/src/agents/budget-authority.js";
import type { FakeDynamoDb } from "./fake-dynamodb.js";
import { seedMembership } from "./developer-task-broker.js";
export function fixtureActor(source: unknown, orgId: OrgId, by: string, requireCompanyAdmin = false): BudgetActor {
  const container = source as { documentClient?: unknown; input?: { documentClient: unknown } };
  const db = (container.documentClient ?? container.input?.documentClient ?? source) as FakeDynamoDb;
  if (typeof db.get !== "function" || typeof db.set !== "function") throw new Error("Money fixture needs its explicit fake database");
  let developerId = /^[a-f0-9]{64}$/.test(by) ? by : createHash("sha256").update(`money-fixture:${orgId}:${by}`).digest("hex");
  let member = db.get(orgMemberKey(orgId, developerId)), parsed = OrgRoleSchema.safeParse(member?.role);
  let role = parsed.success ? parsed.data : "admin";
  if (requireCompanyAdmin && role !== "owner" && role !== "admin") {
    // Do not promote a real fixture member just to configure company settings.
    developerId = createHash("sha256").update(`company-money-fixture:${orgId}:${by}`).digest("hex");
    member = db.get(orgMemberKey(orgId, developerId)); parsed = OrgRoleSchema.safeParse(member?.role);
    role = parsed.success && (parsed.data === "owner" || parsed.data === "admin") ? parsed.data : "admin";
  }
  const pointer = db.get(developerOrgKey(developerId));
  if (member === undefined || !parsed.success || pointer === undefined || pointer.orgId !== orgId || pointer.role !== role) {
    const org = db.get(orgMetaKey(orgId));
    seedMembership(db, developerId, { orgId, role });
    if (org !== undefined) db.set(org);
  }
  return { developerId, role };
}

/**
 * The stored grant row that makes a member a project's maintainer, as the real writer stores it. A write on a project's agent or chain by a member who is not an org
 * admin pins this row (S1-M2), so a low-level fixture that acts as a maintainer through a store call needs it. Returns a function that takes the row away again.
 */
export function seedMaintainerGrant(source: unknown, orgId: OrgId, developerId: string, project: string): () => void {
  const container = source as { documentClient?: unknown; input?: { documentClient: unknown } };
  const db = (container.documentClient ?? container.input?.documentClient ?? source) as FakeDynamoDb;
  const key = projectMemberKey(orgId, developerId, project);
  db.set({ ...key, entityType: "MEMBERSHIP", ownerKey: developerId, projectName: project, grantId: createHash("sha256").update(`grant:${orgId}:${developerId}:${project}`).digest("hex"), role: "developer", projectRole: "maintainer" });
  return () => db.delete(key);
}
