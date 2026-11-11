// Plan 5 Task 4: a small company for the session access and sharing tests. Org A has the projects `web` and `ops`: Priya (contributor on web, the
// owner of the sessions made here), Arjun (contributor), Mia (viewer), Max (maintainer by grant), Ola (org admin with no grant) and Zed (a member with
// no project role). Org B has Bo. Grants are written as the real rows (`projectMemberKey`), and the project members fake answers the Slack-channel path.
import { randomUUID } from "node:crypto";
import { agentSessionKey, orgProjectCatalogKey, projectMemberKey, projectMetaKey, type AgentSessionRecord, type OrgId, type ProjectRole, type SessionLevel } from "@rovara-code/contracts";
import { orgMemberKey, type OrgRole } from "@agentx/cloud-contracts";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { FakeProjectMembers } from "./fake-project-members.js";

export const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
export const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const hex = (digit: string) => digit.repeat(64);
export const PRIYA = hex("a");
export const ARJUN = hex("b");
export const MIA = hex("c");
export const MAX = hex("d");
export const OLA = hex("e");
export const ZED = hex("f");
export const BO = hex("9");
export const NAMES: Record<string, string> = { [PRIYA]: "Priya", [ARJUN]: "Arjun", [MIA]: "Mia", [MAX]: "Max", [OLA]: "Ola", [ZED]: "Zed", [BO]: "Bo" };
export const T0 = Date.parse("2026-10-22T09:00:00.000Z");
export const CELL = "https://cell.example.com";

export type SessionKind = AgentSessionRecord["kind"];

