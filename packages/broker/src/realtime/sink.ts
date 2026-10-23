// The notice sink (Plan 5 Task 8): what happens after a session's summary change commits. It works out who hears the change (`noticesFor`), checks the session's
// followers again (a person who can no longer see it is dropped and their follow deleted), writes each person's feed items, and only then publishes. Nothing here
// throws into the refresh: a notice is never a reason for a refresh to fail (`notifySessionChange` logs what escapes).
import { DeleteCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SESSION_FOLLOWERS_MAX, agentSessionKey, orgMemberKey, projectMemberKey, type AgentSessionRecord } from "@agentx/contracts";
import { grantRoleOf } from "../developer/project-roles.js";
import { readSessionShares, readTaskPeople, effectiveOwnerOf, sessionLevelOf, type SessionAccessDependencies } from "../agent-sessions/access.js";
import { registerSessionNoticeSink, type NoticeSinkDependencies, type SessionChange, type SessionNoticeSink } from "../agent-sessions/notice-sink.js";
import { writeChanges } from "./changes.js";
import { environmentCredentials, followersHear, noticesFor, publishNotices, type RealtimeConfig } from "./publish.js";

type Item = Record<string, unknown>;
const FOLLOWER_PREFIX = "FOLLOWER#";
const DEVELOPER_ID = /^[a-f0-9]{64}$/u;

export interface RealtimeSinkOptions {
  /** The events API; without it the feed is written and nothing is published. */
  realtime?: RealtimeConfig | undefined;
  /** Plan 4's readers of a chain run. Without it a chain session's followers can't be judged, so none is told and none is dropped. */
  chainReadAccess?: SessionAccessDependencies["chainReadAccess"];
}

const get = async (deps: NoticeSinkDependencies, key: { pk: string; sk: string }): Promise<Item | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Item }).Item;

/** The people following the session, from their `FOLLOWER#` items (at most what the session may have). */
async function followerIds(deps: NoticeSinkDependencies, session: AgentSessionRecord): Promise<string[]> {
  const ids: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ConsistentRead: true,
      ExpressionAttributeValues: { ":pk": agentSessionKey(session.orgId, session.sessionId, "META").pk, ":prefix": FOLLOWER_PREFIX },
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const item of page.Items ?? []) {
      const id = typeof item["sk"] === "string" ? item["sk"].slice(FOLLOWER_PREFIX.length) : "";
      if (DEVELOPER_ID.test(id)) ids.push(id);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined && ids.length < SESSION_FOLLOWERS_MAX);
  return ids.slice(0, SESSION_FOLLOWERS_MAX);
}

/**
 * The followers who may still see the session, judged now on the read-only path (no Slack call). A task session's followers are grouped by the facts that decide
 * their level (their org role, their grant on the project, their Task People entry and their own shares); each group is resolved once and the answer used for every
 * member. A follower with no level is dropped and their follow deleted. When the deadline passes, the followers not yet judged are left out of this change (and left
 * alone). A chain session's followers are judged by Plan 4's readers, or not at all without them.
 */
