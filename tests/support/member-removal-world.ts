// Member removal (v1.1): one world for the removal tests. The real OrgStore, the real movers (`memberRemovalHook` and the sweep's drain), the real sign-in store and
// FakeDynamoDb, with a sign-in Lambda that can be made to fail, so a test can run a removal, bring the person back and run the sweep in the order a real day would.
// One table plays the State table and the sign-in table.
import { randomUUID } from "node:crypto";
import {
  MEMBER_REMOVAL_QUEUE_PK, developerOrgKey, deviceKey, memberDevicesKey, memberRemovalRecordKey, orgMemberKey, orgSettingsKey, projectMemberKey, projectMetaKey,
  type OrgId, type OrgRole, type RecipeOverlay,
} from "@agentx/contracts";
import { followMerges } from "../../packages/broker/src/agents/access.js";
import { memberRemovalHook, runMemberMergeDrain, type LifecycleDeps } from "../../packages/broker/src/agents/lifecycle.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { authenticateDeveloper, authenticateDeveloperSessionId, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { AUDIT_CAPTURE_TABLE, capturingAuditDeps } from "./audit-capture.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { FakeProjectMembers } from "./fake-project-members.js";

export const T0 = Date.parse("2026-10-30T09:00:00.000Z");
export const HOUR = 3_600_000;
export const hex = (digit: string) => digit.repeat(64);
export const OWNER = hex("1");
export const ANA = hex("2");
export const SAM = hex("3");
export const PAT = hex("4");
const SCRATCH: RecipeOverlay = { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }] };
const ISSUER = "https://issuer.test";

export interface RemovalWorldOptions {
  /** `inline`: the removal runs the movers at once (as the request does). `sweep`: the request's hook does nothing, so the marker waits for the sweep. */
  movers?: "inline" | "sweep";
  /** Milliseconds the inline movers may take. */
  budgetMs?: number;
}

