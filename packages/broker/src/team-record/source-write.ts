// The Team record's source rows, written from the app (learning v2 design 4.2 to 4.4, source-row lane task 2): `POST /v1/app/projects/{project}/record/sources` with one of
//   add      a new source row, for a place that belongs to THIS project (resolved here, never taken from the body);
//   change   retention, who sees it, on/off, the exclusion list; names the revision it read and loses cleanly to any other writer;
//   approve  a different eligible person applies a waiting less-safe change (or the only eligible approver applies their own: the sole-owner exception);
//   reject   anyone who may edit the project's sources drops a waiting change;
//   remove   the next task (answered with a fixed code for now).
// and the admin read, `GET .../record/sources` for a person who may edit (`sourcesAdminView`).
//
// WHO. A company owner or admin, or a maintainer of this project (`projectRole` is the effective role the broker already found, and admins count as maintainers there), on a live browser
// session. The Auditor and everyone below maintainer are refused; a person with no role in the project gets the missing-project answer.
// LESS SAFE (Enterprise only): a retention raise, and adding a private channel, DM or group DM. It is stored as a seven-day waiting change (`SRCCHG#`), audited, and answered 202. Approval is
// read from the company's own records by the shared second-person check (`SecondPersonPort`, bound by the caller): both people's live authority, the sole-owner exception, and conditions that
// commit with the decision. A less-safe write is refused when its audit item cannot be written.
// EVERY WRITE is one transaction: the row (or the waiting change), its scope claim, the request item that makes a repeat answer the same, and the audit item. Refusals are fixed codes and
// sentences; nothing a client sent (a place, an id, a word) is echoed.
import { createHash, randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  SOURCE_CHANGE_REASONS, SOURCE_PROPOSAL_TTL_MS, SourceChangeProposalSchema, SourceConfigSchema, SourceWriteBodySchema, SourcesAdminViewSchema,
  agentXError, canonicalJson, isWriterOrgRole, recordScopeMarkerKey, recordSourceKey,
  type AuditEventInput, type OrgId, type RetentionMode, type SourceChangeProposal, type SourceChangeReason, type SourceConfig, type SourceWriteBody,
} from "@agentx/contracts";
import { updateItem, errorName, isTransactionConflict, NOT_EXISTS } from "../agents/table-writes.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, type AuditDeps, type TransactItem } from "../audit/outbox.js";
import { pauseMatches } from "../lessons/view.js";
import type { SecondPersonPort } from "../org/test-environment.js";
import {
  allowedRetention, checkRetentionChange, slackScopeAllowed, type CompanyLocks, type RecordSourceKind, type SlackScope, type TeamRecordEdition,
} from "./edition.js";
import { retentionRefusal } from "./retention.js";
import { auditRecordSourceAdded, auditRecordSourceChangeDecided, auditRecordSourceChangeProposed, auditRecordSourceChanged } from "./audit.js";
import type { RecordQueryDependencies } from "./query.js";
import type { RecordRouteReply, RecordRouteRequest } from "./routes.js";
import { rovaraScope } from "./sources/rovara.js";
import {
  SOURCE_CHANGES_MAX, claimPut, listSourceChanges, proposalDelete, proposalPut, readScopeClaim, readSourceChange, readSourceRequest, readSourceRow, requestPut,
} from "./source-store.js";
import { listSourceConfigs, sourceRowItem } from "./store.js";

/** What the route needs from the install. */
export interface SourceRouteDependencies {
  edition: TeamRecordEdition;
  /** The numeric GitHub ids of the project's repositories, read live from its latest revision. Undefined (or a throw): the project's places cannot be checked, so nothing is added. */
  projectRepositories(orgId: OrgId, project: string): Promise<readonly number[] | undefined>;
  /** The company's retention ceiling. Absent: none is set. A read that throws refuses the write. */
  locks?(orgId: OrgId): Promise<CompanyLocks | undefined>;
  /** The source keys the learning loop paused (for the admin view). */
  pausedSources?(orgId: OrgId, project: string): Promise<readonly string[]>;
  newId?(): string;
}

