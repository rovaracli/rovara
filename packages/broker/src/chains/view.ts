// Plan 4 Task 10: what Plan 5's sessions read of a chain run. A run is one session (its id is the session's): `chainRunView` is the run with a section per step attempt,
// `chainRunEvents` its append-only log, `chainStepTask` the chain-scoped read of a step's task, and `listChainRuns` the runs of a chain or a project. The shapes are
// `packages/contracts/src/chain-session.ts`; everything written here is parsed with the strict schema first, so a field that is not in the contract can't reach a client.
//
// Who reads a run: its starter, its owner, anyone with `view` on the chain and on its project, and org owners and admins; anyone else, and any other org, gets
// `NOT_FOUND`, the same as for a run that does not exist. A step's task needs more: a project role with `start_tasks`, so a project viewer keeps the section's summary and
// not the task's detail. Plan 5 passes an internal session actor after its own check of the session's level: it takes the place of the reader rule only (the step task's
// role requirement stays) and is an argument of these functions, never something a route, a query parameter, a header or a body can set.
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { AGENTX_NAME_PATTERN, CHAIN_RUN_EVENTS_PAGE_MAX, CHAIN_RUN_LIST_PAGE_MAX, CHAIN_RUN_STATUSES, CHAIN_SESSION_CONTRACT_VERSION, STEP_LINK_URL_MAX, ChainIdSchema, ChainRunEventPageSchema, ChainRunIdSchema, ChainRunListSchema, ChainRunViewSchema, ROVARA_CODE_AGENT_ID, agentXError, atLeast, capText, chainRunKey, chainRunsByChainPk, chainRunsByProjectPk, projectAllows, redactText, runEventSk, type ChainRunEventPage, type ChainRunList, type ChainRunStatus, type ChainRunSection, type ChainRunSummary, type ChainRunView, type OrgId, type PinnedChainDefinition } from "@rovara-code/contracts";
import { ChainStepTaskViewSchema, type ChainStepTaskView, type DeveloperTaskView } from "@agentx/cloud-contracts";
import { orgRoleOf, type AgentCaller } from "../agents/access.js";
import { confirmUrlFor, getAnyApproval, mayDecideApproval, shownText, type AnyApprovalRecord } from "../agents/approvals.js";
import { sameMember } from "../agents/lifecycle.js";
import type { DeveloperTaskRecord } from "../developer/task-records.js";
import { taskKey } from "../developer/task-records.js";
import { chainAccess } from "./access.js";
import { gateStepOf } from "./answered-gate.js";
import { displayNameOf, wordsFor } from "./gates.js";
import { getItem, readChainRun, readStepAttempt, readStepAttempts, type ChainRunRecord, type StepAttemptRecord } from "./runner.js";
import type { ChainRouteDependencies } from "./routes.js";

export type { ChainRunList, ChainRunView, ChainStepTaskView };

/** Who asks for a read after Plan 5 has checked the session's level: a developer of the org the caller names. */
export interface ChainSessionActor { kind: "session"; developerId: string }
/** An internal option of the reads below. No route sets it. */
export interface ChainViewOptions { actor?: ChainSessionActor }

/** What the view asks of the task layer (Plan 3), which builds it: absent, a run view has no cost or open approvals, and a step's task can't be read. */
export interface ChainViewPorts {
  /** Plan 3's task view of a chain step's task, as a reader of the chain run is shown it (no owner or participant check: the caller's right was checked). Never holds an approval's arguments or a credential. */
  taskView(task: DeveloperTaskRecord): Promise<DeveloperTaskView>;
  /** What a step's task has settled so far and how many approvals it waits on; undefined when the task can't be read. */
  taskFacts(orgId: OrgId, taskId: string): Promise<{ spentUsd: number; pendingApprovals: number } | undefined>;
}

type Deps = ChainRouteDependencies;
type Link = { label: string; url: string };

const notFound = () => agentXError("NOT_FOUND", "no chain run has that ID");
const MAX_EVENT_SEQ = 999_999;
const MAX_STEP_SEQ = 9999;
const NAME_MAX = 80;
const LIST_SCAN_MAX = 200;
const LIST_QUERY_PAGE = 100;
const CURSOR_SK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#crn_[0-9a-z]{20}$/;
const RUN_STATUSES: readonly string[] = CHAIN_RUN_STATUSES;