export function sessionWorld() {
  const db = new FakeDynamoDb();
  const clock = { now: T0 };
  const members = new FakeProjectMembers();
  const signInStore = new DeveloperSignInStore({ documentClient: db, tableName: "state", now: () => clock.now });
  /** Every call the Slack-aware path made; the read-only path must leave it empty. */
  const channelCalls: string[] = [];

  const member = (orgId: OrgId, developerId: string, role: OrgRole) => {
    db.set({ ...orgMemberKey(orgId, developerId), entityType: "ORG_MEMBER", orgId, developerId, role, joinedAt: "2026-10-01T00:00:00.000Z" });
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "oidc", displayName: NAMES[developerId] ?? "Someone", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    members.setOrgRole(orgId, developerId, role);
  };
  const project = (orgId: OrgId, name: string) => {
    members.addProject(orgId, name);
    db.set({ ...orgProjectCatalogKey(orgId, name), entityType: "PROJECT_CATALOG", name, latestRevision: 1 });
    db.set({ ...projectMetaKey(orgId, name), entityType: "PROJECT_META", name, status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: OLA });
  };
  /** A grant as Plan 2 writes it: a maintainer or contributor keeps `role: "developer"`, a viewer's `role` is `viewer`. */
  const grant = (developerId: string, projectName: string, role: ProjectRole, orgId: OrgId = ORG_A) => {
    members.grant(orgId, projectName, developerId, role);
    db.set({
      ...projectMemberKey(orgId, developerId, projectName), entityType: "MEMBERSHIP", ownerKey: developerId, projectName, grantId: randomUUID(),
      role: role === "viewer" ? "viewer" : "developer", projectRole: role,
    });
  };

  project(ORG_A, "web");
  project(ORG_A, "ops");
  project(ORG_B, "web");
  for (const [who, role] of [[PRIYA, "member"], [ARJUN, "member"], [MIA, "member"], [MAX, "member"], [OLA, "admin"], [ZED, "member"]] as const) member(ORG_A, who, role);
  member(ORG_B, BO, "member");
  grant(PRIYA, "web", "contributor");
  grant(ARJUN, "web", "contributor");
  grant(MIA, "web", "viewer");
  grant(MAX, "web", "maintainer");
  grant(BO, "web", "contributor", ORG_B);

  const caller = (developerId: string, orgId: OrgId = ORG_A): DeveloperCaller => ({
    developerId, sessionId: `s-${developerId.slice(0, 4)}`, amr: "oidc", name: NAMES[developerId] ?? "Someone", orgId, orgRole: "member",
  });

  let counter = 0;
  const newSessionId = (kind: SessionKind) => (kind === "chain" ? `crn_${String(counter += 1).padStart(20, "0")}` : `ses_${String(counter += 1).padStart(20, "0")}`);

  /** A session (and, for a task session, its task) as the start writes them; `people` is the task's Task People list. */
  const seedSession = (options: {
    kind?: SessionKind; owner?: string; project?: string | null; ended?: boolean; orgId?: OrgId; taskOrgId?: OrgId;
    people?: Array<{ developerId: string; role: "owner" | "commenter" | "viewer" | "denied" }>; currentOwner?: string; revision?: number;
  } = {}) => {
    const kind = options.kind ?? "task";
    const orgId = options.orgId ?? ORG_A;
    const owner = options.owner ?? PRIYA;
    const projectName = options.project === null ? undefined : options.project ?? "web";
    const sessionId = newSessionId(kind);
    const taskId = randomUUID();
    const createdAt = "2026-10-22T08:00:00.000Z";
    const subject = kind === "task" ? { kind: "task" as const, taskId } : kind === "chain" ? { kind: "chain" as const, chainRunId: sessionId } : { kind: "local" as const, deviceId: "dvc_0123456789abcdefghij", tool: "claude-code" as const };
    const where = kind === "local" ? { kind: "mac" as const, deviceId: "dvc_0123456789abcdefghij", label: "Priya's MacBook" } : { kind: "cloud" as const };
    const record = {
      orgId, sessionId, kind, mode: "delegate", subject, legs: [], where, ...(projectName === undefined ? {} : { project: projectName }), title: "Bump the Stripe SDK",
      owner: { developerId: owner, name: NAMES[owner] ?? "Someone" }, startedBy: kind === "local" ? { kind: "local" } : { kind: "member", developerId: owner },
      origin: kind === "local" ? "local" : "app", followerCount: 0, summaryRevision: 1, revision: options.revision ?? 1, createdAt, updatedAt: createdAt,
      ...(options.ended === true ? { endedAt: "2026-10-22T08:30:00.000Z" } : {}),
      summary: { status: options.ended === true ? "succeeded" : "running", costUsd: 0, needsPeople: [], pendingApprovals: 0, digest: "d".repeat(64), computedAt: createdAt },
    };
    db.set({ ...agentSessionKey(orgId, sessionId, "META"), entityType: "AGENT_SESSION", ...record });
    if (kind === "task") {
      db.set({
        ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, orgId: options.taskOrgId ?? orgId, developerId: owner, developerName: NAMES[owner] ?? "Someone", provider: "oidc",
        project: projectName ?? "web", workspaceId: randomUUID(), ownerKey: `owner-${owner.slice(0, 6)}`, sessionId, createdAt, updatedAt: createdAt,
        ...(options.currentOwner === undefined ? {} : { currentOwner: { developerId: options.currentOwner, name: NAMES[options.currentOwner] ?? "Someone", provider: "oidc", since: createdAt } }),
      });
      if (options.people !== undefined) {
        db.set({
          pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false,
          people: options.people.map((entry, index) => ({ developerId: entry.developerId, slackUserId: `U0PERSON${String(index).padStart(2, "0")}`, name: NAMES[entry.developerId] ?? "Someone", role: entry.role })),
        });
      }
    }
    return { sessionId, taskId, record };
  };

  /** Writes a share as the share route does (the item only, for setting up a test). */
  const seedShare = (orgId: OrgId, sessionId: string, principal: { kind: "member"; developerId: string } | { kind: "project"; project: string } | { kind: "org" }, level: SessionLevel, sharedBy = PRIYA) => {
    const key = principal.kind === "member" ? `MEMBER#${principal.developerId}` : principal.kind === "project" ? `PROJECT#${principal.project}` : "ORG";
    db.set({
      ...agentSessionKey(orgId, sessionId, `SHARE#${key}`), entityType: "AGENT_SESSION_SHARE", orgId, sessionId, principal, level,
      sharedBy: { developerId: sharedBy, name: NAMES[sharedBy] ?? "Someone" }, sharedAt: "2026-10-22T08:10:00.000Z",
    });
  };

  const follower = (orgId: OrgId, sessionId: string, developerId: string) => db.set({ ...agentSessionKey(orgId, sessionId, `FOLLOWER#${developerId}`), entityType: "AGENT_SESSION_FOLLOWER", orgId, sessionId, developerId });

  return { db, clock, members, signInStore, channelCalls, member, project, grant, caller, seedSession, seedShare, follower };
}
export type SessionWorld = ReturnType<typeof sessionWorld>;
