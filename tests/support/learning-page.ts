// Test support for the v1.2 learning loop (B3): a page task whose people have (or lack) the company and project records that make them a member or an outsider.
import { randomUUID } from "node:crypto";
import type { TaskComment } from "@rovara-code/contracts";
import { developerOrgKey, orgMemberKey } from "@agentx/cloud-contracts";
import { projectMemberKey, projectMetaKey } from "@rovara-code/contracts";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { FakeDynamoDb } from "./fake-dynamodb.js";
import { OMAR, PRIYA, SAM, pagePlan, pageTask, type PageTaskFixture } from "./page-tasks.js";
import { TEST_ORG } from "./orgs.js";

export { OMAR, PRIYA, SAM };
export const PROJECT = "payments";
export const PROJECT_CREATED_AT = "2026-10-01T00:00:00.000Z";
export const MAYA_ADMIN: DeveloperCaller = { orgId: TEST_ORG, orgRole: "admin" as const, developerId: "9".repeat(64), sessionId: "s-admin", amr: "slack", name: "Ada Admin", slackUserId: "U0ADMIN01" };
export const LEO: DeveloperCaller = { orgId: TEST_ORG, orgRole: "member" as const, developerId: "8".repeat(64), sessionId: "s-leo", amr: "slack", name: "Leo Park", slackUserId: "U0LEO0001" };

export type GrantKind = "maintainer" | "contributor" | "viewer" | "none";

/** The company member record, as the org store writes it. */
export function seedMember(db: FakeDynamoDb, who: DeveloperCaller, role: "owner" | "admin" | "member" = "member"): void {
  db.set({ ...orgMemberKey(TEST_ORG, who.developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: who.developerId, role, joinedAt: "2026-09-01T00:00:00.000Z" });
  db.set({ ...developerOrgKey(who.developerId), orgId: TEST_ORG, role });
}

/** A project grant row, as the project members store writes it. */
export function seedGrant(db: FakeDynamoDb, who: DeveloperCaller, kind: GrantKind, project = PROJECT): void {
  if (kind === "none") return;
  db.set({
    ...projectMemberKey(TEST_ORG, who.developerId, project), entityType: "PROJECT_MEMBER", orgId: TEST_ORG, ownerKey: who.developerId, projectName: project, grantId: randomUUID(),
    role: kind === "viewer" ? "viewer" : "developer", ...(kind === "viewer" ? {} : { projectRole: kind }), grantedBy: { developerId: MAYA_ADMIN.developerId },
  });
}

export function seedProject(db: FakeDynamoDb, project = PROJECT, status: "active" | "archived" = "active", createdAt = PROJECT_CREATED_AT): void {
  db.set({ ...projectMetaKey(TEST_ORG, project), entityType: "PROJECT_META", name: project, status, createdAt, createdBy: MAYA_ADMIN.developerId });
}

/** A person with a member record and a grant: a member of the project when the grant is a contributor's or a maintainer's. */
export function seedPerson(db: FakeDynamoDb, who: DeveloperCaller, grant: GrantKind, role: "owner" | "admin" | "member" = "member", project = PROJECT): void {
  seedMember(db, who, role);
  seedGrant(db, who, grant, project);
}

/** A stored comment on the task, as `createTaskComment` writes it. */
export function seedComment(fixture: PageTaskFixture, author: DeveloperCaller, text: string, options: { commentId?: string; deleted?: boolean; agentx?: boolean; createdAt?: string } = {}): TaskComment {
  const commentId = options.commentId ?? randomUUID();
  const createdAt = options.createdAt ?? new Date(fixture.deps.now()).toISOString();
  const comment = {
    schemaVersion: 1, taskId: fixture.taskId, commentId, document: "plan", version: 1, target: { kind: "claim", id: "2.1" },
    author: options.agentx === true ? { kind: "agentx", source: "answer" }
      : { kind: "person", developerId: author.developerId, ...(author.slackUserId === undefined ? {} : { slackUserId: author.slackUserId }), name: author.name ?? "Someone", owner: author.developerId === PRIYA.developerId },
    text: options.deleted === true ? "" : text, createdAt, ...(options.deleted === true ? { deletedAt: createdAt } : {}), rev: 1,
  } as TaskComment;
  fixture.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: `COMMENT#${commentId}`, entityType: "TASK_COMMENT", ...comment });
  return comment;
}

export const RETRY_TEXT = "Use the shared retry helper in lib/retry, not a hand-written loop.";

/** A waiting plan task of project "payments" (owner Priya, Sam in the channel) with the project's META. Nobody is a member until `seedPerson` says so. */
export function learningTask(): PageTaskFixture {
  const fixture = pageTask();
  fixture.addVersion("plan", pagePlan());
  seedProject(fixture.db);
  return fixture;
}

/** Someone took the task over: the owner is now them (review Critical 1: a viewer, a commenter or a person with no grant can do this). */
export function takeOver(fixture: PageTaskFixture, taker: DeveloperCaller): void {
  const record = fixture.db.get(`DEVTASK#${fixture.taskId}`, "META")!;
  fixture.db.set({ ...record, currentOwner: { developerId: taker.developerId, name: taker.name ?? "Someone", provider: "slack", ...(taker.slackUserId === undefined ? {} : { slackUserId: taker.slackUserId }), since: new Date(fixture.deps.now()).toISOString() } });
}

/** Every item of the project's learning partition. */
export function learningItems(db: FakeDynamoDb, project = PROJECT): Array<Record<string, unknown>> {
  return db.find((item) => typeof item.pk === "string" && item.pk.endsWith(`#PROJECT_LEARNING#${project}`));
}