// ---- who reads

/** The caller as the person they are for this read: the actor's developer when Plan 5 passes one, with the org the caller names. */
async function readerOf(deps: Deps, caller: AgentCaller, options: ChainViewOptions): Promise<AgentCaller | undefined> {
  if (options.actor === undefined) return caller;
  // The actor is read live: a person who is not a member of the org is nobody here.
  const orgRole = await orgRoleOf(deps, caller.orgId, options.actor.developerId);
  return orgRole === undefined ? undefined : { orgId: caller.orgId, developerId: options.actor.developerId, orgRole };
}

/** What a list asks again of each run it shows: the answer for a chain and a project is the same for every run of them. */
type ReadMemo = Map<string, Promise<boolean>>;

/** Whether `reader` reads `run`: the starter, the run's owner, an org owner or admin, or anyone with `view` on the chain (read now) and on the run's project. */
export async function mayReadRun(deps: Deps, reader: AgentCaller, run: ChainRunRecord, memo?: ReadMemo): Promise<boolean> {
  if (reader.orgId !== run.orgId) return false;
  if (run.startedBy.kind === "member" && await sameMember(deps, run.orgId, run.startedBy.developerId, reader.developerId)) return true;
  if (await sameMember(deps, run.orgId, run.owner.developerId, reader.developerId)) return true;
  if (reader.orgRole === "owner" || reader.orgRole === "admin") return true;
  const key = `${run.chainId}|${run.project}`;
  const known = memo?.get(key);
  if (known !== undefined) return known;
  const answer = viewsChainAndProject(deps, reader, run);
  memo?.set(key, answer);
  return answer;
}

async function viewsChainAndProject(deps: Deps, reader: AgentCaller, run: ChainRunRecord): Promise<boolean> {
  if (deps.chains === undefined) return false;
  const chain = await deps.chains.get(run.orgId, run.chainId);
  if (chain === undefined) return false;
  if (!atLeast(await chainAccess({ ...deps, store: deps.chains }, reader, chain), "view")) return false;
  const role = await deps.projectMembers.roleOf(run.orgId, run.project, { developerId: reader.developerId, orgRole: reader.orgRole });
  return role !== undefined && projectAllows(role, "view");
}

/** The run, when the caller may read it (or Plan 5 has checked for them); otherwise `NOT_FOUND`, whatever the reason. */
async function readableRun(deps: Deps, caller: AgentCaller, rawRunId: string, options: ChainViewOptions): Promise<{ run: ChainRunRecord; reader: AgentCaller }> {
  const id = ChainRunIdSchema.safeParse(rawRunId);
  if (!id.success) throw notFound();
  const run = await readChainRun(deps, caller.orgId, id.data);
  if (run === undefined) throw notFound();
  const reader = await readerOf(deps, caller, options);
  if (reader === undefined) throw notFound();
  if (options.actor === undefined && !(await mayReadRun(deps, reader, run))) throw notFound();
  return { run, reader };
}

// ---- the view

const clean = (text: string): string => shownText(text, NAME_MAX);
/**
 * A vendor's link, neutralised like any text but never cut short (half a link is another link): one that changes under cleaning, or is no link, is left out. The cleaning is
 * `shownText`'s (secrets redacted, control characters and spacing, a length cap) without its email rule: an at sign in a link's path or query is part of the link, and hiding it would break
 * the link (S3-L4). The text beside a link (its title) still goes through `shownText`.
 */
function cleanUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const shown = capText(redactText(url).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim(), STEP_LINK_URL_MAX).text;
  // A link that carries a login (`https://user:secret@host/`) is no link to show.
  return shown === url && URL.canParse(shown) && new URL(shown).username === "" && new URL(shown).password === "" ? shown : undefined;
}

