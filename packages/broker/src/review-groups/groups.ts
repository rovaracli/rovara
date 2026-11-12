// Review groups (owner decision 9, A-22): a project's named groups of reviewers, kept as ONE document per project (`reviewGroupsKey`, under the org's own partition).
//
// Anyone who can see the project reads the groups (`GET /v1/app/projects/{p}/review-groups`). A maintainer, or an org owner or admin (who maintain every project), changes them with
// `PUT`, from a live browser session (the dispatcher refuses anything else first), under the revision they read. Every person ADDED to a group must be, right now, a contributor or a
// maintainer of the project (a live read of their company role and project role; a viewer, an Auditor or someone outside the company is refused). Someone already in a group who has
// since lost that standing is dropped when the groups are next saved, and reads as not eligible until then. The write and its audit event are one transaction; a repeat of the same
// request answers the same and writes nothing; the same request id with another body is refused.
//
// A group only shares out the work of reviewing. Who may APPROVE is still the code host's rule (code owners, write access, linked accounts): nothing here is read by the merge.
import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { agentXError, projectAllows, type OrgId, type ProjectRole } from "@rovara-code/contracts";
import {
  REVIEW_GROUPS_PEOPLE_MAX, REVIEW_GROUP_MESSAGES as W, ReviewGroupIdSchema, ReviewGroupNameSchema, ReviewGroupsBodySchema, reviewGroupsKey,
  type OrgRole, type ReviewGroupsBody, type ReviewGroupsView,
} from "@agentx/cloud-contracts";
import { z } from "zod";
import { auditOccurrence, auditReviewGroupsChanged } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditRuntime } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";

/** Who asks: their id, their company, and their live company role (the request's authentication re-reads it). */
export interface ReviewCaller { developerId: string; orgId: OrgId; orgRole: OrgRole }

export interface ReviewGroupsDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  audit?: AuditRuntime;
  /** The caller's live role in the project, and its name; the one `PROJECT_NOT_FOUND` for no access, no such project and another company's. */
  projectFor(caller: ReviewCaller, rawName: string): Promise<{ name: string; role: ProjectRole }>;
  /** Another person's live role in the project (their live company role read first); undefined for none, or for someone not in the company. */
  liveProjectRole(orgId: OrgId, project: string, developerId: string): Promise<ProjectRole | undefined>;
  /** A display name ("A former member" for someone erased); never fails. */
  nameOf(orgId: OrgId, developerId: string): Promise<string>;
}

export interface StoredGroup { groupId: string; name: string; members: string[] }
export interface StoredGroups { revision: number; groups: StoredGroup[]; lastRequestId?: string; lastRequestDigest?: string; exists: boolean }

/** Contributors and maintainers review; a viewer (and anyone with no role) does not. */
export const mayReview = (role: ProjectRole | undefined): boolean => role === "maintainer" || role === "contributor";

const StoredGroupSchema = z.object({ groupId: ReviewGroupIdSchema, name: ReviewGroupNameSchema, members: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(50) }).strict();
const StoredDocumentSchema = z.object({ revision: z.number().int().min(1), groups: z.array(StoredGroupSchema).max(20) });

/** The project's groups, read fresh. A stored document that does not read fails closed: `unreadable`, never "no groups" (which would hide that something is wrong). */
export async function readReviewGroups(deps: Pick<ReviewGroupsDeps, "documentClient" | "tableName">, orgId: OrgId, project: string): Promise<StoredGroups | "unreadable"> {
  const found = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: reviewGroupsKey(orgId, project), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = found.Item;
  if (item === undefined) return { revision: 0, groups: [], exists: false };
  if (item["orgId"] !== orgId || item["project"] !== project) return "unreadable";
  const parsed = StoredDocumentSchema.safeParse({ revision: item["revision"], groups: item["groups"] });
  if (!parsed.success) return "unreadable";
  return {
    revision: parsed.data.revision, groups: parsed.data.groups, exists: true,
    ...(typeof item["lastRequestId"] === "string" ? { lastRequestId: item["lastRequestId"] } : {}),
    ...(typeof item["lastRequestDigest"] === "string" ? { lastRequestDigest: item["lastRequestDigest"] } : {}),
  };
}