export async function removalWorld(options: RemovalWorldOptions = {}) {
  const clock = { now: T0 };
  const db = new FakeDynamoDb();
  const audit = capturingAuditDeps({ db, now: () => clock.now });
  const signInStore = new DeveloperSignInStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now });
  let counter = 0;
  const store = new AgentStore({
    documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, newId: () => `agt_${String(++counter).padStart(20, "0")}`,
    resolveOwner: (_orgId, developerId) => followMerges(signInStore, developerId), audit: audit.audit,
  });
  const projectMembers = new FakeProjectMembers();
  /** The sign-in function: it fails while `failures` is above zero, then ends the sessions as DeveloperIdentity does. Every call is recorded. */
  const lambda = { failures: 0, calls: [] as Array<{ developerId: string; at: string }> };
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const deps: LifecycleDeps = {
    store, projectMembers, documentClient: db, tableName: AUDIT_CAPTURE_TABLE, signInStore, now: () => clock.now, log: (event, fields) => logs.push({ event, fields }),
    endDeveloperSessions: async (request) => {
      lambda.calls.push({ developerId: request.developerId, at: request.at });
      if (lambda.failures > 0) { lambda.failures -= 1; return { ok: false, error: "unavailable" }; }
      return (await signInStore.endSessions(request.developerId, request.at)) === "ended" ? { ok: true } : { ok: false, error: "not_found" };
    },
  };
  const hook = options.movers === "sweep" ? { onRemoved: async () => { throw new Error("left to the sweep"); } } : memberRemovalHook(deps, { budgetMs: options.budgetMs ?? 60_000 });
  const orgs = new OrgStore({ documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, audit: audit.audit, memberRemoval: hook });
  const orgId: OrgId = await orgs.createOrgWithOwner({ name: "Acme", developerId: OWNER, email: "owner@example.com" });
  const person = (developerId: string, name: string) => db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", entityType: "DEVELOPER", developerId, provider: "cloud", displayName: name, revoked: false });
  person(OWNER, "Owen Owner");
  projectMembers.setOrgRole(orgId, OWNER, "owner");

  const join = async (developerId: string, name: string, role: OrgRole = "member") => {
    person(developerId, name);
    await orgs.addMember({ orgId, developerId, role });
    projectMembers.setOrgRole(orgId, developerId, role);
  };
  const routeDeps = {
    documentClient: db, tableName: AUDIT_CAPTURE_TABLE, now: () => clock.now, orgs,
    developer: { issuer: ISSUER, env: "test", methods: { cloud: true, slack: true, oidc: true, github: true }, signInTableName: AUDIT_CAPTURE_TABLE },
  } as unknown as DeveloperRouteDependencies;
  /** A sign-in session as the sign-in function leaves it. */
  const session = (developerId: string, startedAtMs: number, id: string = randomUUID()) => {
    db.set({
      pk: `SESSION#${id}`, sk: "META", entityType: "SESSION", sessionId: id, developerId, amr: "cloud", startedAt: new Date(startedAtMs).toISOString(),
      endsAt: Math.floor(clock.now / 1000) + 30 * 86_400, reviewExpiresAt: Math.floor(clock.now / 1000) + 30 * 86_400,
    });
    return id;
  };
  /** Whether the CLI or MCP token of that session is accepted now (its claims, the live session, the live membership). */
  const tokenWorks = async (developerId: string, sessionId: string, role: OrgRole = "member"): Promise<boolean> => {
    try {
      await authenticateDeveloper(routeDeps, { iss: ISSUER, aud: "agentx-developer", env: "test", sub: developerId, sid: sessionId, amr: "cloud", org: orgId, org_role: role });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "AUTH_REQUIRED") return false;
      throw error;
    }
  };
  /** Whether the browser cookie of that session is accepted now. */
  const cookieWorks = async (sessionId: string): Promise<boolean> => {
    try {
      await authenticateDeveloperSessionId(routeDeps, sessionId);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "AUTH_REQUIRED") return false;
      throw error;
    }
  };
  const grant = (developerId: string, project: string, grantId: string, projectRole: "maintainer" | "contributor" = "contributor") => {
    db.set({ ...projectMetaKey(orgId, project), entityType: "PROJECT_META", status: "active" });
    db.set({ ...projectMemberKey(orgId, developerId, project), entityType: "MEMBERSHIP", ownerKey: developerId, projectName: project, role: "developer", projectRole, grantId });
  };
  const grantOf = (developerId: string, project: string) => db.get(projectMemberKey(orgId, developerId, project));
  const device = (developerId: string, suffix: string, createdAtMs: number) => {
    const deviceId = `dvc_${suffix.padEnd(20, "0")}`;
    const createdAt = new Date(createdAtMs).toISOString();
    db.set({ ...memberDevicesKey(orgId, developerId, deviceId), entityType: "MEMBER_DEVICE", orgId, developerId, deviceId, createdAt });
    db.set({ ...deviceKey(orgId, deviceId), entityType: "DEVICE", orgId, deviceId, developerId, label: "Mac", platform: "mac", createdAt, lastSeenAt: createdAt });
    return deviceId;
  };
  const memberAgent = (owner: string, name: string) => store.create({ orgId, name, owner: { kind: "member", developerId: owner }, overlay: SCRATCH, createdBy: owner });
  const setLimit = (developerId: string, usd: number) => db.set({ ...orgSettingsKey(orgId, "BUDGET"), entityType: "ORG_SETTINGS", revision: 1, memberOverrides: { [developerId]: usd } });

  /** Removes `who` as `by` (an owner by default) with a fresh request id. */
  const remove = (who: string, options: { by?: string; callerRole?: OrgRole; successorId?: string; requestId?: string } = {}) => orgs.removeMember({
    orgId, developerId: who, emails: [], ban: false, by: { kind: "member", id: options.by ?? OWNER }, callerRole: options.callerRole ?? "owner",
    ...(options.successorId === undefined ? {} : { successorId: options.successorId }), requestId: options.requestId ?? randomUUID(),
  });
  const markers = () => db.find((item) => item.pk === MEMBER_REMOVAL_QUEUE_PK);
  const record = (removalId: string) => db.get(memberRemovalRecordKey(orgId, removalId));
  /** The sweep of the 5-minute settlement run. */
  const sweep = () => runMemberMergeDrain(deps, { budgetMs: 25_000 });
  const tick = (ms: number) => { clock.now += ms; };
  const sessionsEndedAt = () => (db.get({ pk: `DEVELOPER#${SAM}`, sk: "META" }) as { sessionsEndedAt?: string } | undefined)?.sessionsEndedAt;
  return {
    db, clock, audit, orgs, orgId, store, deps, lambda, logs, signInStore, projectMembers, join, session, tokenWorks, cookieWorks, grant, grantOf, device, memberAgent, setLimit,
    remove, markers, record, sweep, tick, sessionsEndedAt, developerOrgKey, orgMemberKey,
  };
}