async function checkedFollowers(deps: NoticeSinkDependencies, access: SessionAccessDependencies, session: AgentSessionRecord, owner: string): Promise<string[]> {
  const ids = (await followerIds(deps, session)).filter((id) => id !== owner);
  if (ids.length === 0 || (session.kind === "chain" && access.chainReadAccess === undefined)) return [];
  const log = deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line })));
  const people = session.subject.kind === "task" ? await readTaskPeople(access, session.subject.taskId) : undefined;
  const shares = session.kind === "task" ? await readSessionShares(access, session.orgId, session.sessionId) : [];
  const factsOf = async (developerId: string): Promise<string> => {
    const member = await get(deps, orgMemberKey(session.orgId, developerId));
    const grant = session.project === undefined ? undefined : grantRoleOf(await get(deps, projectMemberKey(session.orgId, developerId, session.project)));
    const entry = people === undefined || people === "unreadable" ? people : people.get(developerId);
    const own = shares.filter((share) => share.principal.kind === "member" && share.principal.developerId === developerId).map((share) => share.level).sort();
    return JSON.stringify([member?.["role"], grant, entry, own]);
  };
  const levels = new Map<string, Promise<boolean>>();
  const allowed: string[] = [];
  let unjudged = 0;
  for (const developerId of ids) {
    if (deps.deadline !== undefined && deps.now() >= deps.deadline) { unjudged += 1; continue; }
    // A chain session's level isn't decided by these facts (Plan 4's readers look at the person), so each follower is judged alone.
    const group = session.kind === "task" ? await factsOf(developerId) : developerId;
    let visible = levels.get(group);
    if (visible === undefined) {
      visible = sessionLevelOf(access, { orgId: session.orgId, developerId }, session, { readOnlyPath: true }).then((level) => level !== "none");
      levels.set(group, visible);
    }
    if (await visible) { allowed.push(developerId); continue; }
    await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: agentSessionKey(session.orgId, session.sessionId, `${FOLLOWER_PREFIX}${developerId}`) }));
  }
  if (unjudged > 0) log({ event: "realtime.followers_unchecked", sessionId: session.sessionId, unchecked: unjudged });
  return allowed;
}

/** Whether the project's channel may carry this session's change: no Task People entry on its task is `denied`, and the list reads. */
async function projectMayHear(access: SessionAccessDependencies, session: AgentSessionRecord): Promise<boolean> {
  if (session.kind !== "task" || session.where.kind !== "cloud" || session.project === undefined || session.subject.kind !== "task") return false;
  const people = await readTaskPeople(access, session.subject.taskId);
  return people === undefined || (people !== "unreadable" && ![...people.values()].includes("denied"));
}

/** The sink for a session's change. */
export function createRealtimeSink(options: RealtimeSinkOptions): SessionNoticeSink {
  return async (deps: NoticeSinkDependencies, change: SessionChange) => {
    const { session } = change;
    // The read-only path never asks the project's channel, so there is nothing to ask.
    const access: SessionAccessDependencies = {
      documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, projectMembers: { roleOf: async () => undefined },
      ...(options.chainReadAccess === undefined ? {} : { chainReadAccess: options.chainReadAccess }),
    };
    const owner = await effectiveOwnerOf(access, session);
    const planned = noticesFor(session, change, {
      owner,
      followers: followersHear(change) ? await checkedFollowers(deps, access, session, owner) : [],
      projectNotice: await projectMayHear(access, session),
    });
    // The feed first: a client that connects after this still finds the notice, whatever happens to the publish.
    await writeChanges(deps, change.orgId, planned.flatMap((entry) => entry.feedTo.map((developerId) => ({ developerId, notice: entry.notice, at: change.at }))));
    await publishNotices({ realtime: options.realtime, now: deps.now, log: deps.log }, planned);
  };
}

/** Registers the sink (a later call replaces it). */
export function installRealtimeSink(options: RealtimeSinkOptions): void {
  registerSessionNoticeSink(createRealtimeSink(options));
}

/**
 * The events API a Lambda was given, from `REALTIME_HTTP_ENDPOINT` (`https://<id>.appsync-api.<region>.amazonaws.com/event`), signed with the Lambda's own credentials;
 * undefined where there is no API (the feed is still written).
 */
export function realtimeConfigFromEnvironment(env: Record<string, string | undefined> = process.env): RealtimeConfig | undefined {
  const endpoint = env["REALTIME_HTTP_ENDPOINT"];
  if (endpoint === undefined || endpoint === "") return undefined;
  const region = /^[^.]+\.appsync-api\.([a-z0-9-]+)\./u.exec(new URL(endpoint).host)?.[1] ?? env["AWS_REGION"];
  return region === undefined ? undefined : { endpoint, region, credentials: environmentCredentials(env) };
}