export const UNREADABLE_GROUPS = "The stored review groups could not be read, so nothing was changed.";

/** Each different person's live role, looked up once. */
export async function liveRoles(deps: Pick<ReviewGroupsDeps, "liveProjectRole">, orgId: OrgId, project: string, people: Iterable<string>): Promise<Map<string, ProjectRole | undefined>> {
  const ids = [...new Set(people)];
  const roles = await Promise.all(ids.map(async (id) => [id, await deps.liveProjectRole(orgId, project, id)] as const));
  return new Map(roles);
}

/** The groups as the page shows them: names, and whether each person may still review. */
export async function groupsView(deps: ReviewGroupsDeps, orgId: OrgId, project: string, stored: StoredGroups, canManage: boolean): Promise<ReviewGroupsView> {
  const people = stored.groups.flatMap((group) => group.members);
  const roles = await liveRoles(deps, orgId, project, people);
  const names = new Map(await Promise.all([...new Set(people)].map(async (id) => [id, await deps.nameOf(orgId, id)] as const)));
  return {
    revision: stored.revision, canManage,
    groups: stored.groups.map((group) => ({
      groupId: group.groupId, name: group.name,
      members: group.members.map((developerId) => ({ developerId, name: names.get(developerId) ?? "A member", eligible: mayReview(roles.get(developerId)) })),
    })),
  };
}

/** `GET /v1/app/projects/{p}/review-groups`: anyone who can see the project. */
export async function getReviewGroups(deps: ReviewGroupsDeps, caller: ReviewCaller, rawProject: string): Promise<ReviewGroupsView> {
  const { name, role } = await deps.projectFor(caller, rawProject);
  const stored = await readReviewGroups(deps, caller.orgId, name);
  if (stored === "unreadable") throw agentXError("CONFIG_INVALID", "The stored review groups could not be read.");
  return groupsView(deps, caller.orgId, name, stored, projectAllows(role, "manage_members"));
}

function parseBody(raw: unknown): ReviewGroupsBody {
  const parsed = ReviewGroupsBodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // The field's path only: the values are the caller's.
    const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
    throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
  }
  return parsed.data;
}

/** What the request asks for, without its id and revision. */
const digestOf = (body: ReviewGroupsBody): string =>
  createHash("sha256").update(JSON.stringify(body.groups.map((group) => [group.groupId ?? null, group.name, group.members])), "utf8").digest("hex");

const newGroupId = (requestId: string, index: number): string => `rgp_${createHash("sha256").update(`${requestId}\n${String(index)}`, "utf8").digest("hex").slice(0, 16)}`;

const isConditional = (error: unknown): boolean => error instanceof Error && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");

/**
 * `PUT /v1/app/projects/{p}/review-groups`: the whole list of groups as it should be. A maintainer (or an org owner or admin), under the revision read (`CHANGE_STALE` otherwise).
 * Everyone added must be a live contributor or maintainer of the project; anyone already in a group who no longer is gets dropped.
 */