function startedByOf(deps: Deps, run: ChainRunRecord): Promise<ChainRunView["startedBy"]> | ChainRunView["startedBy"] {
  const started = run.startedBy;
  if (started.kind === "member") return displayNameOf(deps, started.developerId).then((name) => ({ kind: "member" as const, developerId: started.developerId, name }));
  if (started.kind === "event") {
    const url = cleanUrl(started.url);
    return { kind: "event", triggerId: started.triggerId, source: started.source, type: started.type, title: clean(started.title), ...(url === undefined ? {} : { url }) };
  }
  return { kind: "schedule", triggerId: started.triggerId, scheduledAt: started.scheduledAt };
}

async function chainOwnerOf(deps: Deps, owner: ChainRunRecord["chainOwner"]): Promise<ChainRunView["chainOwner"]> {
  return owner.kind === "member"
    ? { kind: "member", id: owner.developerId, name: await displayNameOf(deps, owner.developerId) }
    : { kind: "project", id: owner.project, name: owner.project };
}

/** How a gate's approval stands, from its record; a record that can't be read leaves it to the attempt. */
function gateStatusOf(record: AnyApprovalRecord | undefined, attempt: StepAttemptRecord): NonNullable<ChainRunSection["gate"]>["status"] {
  if (record !== undefined) {
    if (record.status === "PENDING") return "PENDING";
    if (record.status === "DECLINED") return "DECLINED";
    if (record.status === "EXPIRED") return "EXPIRED";
    return "APPROVED";
  }
  if (attempt.decision === "approved") return "APPROVED";
  if (attempt.decision === "declined") return "DECLINED";
  return attempt.status === "waiting" ? "PENDING" : "EXPIRED";
}

async function gateSection(deps: Deps, run: ChainRunRecord, attempt: StepAttemptRecord, definition: PinnedChainDefinition | undefined, reader: AgentCaller | undefined): Promise<ChainRunSection["gate"]> {
  if (attempt.approvalId === undefined) return undefined;
  const step = gateStepOf(definition, attempt);
  if (step === undefined) return undefined;
  const record = await getAnyApproval(deps, run.orgId, attempt.approvalId).catch(() => undefined);
  const decidedBy = record?.decidedBy;
  return {
    prompt: clean(step.prompt),
    status: gateStatusOf(record, attempt),
    approvers: await wordsFor(deps, run, step),
    // Only a person who may decide this gate, reading the run's own route, is given its page: a session viewer and any other reader are not.
    ...(reader !== undefined && record !== undefined && await mayDecideApproval(deps, reader, record).catch(() => false) ? { confirmUrl: confirmUrlFor(deps, { approvalId: attempt.approvalId }) } : {}),
    ...(decidedBy === undefined || record?.decidedAt === undefined ? {} : { decidedBy: { developerId: decidedBy, name: await displayNameOf(deps, decidedBy) }, decidedAt: record.decidedAt }),
  };
}

function branchSection(attempt: StepAttemptRecord, definition: PinnedChainDefinition | undefined): ChainRunSection["branchTaken"] {
  if (attempt.branch === undefined) return undefined;
  const step = definition?.steps.find((candidate) => candidate.id === attempt.stepId);
  const choice = step?.kind === "agent" && step.next.kind === "branch" ? step.next.choices.find((candidate) => candidate.id === attempt.branch?.id) : undefined;
  return { id: attempt.branch.id, description: choice?.description ?? "", fellBack: attempt.branch.fellBack };
}

/** A task's settled spend and open approvals, or nothing when the task layer is absent or can't say: a view never fails for a figure. */
async function taskFactsOf(deps: Deps, run: ChainRunRecord, attempt: StepAttemptRecord): Promise<{ spentUsd: number; pendingApprovals: number } | undefined> {
  if (deps.chainView === undefined || attempt.taskId === undefined) return undefined;
  try {
    return await deps.chainView.taskFacts(run.orgId, attempt.taskId);
  } catch {
    return undefined;
  }
}

