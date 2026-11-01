// Live interaction A3: the broker's wiring for Ask, and the three service routes the chat service calls (`/v1/service/asks/*`, the orchestrator role only).
//
//   POST /v1/service/asks/turn           the waiting Ask's context, built now for its audience and its asker's level now.
//   POST /v1/service/asks/model-access   the turn's model key, paid as a Slack turn is paid (the project's rule), minted only while the asker still "can use" the session.
//   POST /v1/service/asks/answered       the answer (or that there is none): stored, audited, and the waiting Ask is ended once.
//
// The service names an Ask by its org, session and id; it can name only an Ask the broker queued itself, and everything that decides what the turn may know or cost (the audience, the asker, the
// task) comes from the broker's own record of that Ask, never from the request. The switch is OFF by default: with it off (`LIVE_ASK_ENABLED` not exactly "1") nothing is built, every route
// answers NOT_FOUND, and a queued Ask cannot exist.
import { LambdaClient } from "@aws-sdk/client-lambda";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHmac } from "node:crypto";
import { AskModelAccessRequestSchema, AskRefSchema, agentXError, askRequestKey, liveInteractionFlagOn, type HookRecord, type OrgId } from "@agentx/contracts";
import { handleLinearComment, type LinearCommentDependencies } from "../../rovara-code/linear-comments.js";
import { loadTaskPeople } from "../../developer/task-people.js";
import { chosenOwnerNames } from "../../agent-sessions/owner-names.js";
import { effectiveTaskOwner, taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { type AskDependencies, completeAsk, prepareAskTurn, sessionLevelPort } from "../../agent-sessions/ask.js";
import type { AskContextDependencies, AskContextReaders } from "../../agent-sessions/ask-context.js";
import { flushDailyAskCounts } from "../../agent-sessions/ask-audit.js";
import { createAskReaders } from "../../agent-sessions/ask-readers.js";
import { readErasedAliases, sweepErasedAliases } from "../../agent-sessions/ask-erased-aliases.js";
import { sweepExpiredAsks, type AskPerson } from "../../agent-sessions/ask-store.js";
import { createPeekClient, lambdaPeekInvoker, type PeekClient } from "../../agent-sessions/peek-client.js";
import type { SessionAccessDependencies } from "../../agent-sessions/access.js";
import type { DeveloperTaskActions } from "../developer-task-actions.js";
import { installOrgIdFromEnvironment } from "../../org/resolve.js";
import { isErasedActor } from "../../team-record/erased.js";
import { json } from "../json-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { requireLatestProject } from "./records.js";
import { githubScope, modelSourceStoreOf } from "./scope-helpers.js";
import { mintChatTurnKey } from "./model-access.js";
import { parseBody } from "./admin-and-helpers.js";
import { requireSlackServiceRole } from "./workspace-preparation.js";
import type { AwsBrokerDependencies } from "./definitions.js";

/** The label the Ask record carries when the service does not say which model answered. */
const DEFAULT_MODEL_LABEL = "chat-runtime";

/** The hash key for stored questions: derived from the broker's signing key under its own label (an install secret; nothing in code, never logged). */
const questionHashKeyOf = (callbackSigningKey: string): string => createHmac("sha256", callbackSigningKey).update("agentx:ask-question-hash:v1").digest("hex");

/** The people an Ask may name, with the names they are known by (display names; handles are logins, emails and Slack ids). Best effort: an unreadable list gives the asker alone. */
async function peopleOf(dependencies: AwsBrokerDependencies, task: DeveloperTaskRecord, askerId: string | undefined): Promise<AskPerson[]> {
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  const people = await loadTaskPeople(table, task.taskId).catch(() => undefined);
  const ids = new Set<string>([task.developerId, effectiveTaskOwner(task).developerId, ...(askerId === undefined ? [] : [askerId]), ...(people?.people ?? []).map((person) => person.developerId)]);
  const chosen = await chosenOwnerNames(table, ids);
  const stored = new Map<string, { names: Set<string>; handles: Set<string> }>();
  const entry = (developerId: string) => { let found = stored.get(developerId); if (found === undefined) { found = { names: new Set(), handles: new Set() }; stored.set(developerId, found); } return found; };
  for (const id of ids) { const name = chosen.get(id); if (name !== undefined) entry(id).names.add(name); else entry(id); }
  entry(task.developerId).names.add(task.developerName);
  if (task.slackUserId !== undefined) entry(task.developerId).handles.add(task.slackUserId);
  for (const person of people?.people ?? []) { const found = entry(person.developerId); found.names.add(person.name); found.handles.add(person.slackUserId); }
  return [...stored].map(([developerId, found]) => ({ developerId, names: [...found.names].filter((name) => name !== ""), handles: [...found.handles].filter((handle) => handle !== "") }));
}

/** The peek client, where the dispatcher can be invoked (its function ARN is in `DISPATCHER_FUNCTION_ARN`); else none, and the Ask uses the pull request's diff. */
function peekClientOf(dependencies: AwsBrokerDependencies, env: NodeJS.ProcessEnv): PeekClient | undefined {
  const arn = env["DISPATCHER_FUNCTION_ARN"];
  if (arn === undefined || arn.trim() === "") return undefined;
  return createPeekClient({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, invoke: lambdaPeekInvoker(new LambdaClient(process.env["AWS_REGION"] === undefined ? {} : { region: process.env["AWS_REGION"] }), arn) });
}

/** The readers of an Ask's context (the timeline, notes, outsider text and the diff), on the broker's own table and GitHub reads. */
export function askReadersOf(dependencies: AwsBrokerDependencies, actions: DeveloperTaskActions, env: NodeJS.ProcessEnv = process.env): AskContextReaders {
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  const github = dependencies.githubPullRequests;
  return createAskReaders({
    ...table, peek: peekClientOf(dependencies, env),
    pullRequests: github.listPullRequestFiles === undefined ? undefined : {
      pullRequests: (workspaceId) => actions.pullRequests(workspaceId),
      repository: async (orgId, project, revision, repository) => (await actions.projectRevision(orgId, project, revision))?.definition.repositories.find((item) => item.name === repository)?.url,
      files: (url, number, options, scope) => github.listPullRequestFiles!(url, number, options, githubScope(dependencies, scope.orgId)),
    },
  });
}

/**
 * What the Slack task-thread question answers from (`thread-workspaces.ts`): the context dependencies and readers, always (the context builder replaced the Slack-only one whatever the switch says),
 * and the Ask itself (rates, record, audit) only while the `ak` switch is on.
 */
export interface SlackAskDependencies { context: AskContextDependencies; readers: AskContextReaders; ask: AskDependencies | undefined }

/** Installs `dependencies.slackAsk` from the session routes' level dependencies. Without them (no agents on this install) nothing is installed and a thread's task questions are not answered. */
export function installSlackAsk(dependencies: AwsBrokerDependencies, actions: DeveloperTaskActions, access: (SessionAccessDependencies & { ask?: AskDependencies | undefined }) | undefined, env: NodeJS.ProcessEnv = process.env): void {
  const sessionLevel = dependencies.slackAskLevel ?? (access === undefined ? undefined : sessionLevelPort(access));
  if (sessionLevel === undefined) return;
  dependencies.slackAsk = {
    context: { documentClient: dependencies.documentClient, tableName: dependencies.tableName, actions, sessionLevel },
    readers: dependencies.slackAskReaders ?? access?.ask?.readers ?? askReadersOf(dependencies, actions, env),
    ask: access?.ask ?? (dependencies.slackAskOn === true
      ? askDependenciesFor(dependencies, access ?? { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, projectMembers: { roleOf: async () => undefined } }, actions, { ...env, LIVE_ASK_ENABLED: "1" })
      : undefined),
  };
}

/**
 * Everything Ask needs, from the broker's dependencies. Undefined while the switch is off (every Ask route then answers NOT_FOUND), and no queue or session reads are touched.
 * `access` is the session routes' own level dependencies (the same project members and cursor key), so "can use" means what it means everywhere else.
 */
export function askDependenciesFor(dependencies: AwsBrokerDependencies, access: SessionAccessDependencies, actions: DeveloperTaskActions, env: NodeJS.ProcessEnv = process.env): AskDependencies | undefined {
  if (!liveInteractionFlagOn(env["LIVE_ASK_ENABLED"])) return undefined;
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  const now = Date.now;
  return {
    ...table, now, edition: dependencies.editionPolicy?.edition ?? "public", enabled: true, queue: dependencies.developer?.slackRequestQueue, access,
    actions,
    readers: askReadersOf(dependencies, actions, env),
    store: (orgId: OrgId) => ({
      ...table, questionHashKey: questionHashKeyOf(dependencies.callbackSigningKey),
      isErased: (developerId: string) => isErasedActor(table, orgId, "rovara", { sourceId: developerId, developerId }),
      erasedPeople: () => readErasedAliases(table, orgId, now()),
    }),
    audit: { ...table, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }) },
    people: (task, askerId) => peopleOf(dependencies, task, askerId),
    orchestratorInstructions: async (orgId, project) => (await requireLatestProject(dependencies, orgId, project)).definition.orchestratorInstructions,
    defaultModel: DEFAULT_MODEL_LABEL,
    ...(dependencies.linearReply === undefined ? {} : { linearReply: dependencies.linearReply }),
    log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
  };
}