export async function putReviewGroups(deps: ReviewGroupsDeps, caller: ReviewCaller, rawProject: string, rawBody: unknown): Promise<ReviewGroupsView> {
  const found = await deps.projectFor(caller, rawProject);
  if (!projectAllows(found.role, "manage_members")) throw agentXError("FORBIDDEN", W.maintainersOnly);
  const body = parseBody(rawBody);
  const project = found.name;
  const current = await readReviewGroups(deps, caller.orgId, project);
  if (current === "unreadable") throw agentXError("CONFIG_INVALID", UNREADABLE_GROUPS);
  const digest = digestOf(body);
  if (current.lastRequestId === body.requestId) {
    if (current.lastRequestDigest !== digest) throw agentXError("CONFIG_INVALID", W.requestReused);
    return groupsView(deps, caller.orgId, project, current, true);
  }
  if (body.expectedRevision !== current.revision) throw agentXError("CHANGE_STALE", W.stale);

  // The shape: names differ (ignoring case), an existing group is named once, nobody is in one group twice, and the people across all groups stay within the cap.
  const known = new Map(current.groups.map((group) => [group.groupId, group]));
  const names = new Set<string>();
  const ids = new Set<string>();
  body.groups.forEach((group, index) => {
    const folded = group.name.toLocaleLowerCase("en-US");
    if (names.has(folded)) throw agentXError("CONFIG_INVALID", `groups.${String(index)}.name: another group has this name`);
    names.add(folded);
    if (group.groupId !== undefined) {
      if (!known.has(group.groupId)) throw agentXError("CONFIG_INVALID", `groups.${String(index)}.groupId: no such group in this project`);
      if (ids.has(group.groupId)) throw agentXError("CONFIG_INVALID", `groups.${String(index)}.groupId: names the same group twice`);
      ids.add(group.groupId);
    }
    if (new Set(group.members).size !== group.members.length) throw agentXError("CONFIG_INVALID", `groups.${String(index)}.members: names the same person twice`);
  });
  const everyone = new Set(body.groups.flatMap((group) => group.members));
  if (everyone.size > REVIEW_GROUPS_PEOPLE_MAX) throw agentXError("CONFIG_INVALID", `groups: at most ${String(REVIEW_GROUPS_PEOPLE_MAX)} different people across all groups`);

  // Live standing of everyone named: a newcomer who may not review is refused; someone already in that group who lost their standing is dropped.
  const roles = await liveRoles(deps, caller.orgId, project, everyone);
  const next: StoredGroup[] = body.groups.map((group, index) => {
    const before = group.groupId === undefined ? undefined : known.get(group.groupId);
    const members: string[] = [];
    group.members.forEach((developerId, at) => {
      if (mayReview(roles.get(developerId))) members.push(developerId);
      else if (before === undefined || !before.members.includes(developerId)) throw agentXError("CONFIG_INVALID", `groups.${String(index)}.members.${String(at)}: that person isn't a contributor or maintainer of this project`);
    });
    return { groupId: group.groupId ?? newGroupId(body.requestId, index), name: group.name, members };
  });

  const memberSet = (groups: readonly StoredGroup[]) => new Set(groups.flatMap((group) => group.members.map((member) => `${group.groupId}\n${member}`)));
  const was = memberSet(current.groups);
  const now = memberSet(next);
  const added = [...now].filter((entry) => !was.has(entry)).length;
  const removed = [...was].filter((entry) => !now.has(entry)).length;
  const unchanged = JSON.stringify(next) === JSON.stringify(current.groups);
  if (unchanged) return groupsView(deps, caller.orgId, project, current, true);

  const revision = current.revision + 1;
  const at = new Date(deps.now()).toISOString();
  const events = await tryAuditEvents(deps, () => [auditReviewGroupsChanged({
    orgId: caller.orgId, actor: auditActorOf(caller.developerId), occurredAt: at, occurrence: auditOccurrence(project, String(revision)),
    projectName: project, revision, groups: next.length, members: new Set(next.flatMap((group) => group.members)).size, added, removed,
  })]);
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: {
        TableName: deps.tableName,
        Item: { ...reviewGroupsKey(caller.orgId, project), entityType: "REVIEW_GROUPS", orgId: caller.orgId, project, revision, groups: next, lastRequestId: body.requestId, lastRequestDigest: digest, updatedAt: at, updatedBy: caller.developerId },
        ...(current.exists
          ? { ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": current.revision } }
          : { ConditionExpression: "attribute_not_exists(pk)" }),
      } },
      ...events.flatMap((event) => auditPending(deps, event)),
    ] }));
  } catch (error) {
    if (isConditional(error)) throw agentXError("CHANGE_STALE", W.stale);
    throw error;
  }
  await flushAuditEvents(deps, events);
  return groupsView(deps, caller.orgId, project, { revision, groups: next, exists: true }, true);
}