async function sectionOf(deps: Deps, run: ChainRunRecord, attempt: StepAttemptRecord, definition: PinnedChainDefinition | undefined, reader: AgentCaller | undefined): Promise<ChainRunSection> {
  const isGate = attempt.kind === "gate";
  const facts = isGate ? undefined : await taskFactsOf(deps, run, attempt);
  const gate = isGate ? await gateSection(deps, run, attempt, definition, reader) : undefined;
  const branchTaken = branchSection(attempt, definition);
  const links: Link[] | undefined = attempt.result?.links;
  return {
    seq: attempt.seq,
    stepId: attempt.stepId,
    name: clean(attempt.stepName),
    kind: attempt.kind,
    status: attempt.status,
    attempt: attempt.attempt,
    startedAt: attempt.startedAt,
    ...(attempt.endedAt === undefined ? {} : { endedAt: attempt.endedAt }),
    ...(attempt.agent === undefined ? {} : { agent: { agentId: attempt.agent.agentId, name: attempt.agent.name, version: attempt.agent.version } }),
    ...(facts === undefined ? {} : { costUsd: facts.spentUsd, pendingApprovals: facts.pendingApprovals }),
    ...(attempt.stopAtUsd === undefined ? {} : { stopAtUsd: attempt.stopAtUsd }),
    ...(attempt.result === undefined ? {} : { report: attempt.result.report }),
    ...(links === undefined || links.length === 0 ? {} : { links }),
    ...(branchTaken === undefined ? {} : { branchTaken }),
    ...(gate === undefined ? {} : { gate }),
    ...(!isGate && attempt.taskId !== undefined ? { detail: { kind: "task" as const, taskId: attempt.taskId, rovaraCode: attempt.agent?.agentId === ROVARA_CODE_AGENT_ID } } : {}),
  };
}

async function definitionOf(deps: Deps, run: ChainRunRecord): Promise<PinnedChainDefinition | undefined> {
  return (await deps.chains?.getVersion(run.orgId, run.chainId, run.chainVersion).catch(() => undefined))?.definition;
}

async function summaryParts(deps: Deps, run: ChainRunRecord) {
  const [owner] = await Promise.all([displayNameOf(deps, run.owner.developerId)]);
  return {
    contractVersion: CHAIN_SESSION_CONTRACT_VERSION,
    sessionId: run.runId,
    kind: "chain" as const,
    chain: { chainId: run.chainId, name: clean(run.chainName), version: run.chainVersion },
    project: run.project,
    owner: { developerId: run.owner.developerId, name: owner },
    status: run.status,
    currentSeq: run.currentSeq,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    cost: { spentUsd: run.spentUsd, runLimitUsd: run.runLimitUsd },
  };
}

/** `GET /v1/app/chain-runs/{id}`: the run, one section per step attempt in `seq` order. */
export async function chainRunView(deps: Deps, caller: AgentCaller, runId: string, options: ChainViewOptions = {}): Promise<ChainRunView> {
  const { run, reader } = await readableRun(deps, caller, runId, options);
  const [attempts, definition] = await Promise.all([readStepAttempts(deps, run.orgId, run.runId), definitionOf(deps, run)]);
  const [header, startedBy, chainOwner, sections] = await Promise.all([
    summaryParts(deps, run), startedByOf(deps, run), chainOwnerOf(deps, run.chainOwner), Promise.all(attempts.map((attempt) => sectionOf(deps, run, attempt, definition, options.actor === undefined ? reader : undefined))),
  ]);
  return ChainRunViewSchema.parse({
    ...header, chainOwner, startedBy,
    ...(run.failure === undefined ? {} : { failure: { reason: run.failure.reason, message: run.failure.message } }),
    sections,
  });
}

// ---- the event log