/** Who approves, as the company's records read now (the lessons directory's evidence). */
export interface ApproverRoster { complete: boolean; membershipVersion: number; ownerIds: readonly string[]; eligibleIds: readonly string[]; lastEligibleLossAtMs: number | null }

/** What only the broker's request knows, handed in per request by the caller (`aws/developer-routes/team-record-source-write.ts`). */
export interface SourceWriteContext {
  /** The caller's company role. */
  orgRole: string;
  /** True only for a live browser session (never a token). */
  browserSession: boolean;
  /** The parsed request body; throws when it is not JSON. Read only for a write. */
  body(): unknown;
  /** The audit outbox of the State table. Absent (a legacy install): ordinary writes go on without an event, and a less-safe write is refused. */
  audit?: AuditDeps;
  /** The shared second-person check over the company's records. Absent: a decision is refused. */
  secondPerson?: SecondPersonPort;
  /** Who may approve now. Absent: a less-safe change cannot be made. */
  roster?(scope: { orgId: OrgId; project: string }): Promise<ApproverRoster>;
  /** Throws REAUTH_REQUIRED unless the caller signed in within the last ten minutes. */
  freshSignIn(): Promise<void>;
}

const WORDS = {
  browser: "Use a live browser session to change this project's sources.",
  notEditor: "Only a maintainer of this project, or a company admin, can change its sources.",
  invalid: "The request is not valid.",
  place: "That place can't be used as a source for this project.",
  taken: "That place is already used by another project.",
  noSource: "No such source.",
  noChange: "No such change.",
  stale: "This source changed. Reload and try again.",
  expired: "That change expired. Make it again.",
  members: "The people who can approve changed. Make the change again.",
  notOffered: "That retention isn't offered for this source.",
  ceiling: "Your company doesn't allow that much retention for this source.",
  second: "A different eligible person has to approve this.",
  rejecter: "Only the person who made this change, or someone who can approve it, can reject it.",
  eligibility: "Rovara could not check who may approve this. Try again.",
  audit: "This change needs the audit ledger.",
  full: "Too many changes are waiting. Decide some of them first.",
  unavailable: "The sources can't be changed right now.",
} as const;
const invalid = (message: string = WORDS.invalid) => agentXError("CONFIG_INVALID", message);
const stale = (message: string = WORDS.stale) => agentXError("CHANGE_STALE", message);
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", WORDS.unavailable);

const KINDS_WRITABLE = new Set<string>(["github", "rovara"]);
const OFFERED_KINDS: readonly RecordSourceKind[] = ["slack", "github", "codehost", "linear", "jira", "mcp", "rovara"];
const GITHUB_SCOPE = /^github:repo\/([1-9][0-9]{0,14})$/u;

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const bodyHashOf = (body: unknown): string => sha(canonicalJson(body));

/** Who may edit sources: a company role that can write, and a maintainer of this project. */
export function mayEditSources(caller: { projectRole: string | undefined }, write: Pick<SourceWriteContext, "orgRole">): boolean {
  return isWriterOrgRole(write.orgRole) && caller.projectRole === "maintainer";
}

/** The reasons a Slack place needs a second person, from its kind (none is reachable until Slack places are accepted here; the list is generic). */
export function scopeReasons(edition: TeamRecordEdition, kind: SlackScope | undefined): SourceChangeReason[] {
  if (kind === undefined || !slackScopeAllowed(edition, kind).needsSecondPerson) return [];
  return kind === "private_channel" ? ["private_channel"] : kind === "dm" ? ["dm"] : kind === "mpim" ? ["mpim"] : [];
}
const orderedReasons = (reasons: Iterable<SourceChangeReason>): SourceChangeReason[] => { const set = new Set(reasons); return SOURCE_CHANGE_REASONS.filter((reason) => set.has(reason)); };

interface Run {
  deps: RecordQueryDependencies;
  sources: SourceRouteDependencies;
  ctx: SourceWriteContext;
  orgId: OrgId;
  project: string;
  me: string;
  now: () => number;
}
const nowIso = (run: Run): string => new Date(run.now()).toISOString();