/**
 * The service routes. Answers undefined for a path that is not an Ask route (the caller goes on). Needs the orchestrator role; the Ask names the org, so no Slack thread headers are used or trusted.
 * With the switch off, every Ask route is NOT_FOUND.
 */
export async function handleAskServiceRoute(
  dependencies: AwsBrokerDependencies, ask: AskDependencies | undefined, request: AdaptedHttpRequest, pathname: string,
): Promise<ReturnType<typeof json> | undefined> {
  if (!/^\/v1\/asks\/(turn|model-access|answered)$/u.test(pathname) || request.method !== "POST") return undefined;
  requireSlackServiceRole(dependencies, request);
  if (ask === undefined) throw agentXError("NOT_FOUND", "route not found");
  const body = parseBody(request.body);
  if (pathname === "/v1/asks/turn") return json(await prepareAskTurn(ask, body), request.requestId);
  if (pathname === "/v1/asks/answered") return json(await completeAsk(ask, body), request.requestId);
  // The key: for the Ask's project, in the asker's name (a member), while the asker still "can use" the session. A Linear Ask (no member) is paid by the project.
  const parsed = AskModelAccessRequestSchema.safeParse(body);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "model access for an ask needs the ask and a turn ID");
  const { turnId, model, classifierModel, ...ref } = parsed.data;
  const named = AskRefSchema.parse(ref);
  const record = await ask.documentClient.send(new GetCommand({ TableName: ask.tableName, Key: askRequestKey(named.orgId, named.sessionId, named.askId), ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = record.Item;
  if (item === undefined || item["orgId"] !== named.orgId || item["state"] !== "queued" || typeof item["taskId"] !== "string") throw agentXError("NOT_FOUND", "route not found");
  const task = (await ask.documentClient.send(new GetCommand({ TableName: ask.tableName, Key: taskKey(item["taskId"]), ConsistentRead: true })) as { Item?: DeveloperTaskRecord }).Item;
  if (task === undefined || task.orgId !== named.orgId || task.closedAt !== undefined) throw agentXError("NOT_FOUND", "route not found");
  const askedBy = typeof item["askedBy"] === "string" ? item["askedBy"] : undefined;
  if (askedBy !== undefined) {
    const level = await sessionLevelPort(ask.access)({ orgId: named.orgId, developerId: askedBy }, named.sessionId);
    if (level !== "use" && level !== "edit") throw agentXError("FORBIDDEN", "this question can't be answered now");
  }
  const requester = askedBy === undefined ? undefined : { kind: "developer" as const, developerId: askedBy, provider: task.provider };
  return json(await mintChatTurnKey(dependencies, named.orgId, task.project, requester, { turnId, model, classifierModel }), request.requestId);
}

/** The orgs the maintenance covers: this install's org, and every org with a model-sources record (a page; Public's many orgs are covered over successive days by the saved cursor in the sweep). */
async function orgsToMaintain(dependencies: AwsBrokerDependencies): Promise<OrgId[]> {
  const orgs = new Set<OrgId>();
  try { orgs.add(installOrgIdFromEnvironment()); } catch { /* a multi-tenant deployment names no single org */ }
  try { for (const orgId of await modelSourceStoreOf(dependencies).listOrgs(undefined, 200)) orgs.add(orgId); } catch { /* the directory is best effort */ }
  return [...orgs];
}

/**
 * The daily upkeep of Asks, run from the broker's scheduled session sweep (every 5 minutes; a day marker makes it once a day): deletes the Asks past their 30 days (`sweepExpiredAsks`, for tables with
 * no TTL), the erased people's aliases past theirs, and writes the daily count events of Public (`flushDailyAskCounts`). Bounded, never throws, and does nothing while the switch is off.
 */
export async function runAskMaintenance(dependencies: AwsBrokerDependencies, nowMs: number, env: NodeJS.ProcessEnv = process.env, orgs: (dependencies: AwsBrokerDependencies) => Promise<OrgId[]> = orgsToMaintain): Promise<"off" | "skipped" | "ran" | "failed"> {
  if (!liveInteractionFlagOn(env["LIVE_ASK_ENABLED"])) return "off";
  try {
    const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
    const day = new Date(nowMs).toISOString().slice(0, 10);
    try {
      await dependencies.documentClient.send(new UpdateCommand({
        TableName: dependencies.tableName, Key: { pk: "ASK_MAINTENANCE", sk: "LAST_RUN" }, UpdateExpression: "SET #day = :day, entityType = :type",
        ConditionExpression: "attribute_not_exists(#day) OR #day < :day", ExpressionAttributeNames: { "#day": "day" }, ExpressionAttributeValues: { ":day": day, ":type": "ASK_MAINTENANCE" },
      }));
    } catch (error) {
      if ((error as { name?: string }).name === "ConditionalCheckFailedException") return "skipped";
      throw error;
    }
    const edition = dependencies.editionPolicy?.edition ?? "public";
    for (const orgId of await orgs(dependencies)) {
      await sweepExpiredAsks(table, orgId, nowMs);
      await sweepErasedAliases(table, orgId, nowMs);
      await flushDailyAskCounts({ ...table, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }) }, edition, orgId, nowMs);
    }
    return "ran";
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "ask.maintenance_failed", error: error instanceof Error ? error.name : "unknown" }));
    return "failed";
  }
}

/**
 * The Linear comment intake the hook ingress is offered (`HookIngressDeps.commentIntake`): undefined while the Ask switch is off or Rovara has no way to write in Linear, so nothing a Linear
 * delivery says is read, spent or answered. `taskPageLink` makes the link a refusal sends a person to.
 */
export function linearCommentIntakeOf(dependencies: AwsBrokerDependencies, taskPageLink?: LinearCommentDependencies["taskPageLink"]): ((input: { orgId: OrgId; hook: HookRecord; body: unknown }) => Promise<unknown>) | undefined {
  const ask = dependencies.slackAsk?.ask;
  if (ask === undefined || dependencies.linearReply === undefined) return undefined;
  const deps: LinearCommentDependencies = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, ask, reply: dependencies.linearReply, taskPageLink, log: ask.log };
  return (input) => handleLinearComment(deps, input);
}