/** `GET /v1/app/chain-runs/{id}/events?after=`: the events after `after` (0 for all), at most 200, `next` the last `seq` of a full page that more follow. */
export async function chainRunEvents(deps: Deps, caller: AgentCaller, runId: string, after: number, options: ChainViewOptions = {}): Promise<ChainRunEventPage> {
  if (!Number.isInteger(after) || after < 0 || after > MAX_EVENT_SEQ) throw agentXError("CONFIG_INVALID", `after: must be a whole number from 0 to ${String(MAX_EVENT_SEQ)}`);
  const { run } = await readableRun(deps, caller, runId, options);
  if (after === MAX_EVENT_SEQ) return ChainRunEventPageSchema.parse({ events: [] });
  const found = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to", ExpressionAttributeValues: { ":pk": chainRunKey(run.orgId, run.runId, "META").pk, ":from": runEventSk(after + 1), ":to": runEventSk(MAX_EVENT_SEQ) },
    ConsistentRead: true, Limit: CHAIN_RUN_EVENTS_PAGE_MAX + 1,
  })) as { Items?: Array<Record<string, unknown>> };
  const rows = found.Items ?? [];
  const page = rows.slice(0, CHAIN_RUN_EVENTS_PAGE_MAX);
  const events = page.filter((row) => row["orgId"] === run.orgId).map((row) => ({
    seq: row["seq"], at: row["at"], type: row["type"], ...(row["stepSeq"] === undefined ? {} : { stepSeq: row["stepSeq"] }), text: row["text"],
  }));
  const last = events.at(-1);
  return ChainRunEventPageSchema.parse({ events, ...(rows.length > CHAIN_RUN_EVENTS_PAGE_MAX && last !== undefined ? { next: last.seq } : {}) });
}

// ---- a step's task

/** A step's task as a viewer of the run sees it: its open approvals name what is asked, never the page that decides them (whoever decides finds it from their own approvals). */
function withoutConfirmLinks(task: DeveloperTaskView): DeveloperTaskView {
  const run = task.run;
  if (run === undefined) return task;
  return { ...task, run: { ...run, pendingApprovals: run.pendingApprovals.map((approval) => {
    // Only the link goes: any other field is left for the strict schema to refuse.
    const { ...kept } = approval;
    delete kept.confirmUrl;
    return kept;
  }) } };
}

/**
 * `GET /v1/app/chain-runs/{id}/sections/{seq}/task`: the task of the step attempt `seq`, as Plan 3's task view shows it, for a reader of the run who holds `start_tasks`
 * on its project (a project viewer gets `NOT_FOUND` and keeps the section's summary). The attempt must have a task, and the task must be this run's, in this org.
 */
export async function chainStepTask(deps: Deps, caller: AgentCaller, runId: string, seq: number, options: ChainViewOptions = {}): Promise<ChainStepTaskView> {
  const { run, reader } = await readableRun(deps, caller, runId, options);
  const role = await deps.projectMembers.roleOf(run.orgId, run.project, { developerId: reader.developerId, orgRole: reader.orgRole });
  if (role === undefined || !projectAllows(role, "start_tasks")) throw notFound();
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_STEP_SEQ) throw notFound();
  const attempt = await readStepAttempt(deps, run.orgId, run.runId, seq);
  if (attempt === undefined || attempt.kind !== "agent" || attempt.taskId === undefined) throw notFound();
  const stored = await getItem(deps, taskKey(attempt.taskId));
  const chain = stored?.["chain"] as { chainRunId?: unknown } | undefined;
  if (stored === undefined || stored["orgId"] !== run.orgId || chain?.chainRunId !== run.runId) throw notFound();
  if (deps.chainView === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "A step's task can't be shown in this deployment.");
  const task = withoutConfirmLinks(await deps.chainView.taskView(stored as unknown as DeveloperTaskRecord));
  const shown = ChainStepTaskViewSchema.safeParse({ seq, taskId: attempt.taskId, rovaraCode: attempt.agent?.agentId === ROVARA_CODE_AGENT_ID, task });
  // What the task layer gave is checked against the contract before a client sees it: an approval's arguments or a credential would not parse.
  if (!shown.success) throw agentXError("RUNTIME_UNAVAILABLE", "This step's task can't be shown right now.");
  return shown.data;
}

// ---- the list

export interface ChainRunQuery { chain?: string | undefined; project?: string | undefined; status?: string | undefined; cursor?: string | undefined }

const encodeCursor = (sk: string): string => Buffer.from(JSON.stringify({ sk }), "utf8").toString("base64url");
function decodeCursor(value: string): string {
  const invalid = () => agentXError("CONFIG_INVALID", "cursor: is not valid; list the runs again without a cursor");
  if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { sk?: unknown };
    if (typeof parsed.sk === "string" && CURSOR_SK.test(parsed.sk)) return parsed.sk;
  } catch {
    // falls through to the refusal
  }
  throw invalid();
}

