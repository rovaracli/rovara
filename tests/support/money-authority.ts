// Explicit membership setup for older low-level writer fixtures. Actor-loss tests seed membership explicitly; this helper prepares unrelated setup/competing writes.
import { createHash } from "node:crypto";
import { OrgRoleSchema, developerOrgKey, orgMemberKey, orgMetaKey, type OrgId } from "@agentx/contracts";
import type { BudgetActor } from "../../packages/broker/src/agents/budget-authority.js";
import type { FakeDynamoDb } from "./fake-dynamodb.js";
import { seedMembership } from "./developer-task-broker.js";
export function fixtureActor(source: unknown, orgId: OrgId, by: string): BudgetActor {
  const container = source as { documentClient?: unknown; input?: { documentClient: unknown } };
  const db = (container.documentClient ?? container.input?.documentClient ?? source) as FakeDynamoDb;
  if (typeof db.get !== "function" || typeof db.set !== "function") throw new Error("Money fixture needs its explicit fake database");
  const developerId = /^[a-f0-9]{64}$/.test(by) ? by : createHash("sha256").update(`money-fixture:${orgId}:${by}`).digest("hex");
  const member = db.get(orgMemberKey(orgId, developerId)), parsed = OrgRoleSchema.safeParse(member?.role);
  const role = parsed.success ? parsed.data : "admin";
  const pointer = db.get(developerOrgKey(developerId));
  if (member === undefined || !parsed.success || pointer === undefined || pointer.orgId !== orgId || pointer.role !== role) {
    const org = db.get(orgMetaKey(orgId));
    seedMembership(db, developerId, { orgId, role });
    if (org !== undefined) db.set(org);
  }
  return { developerId, role };
}