function gate(request: RecordRouteRequest, ctx: SourceWriteContext): void {
  if (request.caller.projectRole === undefined) throw agentXError("PROJECT_NOT_FOUND", "No such project.");
  if (!mayEditSources(request.caller, ctx)) throw agentXError("FORBIDDEN", WORDS.notEditor);
  if (!ctx.browserSession) throw agentXError("FORBIDDEN", WORDS.browser);
}

export async function handleSourceWrite(deps: RecordQueryDependencies, request: RecordRouteRequest, project: string): Promise<RecordRouteReply> {
  const sources = deps.sources;
  const ctx = request.write;
  if (sources === undefined || ctx === undefined) throw unavailable();
  gate(request, ctx);
  let raw: unknown;
  try { raw = ctx.body(); } catch { throw invalid(); }
  const parsed = SourceWriteBodySchema.safeParse(raw);
  if (!parsed.success) throw invalid();
  const run: Run = { deps, sources, ctx, orgId: request.caller.orgId, project, me: request.caller.developerId, now: deps.now ?? Date.now };
  const body = parsed.data;
  switch (body.action) {
    case "add": return saveAdd(run, body);
    case "change": return saveChange(run, body);
    case "approve": return approveChange(run, body.changeId);
    case "reject": return rejectChange(run, body.changeId);
    case "remove": return { status: 422, body: { code: "SOURCE_REMOVE_NOT_YET", message: "Removing a source isn't available yet." } };
  }
}

const notYet = (): RecordRouteReply => ({ status: 422, body: { code: "SOURCE_KIND_NOT_YET", message: "That kind of source can't be added yet." } });

// ---- the place

async function checkScope(run: Run, source: string, scope: string): Promise<void> {
  if (source === "rovara") {
    if (scope !== rovaraScope(run.project)) throw invalid(WORDS.place);
    return;
  }
  const match = GITHUB_SCOPE.exec(scope);
  if (match === null) throw invalid(WORDS.place);
  // Read live on every write: a repository that left the project is no longer its place.
  let ids: readonly number[] | undefined;
  try { ids = await run.sources.projectRepositories(run.orgId, run.project); } catch { ids = undefined; }
  if (ids === undefined) throw unavailable();
  if (!ids.includes(Number(match[1]))) throw invalid(WORDS.place);
}

// ---- retention

async function locksOf(run: Run): Promise<CompanyLocks | undefined> {
  try { return await run.sources.locks?.(run.orgId); } catch { throw unavailable(); }
}

/** Whether the retention change is a raise that needs a second person. Refuses what the edition does not offer and what the company's ceiling forbids. */
async function needsSecondPersonForRetention(run: Run, source: string, stored: string | undefined, to: RetentionMode, notesOptIn: boolean): Promise<boolean> {
  const edition = run.sources.edition;
  if (retentionRefusal(edition, source, to, notesOptIn) !== undefined) throw invalid(WORDS.notOffered);
  const locks = await locksOf(run);
  const check = checkRetentionChange({ edition, source, stored, to, ...(locks === undefined ? {} : { locks }) });
  if (!check.ok) throw invalid(check.refusal === "RETENTION_ABOVE_COMPANY_CEILING" ? WORDS.ceiling : WORDS.notOffered);
  return check.needsSecondPerson;
}

// ---- transactions

type Reply = RecordRouteReply;

async function commit(run: Run, items: TransactItem[]): Promise<"ok" | "cancelled"> {
  if (items.length > 100) throw unavailable();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await run.deps.table.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
      return "ok";
    } catch (error) {
      if (isTransactionConflict(error) && attempt < 2) continue;
      if (errorName(error) === "TransactionCanceledException" || isTransactionConflict(error)) return "cancelled";
      throw error;
    }
  }
  return "cancelled";
}