function summaryOf(parts: Awaited<ReturnType<typeof summaryParts>>): ChainRunSummary {
  return parts;
}

/**
 * `GET /v1/app/chain-runs?chain=&project=&status=&cursor=`: the runs of a chain or a project, newest first, only those the caller reads, 50 to a page. The cursor holds the
 * sort key of the last index row looked at (the partition is always the caller's own org's); it grants nothing and a forged one can only start the list elsewhere.
 */
export async function listChainRuns(deps: Deps, caller: AgentCaller, query: ChainRunQuery): Promise<ChainRunList> {
  const chain = query.chain === undefined ? undefined : ChainIdSchema.safeParse(query.chain);
  if (chain !== undefined && !chain.success) throw agentXError("CONFIG_INVALID", "chain: is not a chain ID");
  if (query.project !== undefined && !AGENTX_NAME_PATTERN.test(query.project)) throw agentXError("CONFIG_INVALID", "project: is not a project name");
  if (query.status !== undefined && !RUN_STATUSES.includes(query.status)) throw agentXError("CONFIG_INVALID", `status: must be one of ${CHAIN_RUN_STATUSES.join(", ")}`);
  if (chain === undefined && query.project === undefined) throw agentXError("CONFIG_INVALID", "chain or project: name the chain or the project whose runs to list");
  const partition = chain?.success === true ? chainRunsByChainPk(caller.orgId, chain.data) : chainRunsByProjectPk(caller.orgId, query.project!);
  const memo: ReadMemo = new Map();
  const found: ChainRunSummary[] = [];
  let startSk = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  let scanned = 0;
  let next: string | undefined;
  for (;;) {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": partition }, ScanIndexForward: false, ConsistentRead: true,
      Limit: Math.min(LIST_QUERY_PAGE, LIST_SCAN_MAX - scanned), ...(startSk === undefined ? {} : { ExclusiveStartKey: { pk: partition, sk: startSk } }),
    })) as { Items?: Array<Record<string, unknown>>; LastEvaluatedKey?: Record<string, unknown> };
    const rows = page.Items ?? [];
    for (const [index, row] of rows.entries()) {
      scanned += 1;
      const sk = String(row["sk"]);
      const summary = await listedRun(deps, caller, row, { chain: chain?.success === true ? chain.data : undefined, project: query.project, status: query.status }, memo);
      if (summary !== undefined) found.push(summary);
      if (found.length === CHAIN_RUN_LIST_PAGE_MAX) {
        if (index + 1 < rows.length || page.LastEvaluatedKey !== undefined) next = sk;
        return ChainRunListSchema.parse({ runs: found, ...(next === undefined ? {} : { next: encodeCursor(next) }) });
      }
    }
    if (page.LastEvaluatedKey === undefined) break;
    startSk = String(rows.at(-1)?.["sk"] ?? page.LastEvaluatedKey["sk"]);
    if (scanned >= LIST_SCAN_MAX) {
      next = startSk;
      break;
    }
  }
  return ChainRunListSchema.parse({ runs: found, ...(next === undefined ? {} : { next: encodeCursor(next) }) });
}

/** The run an index row names, as a summary, when it is the caller's org's, matches the filters and the caller reads it. */
async function listedRun(deps: Deps, caller: AgentCaller, row: Record<string, unknown>, filters: { chain: string | undefined; project: string | undefined; status: string | undefined }, memo: ReadMemo): Promise<ChainRunSummary | undefined> {
  const id = ChainRunIdSchema.safeParse(row["runId"]);
  if (!id.success || row["orgId"] !== caller.orgId) return undefined;
  const run = await readChainRun(deps, caller.orgId, id.data);
  if (run === undefined) return undefined;
  if (filters.chain !== undefined && run.chainId !== filters.chain) return undefined;
  if (filters.project !== undefined && run.project !== filters.project) return undefined;
  if (filters.status !== undefined && run.status !== (filters.status as ChainRunStatus)) return undefined;
  if (!(await mayReadRun(deps, caller, run, memo))) return undefined;
  return summaryOf(await summaryParts(deps, run));
}
