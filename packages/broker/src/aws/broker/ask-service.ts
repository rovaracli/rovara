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
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
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
import { askAliasHashKey, readErasedAliases, scrubWithAliasHashes, sweepErasedAliases } from "../../agent-sessions/ask-erased-aliases.js";
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
import { developerStanding, requesterStandingGuard } from "./dependency-wiring.js";
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
    ask: access?.ask,
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
      // The erased people are known by their label tag alone; their names and handles are kept as keyed hashes and scrubbed by hashing the text's own tokens.
      erasedPeople: async () => (await readErasedAliases(table, orgId, now())).map((entry) => ({ developerId: `erased:${entry.tag}`, tag: entry.tag, names: [], handles: [] })),
      scrubErased: async (text: string) => scrubWithAliasHashes(text, await readErasedAliases(table, orgId, now()), askAliasHashKey(dependencies.callbackSigningKey)),
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
  // SY-7: the asker's standing is read after the level check and asserted again in the write that records the key, so a removal or ban in between refuses the key.
  const guard = askedBy === undefined ? undefined : requesterStandingGuard(dependencies.tableName, await developerStanding(dependencies, named.orgId, askedBy));
  return json(await mintChatTurnKey(dependencies, named.orgId, task.project, requester, { turnId, model, classifierModel }, guard), request.requestId);
}

/** Where the upkeep got to today: the day, the last org done (orgs are walked in id order), and whether the whole walk is finished. */
const MAINTENANCE_KEY = { pk: "ASK_MAINTENANCE", sk: "STATE" };
const ORGS_PER_PAGE = 200;
/** The upkeep stops starting new orgs after this long (the session sweep that runs it has a 30-second function timeout); the next run goes on from where it stopped. */
export const ASK_MAINTENANCE_BUDGET_MS = 15_000;

export interface AskMaintenanceOptions {
  /** The orgs in id order after `after`, at most `limit`. Default: the model-sources directory. */
  listOrgs?: (after: string | undefined, limit: number) => Promise<OrgId[]>;
  pageSize?: number;
  budgetMs?: number;
  /** The clock the budget is measured by (tests). */
  clock?: () => number;
}

/**
 * The daily upkeep of Asks, run from the broker's scheduled session sweep (every 5 minutes): deletes the Asks past their 30 days (`sweepExpiredAsks`, for tables with no TTL), the erased people's
 * aliases past theirs, and writes the daily count events of Public (`flushDailyAskCounts`). It covers EVERY org: this install's own first, then the directory page by page with the cursor saved after
 * each org, so a run cut off by its time budget (or by the function timeout) goes on from there at the next run instead of skipping the day, and the day is marked done only when the last page is.
 * Bounded, never throws, and does nothing while the switch is off. "partial": more orgs wait for the next run.
 */
export async function runAskMaintenance(dependencies: AwsBrokerDependencies, nowMs: number, env: NodeJS.ProcessEnv = process.env, options: AskMaintenanceOptions = {}): Promise<"off" | "skipped" | "partial" | "ran" | "failed"> {
  if (!liveInteractionFlagOn(env["LIVE_ASK_ENABLED"])) return "off";
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const budget = options.budgetMs ?? ASK_MAINTENANCE_BUDGET_MS;
  const pageSize = options.pageSize ?? ORGS_PER_PAGE;
  try {
    const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const saved = ((await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: MAINTENANCE_KEY, ConsistentRead: true }))) as { Item?: { day?: unknown; cursor?: unknown; done?: unknown; installDone?: unknown } }).Item;
    if (saved?.day === day && saved.done === true) return "skipped";
    let cursor = saved?.day === day && typeof saved.cursor === "string" ? saved.cursor : undefined;
    let installDone = saved?.day === day && saved.installDone === true;
    const edition = dependencies.editionPolicy?.edition ?? "public";
    const remember = async (done: boolean): Promise<void> => {
      await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: { ...MAINTENANCE_KEY, entityType: "ASK_MAINTENANCE", day, installDone, done, ...(cursor === undefined ? {} : { cursor }) } }));
    };
    const maintain = async (orgId: OrgId): Promise<void> => {
      // One org's trouble never stops the others.
      try {
        await sweepExpiredAsks(table, orgId, nowMs);
        await sweepErasedAliases(table, orgId, nowMs);
        await flushDailyAskCounts({ ...table, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }) }, edition, orgId, nowMs);
      } catch (error) {
        console.log(JSON.stringify({ component: "broker", event: "ask.maintenance_org_failed", error: error instanceof Error ? error.name : "unknown" }));
      }
    };
    if (!installDone) {
      try { await maintain(installOrgIdFromEnvironment()); } catch { /* a multi-tenant deployment names no single org */ }
      installDone = true;
    }
    const list = options.listOrgs ?? ((after, limit) => modelSourceStoreOf(dependencies).listOrgs(after, limit));
    for (;;) {
      const page = await list(cursor, pageSize);
      for (const orgId of page) {
        if (clock() - startedAt >= budget) { await remember(false); return "partial"; }
        await maintain(orgId);
        cursor = orgId;
      }
      if (page.length < pageSize) { await remember(true); return "ran"; }
      await remember(false);
    }
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