/** The audit items for events. `required`: every event must have its item (a less-safe write), else the write is refused before anything is written. */
function auditItems(run: Run, events: AuditEventInput[], required: boolean): TransactItem[] {
  const items = events.flatMap((event) => auditPending(run.ctx.audit ?? {}, event));
  if (required && items.length !== events.length) throw agentXError("AUDIT_UNAVAILABLE", WORDS.audit);
  return items;
}
async function flush(run: Run, events: AuditEventInput[]): Promise<void> {
  try { await flushAuditEvents(run.ctx.audit ?? {}, events); } catch { /* the pending item stays for the drain */ }
}

async function replayed(run: Run, requestId: string, hash: string): Promise<Reply | undefined> {
  const found = await readSourceRequest(run.deps.table, run.orgId, run.project, run.me, requestId, run.now());
  if (found === undefined) return undefined;
  if (found.bodyHash !== hash) throw invalid();
  return { status: found.status, body: found.reply };
}
const requestItem = (run: Run, requestId: string, hash: string, reply: Reply): TransactItem => requestPut(run.deps.table, run.orgId, run.project, run.me, requestId, { bodyHash: hash, status: reply.status, reply: reply.body }, run.now());

const rowFence = (run: Run, source: string, scope: string, revision: number | null): TransactItem => ({
  ConditionCheck: {
    TableName: run.deps.table.tableName, Key: recordSourceKey(run.orgId, run.project, source, scope),
    ...(revision === null ? { ConditionExpression: NOT_EXISTS }
      : revision === 0 ? { ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(#r) OR #r = :r)", ExpressionAttributeNames: { "#r": "revision" }, ExpressionAttributeValues: { ":r": 0 } }
        : { ConditionExpression: "attribute_exists(pk) AND #r = :r", ExpressionAttributeNames: { "#r": "revision" }, ExpressionAttributeValues: { ":r": revision } }),
  },
});

const rowUpdate = (run: Run, current: SourceConfig, change: { set: Record<string, unknown>; remove?: string[] }, expected: number): TransactItem => updateItem(
  { ...run.deps.table, now: run.now }, recordSourceKey(run.orgId, run.project, current.source, current.scope),
  { set: change.set, ...(change.remove === undefined ? {} : { remove: change.remove }), when: (aliases) => (expected === 0
    ? `attribute_exists(pk) AND (attribute_not_exists(${aliases.name("revision")}) OR ${aliases.name("revision")} = ${aliases.value(0)})`
    : `attribute_exists(pk) AND ${aliases.name("revision")} = ${aliases.value(expected)}`) },
);

// ---- add

async function saveAdd(run: Run, body: Extract<SourceWriteBody, { action: "add" }>): Promise<Reply> {
  if (!KINDS_WRITABLE.has(body.source)) return notYet();
  // A repeat of a request that was answered gets that answer, whatever the place and the company's rules say now.
  const hash = bodyHashOf(body);
  const again = await replayed(run, body.requestId, hash);
  if (again !== undefined) return again;
  await checkScope(run, body.source, body.scope);
  if (body.notesOptIn !== undefined && body.source !== "slack") throw invalid();
  const needsSecond = await needsSecondPersonForRetention(run, body.source, undefined, body.retention, body.notesOptIn === true);
  const table = run.deps.table;
  if ((await readSourceRow(table, run.orgId, run.project, body.source, body.scope)) !== undefined) throw stale();
  const holder = await readScopeClaim(table, run.orgId, body.source, body.scope);
  if (holder !== undefined && holder !== run.project) throw invalid(WORDS.taken);

  const row: Omit<SourceConfig, "revision" | "updatedAt"> = {
    workspaceId: run.orgId, project: run.project, source: body.source, scope: body.scope, enabled: body.enabled, retention: body.retention, exclude: body.exclude ?? [],
    audienceDefault: body.audienceDefault, ...(body.notesOptIn === true ? { notesOptIn: true as const } : {}), health: "unknown", addedBy: run.me,
  };
  const reasons = orderedReasons([...scopeReasons(run.sources.edition, undefined), ...(needsSecond ? (["retention_raise"] as const) : [])]);
  if (reasons.length > 0) return propose(run, { kind: "add", row, reasons, againstRevision: null, requestId: body.requestId, hash });

  const reply: Reply = { status: 200, body: { status: "saved", revision: 1 } };
  const at = nowIso(run);
  const stored = SourceConfigSchema.parse({ ...row, revision: 1, updatedAt: at });
  const events = [auditRecordSourceAdded({ orgId: run.orgId, actorId: run.me, at, occurrence: randomUUID(), project: run.project, source: body.source, scope: body.scope, retention: body.retention, restricted: false })];
  const items: TransactItem[] = [
    { Put: { TableName: table.tableName, Item: sourceRowItem(stored), ConditionExpression: NOT_EXISTS } },
    claimPut(table, run.orgId, run.project, body.source, body.scope, at),
    { Delete: { TableName: table.tableName, Key: recordScopeMarkerKey(run.orgId, body.scope) } }, // saving a row for a closed place opens it again
    requestItem(run, body.requestId, hash, reply),
    ...auditItems(run, events, false),
  ];
  if ((await commit(run, items)) === "ok") { await flush(run, events); return reply; }
  // Cancelled: the same request may have been answered meanwhile, the place may have a row, or another project took it. Read again before deciding.
  const earlier = await replayed(run, body.requestId, hash);
  if (earlier !== undefined) return earlier;
  if ((await readSourceRow(table, run.orgId, run.project, body.source, body.scope)) !== undefined) throw stale();
  const now = await readScopeClaim(table, run.orgId, body.source, body.scope);
  if (now !== undefined && now !== run.project) throw invalid(WORDS.taken);
  throw stale();
}

// ---- change

async function saveChange(run: Run, body: Extract<SourceWriteBody, { action: "change" }>): Promise<Reply> {
  if (!KINDS_WRITABLE.has(body.source)) return notYet();
  if (body.notesOptIn !== undefined && body.source !== "slack") throw invalid();
  const hash = bodyHashOf(body);
  const again = await replayed(run, body.requestId, hash);
  if (again !== undefined) return again;
  const table = run.deps.table;
  const current = await readSourceRow(table, run.orgId, run.project, body.source, body.scope);
  if (current === undefined) throw agentXError("NOT_FOUND", WORDS.noSource);
  const was = current.revision ?? 0;
  if (was !== body.expectedRevision) throw stale();

  const retention = body.retention ?? current.retention;
  const notesOptIn = body.notesOptIn === null ? undefined : body.notesOptIn ?? current.notesOptIn;
  // The starting point of a retention change is the STORED row, never anything the caller says.
  const needsSecond = body.retention !== undefined && body.retention !== current.retention
    ? await needsSecondPersonForRetention(run, body.source, current.retention, body.retention, notesOptIn === true) : false;
  const next = {
    retention, audienceDefault: body.audienceDefault ?? current.audienceDefault, enabled: body.enabled ?? current.enabled, exclude: body.exclude ?? current.exclude,
    ...(notesOptIn === undefined ? {} : { notesOptIn }),
  };
  const reasons = orderedReasons(needsSecond ? ["retention_raise"] : []);
  if (reasons.length > 0) {
    const { revision: _revision, updatedAt: _updatedAt, approval: _approval, lastCursor: _lastCursor, ...base } = current; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out of a proposal's row
    const { notesOptIn: _dropped, ...withoutNotes } = base; // eslint-disable-line @typescript-eslint/no-unused-vars -- set again below
    return propose(run, { kind: "change", row: { ...withoutNotes, ...next }, reasons, againstRevision: was, requestId: body.requestId, hash });
  }

  const revision = was + 1;
  const at = nowIso(run);
  const reply: Reply = { status: 200, body: { status: "saved", revision } };
  const events = [auditRecordSourceChanged({ orgId: run.orgId, actorId: run.me, at, occurrence: randomUUID(), project: run.project, source: body.source, scope: body.scope, fromRetention: current.retention, toRetention: retention, enabled: next.enabled })];
  const items: TransactItem[] = [
    rowUpdate(run, current, { set: { ...next, revision, updatedAt: at }, ...(body.notesOptIn === null ? { remove: ["notesOptIn"] } : {}) }, was),
    requestItem(run, body.requestId, hash, reply),
    ...auditItems(run, events, false),
  ];
  if ((await commit(run, items)) === "ok") { await flush(run, events); return reply; }
  const earlier = await replayed(run, body.requestId, hash);
  if (earlier !== undefined) return earlier;
  throw stale();
}

// ---- a less-safe change waits

const digestOf = (roster: ApproverRoster): string => sha(canonicalJson({ version: roster.membershipVersion, eligible: [...roster.eligibleIds].sort() }));

async function rosterOf(run: Run): Promise<ApproverRoster> {
  if (run.ctx.roster === undefined) throw unavailable();
  let roster: ApproverRoster;
  try { roster = await run.ctx.roster({ orgId: run.orgId, project: run.project }); } catch { throw unavailable(); }
  // An incomplete roster still fingerprints who is listed; whether the sole-owner exception may be used is for the shared second-person check to say, at the decision.
  return roster;
}

async function propose(run: Run, input: { kind: "add" | "change"; row: SourceChangeProposal["row"]; reasons: SourceChangeReason[]; againstRevision: number | null; requestId: string; hash: string }): Promise<Reply> {
  const table = run.deps.table;
  const roster = await rosterOf(run);
  // Changes that have expired (and wait for the table's TTL to remove them) do not count.
  if ((await listSourceChanges(table, run.orgId, run.project, SOURCE_CHANGES_MAX * 3)).filter((change) => Date.parse(change.expiresAt) > run.now()).length >= SOURCE_CHANGES_MAX) throw invalid(WORDS.full);
  const createdAt = nowIso(run);
  const expiresAt = new Date(run.now() + SOURCE_PROPOSAL_TTL_MS).toISOString();
  const proposal = SourceChangeProposalSchema.parse({
    id: run.sources.newId?.() ?? randomUUID(), workspaceId: run.orgId, project: run.project, source: input.row.source, scope: input.row.scope, kind: input.kind, row: input.row,
    reasons: input.reasons, proposedBy: run.me, againstRevision: input.againstRevision, membershipDigest: digestOf(roster), createdAt, expiresAt,
  });
  const reply: Reply = { status: 202, body: { status: "needs_approval", changeId: proposal.id, expiresAt } };
  const events = [auditRecordSourceChangeProposed({ orgId: run.orgId, actorId: run.me, at: createdAt, occurrence: proposal.id, project: run.project, source: proposal.source, scope: proposal.scope, reasons: proposal.reasons })];
  const items: TransactItem[] = [
    proposalPut(table, proposal),
    rowFence(run, proposal.source, proposal.scope, input.againstRevision),
    requestItem(run, input.requestId, input.hash, reply),
    ...auditItems(run, events, true),
  ];
  if ((await commit(run, items)) === "ok") { await flush(run, events); return reply; }
  const earlier = await replayed(run, input.requestId, input.hash);
  if (earlier !== undefined) return earlier;
  throw stale();
}

// ---- approve and reject

function portRefusal(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "CHANGE_STALE") return stale(WORDS.members);
  if (code === "FORBIDDEN") return agentXError("FORBIDDEN", WORDS.second);
  return agentXError("RUNTIME_UNAVAILABLE", WORDS.eligibility);
}

async function approveChange(run: Run, changeId: string): Promise<Reply> {
  await run.ctx.freshSignIn();
  const table = run.deps.table;
  const proposal = await readSourceChange(table, run.orgId, run.project, changeId);
  if (proposal === undefined) throw agentXError("NOT_FOUND", WORDS.noChange);
  if (Date.parse(proposal.expiresAt) <= run.now()) throw stale(WORDS.expired);
  const { source, scope } = proposal;
  const current = await readSourceRow(table, run.orgId, run.project, source, scope);
  if (proposal.kind === "add" ? current !== undefined : current === undefined || (current.revision ?? 0) !== proposal.againstRevision) throw stale();
  // The people who can approve are the ones the change was made for.
  if (digestOf(await rosterOf(run)) !== proposal.membershipDigest) throw stale(WORDS.members);
  if (proposal.kind === "add") {
    await checkScope(run, source, scope);
    const holder = await readScopeClaim(table, run.orgId, source, scope);
    if (holder !== undefined && holder !== run.project) throw invalid(WORDS.taken);
  }
  // The rules are asked again: the company may have set a ceiling since.
  await needsSecondPersonForRetention(run, source, current?.retention, proposal.row.retention, proposal.row.notesOptIn === true);

  if (run.ctx.secondPerson === undefined) throw agentXError("RUNTIME_UNAVAILABLE", WORDS.eligibility);
  let check;
  try { check = await run.ctx.secondPerson({ orgId: run.orgId, project: run.project, proposerId: proposal.proposedBy, approverId: run.me }); } catch (error) { throw portRefusal(error); }
  const samePerson = proposal.proposedBy === run.me;
  if (check.mode === "second_person" ? samePerson : !samePerson) throw agentXError("FORBIDDEN", WORDS.second);
  const soleOwner = check.mode === "sole_owner_exception";

  const at = nowIso(run);
  const row = proposal.row;
  const events = [
    auditRecordSourceChangeDecided({ orgId: run.orgId, actorId: run.me, at, occurrence: `${proposal.id}:approved`, project: run.project, source, scope, decision: "approved", soleOwner, related: samePerson ? [] : [proposal.proposedBy] }),
    ...(proposal.kind === "add"
      ? [auditRecordSourceAdded({ orgId: run.orgId, actorId: run.me, at, occurrence: `${proposal.id}:applied`, project: run.project, source, scope, retention: row.retention, restricted: proposal.reasons.some((reason) => reason !== "retention_raise") })]
      : [auditRecordSourceChanged({ orgId: run.orgId, actorId: run.me, at, occurrence: `${proposal.id}:applied`, project: run.project, source, scope, fromRetention: current!.retention, toRetention: row.retention, enabled: row.enabled })]),
  ];
  const approval = { approvalId: proposal.id, by: run.me, at };
  const revision = proposal.kind === "add" ? 1 : proposal.againstRevision! + 1;
  const apply: TransactItem[] = proposal.kind === "add"
    ? [
      { Put: { TableName: table.tableName, Item: sourceRowItem(SourceConfigSchema.parse({ ...row, revision, updatedAt: at, approval })), ConditionExpression: NOT_EXISTS } },
      claimPut(table, run.orgId, run.project, source, scope, at),
      { Delete: { TableName: table.tableName, Key: recordScopeMarkerKey(run.orgId, scope) } },
    ]
    : [rowUpdate(run, current!, {
      set: { retention: row.retention, audienceDefault: row.audienceDefault, enabled: row.enabled, exclude: row.exclude, approval, revision, updatedAt: at },
      ...(row.notesOptIn === undefined ? { remove: ["notesOptIn"] } : {}),
    }, proposal.againstRevision!)];
  // The row, the end of the waiting change, the audit and both people's live authority commit together.
  const items: TransactItem[] = [...apply, proposalDelete(table, run.orgId, run.project, proposal.id), ...check.conditions, ...auditItems(run, events, true)];
  if ((await commit(run, items)) === "ok") { await flush(run, events); return { status: 200, body: { status: "saved", revision } }; }
  // Read again before saying why.
  if ((await readSourceChange(table, run.orgId, run.project, proposal.id)) === undefined) throw agentXError("NOT_FOUND", WORDS.noChange);
  if (proposal.kind === "add") {
    const holder = await readScopeClaim(table, run.orgId, source, scope);
    if (holder !== undefined && holder !== run.project) throw invalid(WORDS.taken);
  }
  throw stale();
}

async function rejectChange(run: Run, changeId: string): Promise<Reply> {
  const table = run.deps.table;
  const proposal = await readSourceChange(table, run.orgId, run.project, changeId);
  if (proposal === undefined) throw agentXError("NOT_FOUND", WORDS.noChange);
  // The proposer, or a person the company's records list as able to approve it.
  if (proposal.proposedBy !== run.me && !(await rosterOf(run)).eligibleIds.includes(run.me)) throw agentXError("FORBIDDEN", WORDS.rejecter);
  const at = nowIso(run);
  const events = [auditRecordSourceChangeDecided({ orgId: run.orgId, actorId: run.me, at, occurrence: `${proposal.id}:rejected`, project: run.project, source: proposal.source, scope: proposal.scope, decision: "rejected", soleOwner: false, related: proposal.proposedBy === run.me ? [] : [proposal.proposedBy] })];
  const items: TransactItem[] = [proposalDelete(table, run.orgId, run.project, proposal.id), ...auditItems(run, events, false)];
  if ((await commit(run, items)) === "ok") { await flush(run, events); return { status: 200, body: { status: "rejected" } }; }
  throw agentXError("NOT_FOUND", WORDS.noChange); // decided by someone else meanwhile
}

// ---- the admin read

/** What a person who may edit sees on the Sources tab (`SourcesAdminViewSchema`). Anyone else keeps the older reply of the route. */
export async function sourcesAdminView(deps: RecordQueryDependencies, request: RecordRouteRequest, project: string): Promise<unknown> {
  const sources = deps.sources;
  const ctx = request.write;
  if (sources === undefined || ctx === undefined) throw unavailable();
  const orgId = request.caller.orgId;
  const nowMs = (deps.now ?? Date.now)();
  const [rows, changes, paused] = await Promise.all([
    listSourceConfigs(deps.table, orgId, project),
    listSourceChanges(deps.table, orgId, project),
    Promise.resolve(sources.pausedSources?.(orgId, project) ?? ([] as readonly string[])).catch(() => [] as readonly string[]),
  ]);
  const matched = new Set<string>();
  const shown = rows.slice(0, 200).map((row) => {
    const pausedBy = paused.filter((key) => pauseMatches(key, row.source, row.scope));
    for (const key of pausedBy) matched.add(key);
    return {
      kind: row.source, scope: row.scope, enabled: row.enabled, retention: row.retention, ...(row.notesOptIn === true ? { notesOptIn: true as const } : {}), health: row.health, audience: row.audienceDefault,
      excluded: Math.min(200, row.exclude.length), updatedAt: row.updatedAt, paused: pausedBy.length > 0, revision: row.revision ?? 0, addedBy: row.addedBy,
      ...(row.approval === undefined ? {} : { approval: { by: row.approval.by, at: row.approval.at } }), exclude: row.exclude,
    };
  });
  let locks: CompanyLocks | undefined;
  try { locks = await sources.locks?.(orgId); } catch { throw unavailable(); }
  const offered = Object.fromEntries(OFFERED_KINDS.map((kind) => [kind, allowedRetention(sources.edition, kind).filter((mode) => checkRetentionChange({ edition: sources.edition, source: kind, stored: undefined, to: mode, ...(locks === undefined ? {} : { locks }) }).ok)]));
  // TRW-4: the counts of what was left out for want of a linked author, for the project's editors (a read that fails leaves them out).
  const skippedUnlinked = await Promise.resolve(deps.skipped?.read(orgId, project)).catch(() => undefined);
  const roster = await Promise.resolve(ctx.roster?.({ orgId, project })).catch(() => undefined);
  const soleApprover = roster !== undefined && roster.complete && roster.eligibleIds.length === 1 && roster.eligibleIds[0] === request.caller.developerId;
  return SourcesAdminViewSchema.parse({
    sources: shown, otherPaused: paused.filter((key) => !matched.has(key)).length,
    pending: changes.filter((change) => Date.parse(change.expiresAt) > nowMs).slice(0, 100).map((change) => ({
      changeId: change.id, source: change.source, scope: change.scope, kind: change.kind, reasons: change.reasons, proposedByYou: change.proposedBy === request.caller.developerId, expiresAt: change.expiresAt,
    })),
    canEdit: true, soleApprover, offered, ...(skippedUnlinked === undefined ? {} : { skippedUnlinked }),
  });
}
