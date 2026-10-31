// Meta repo lane F (F1): one rule for a ticket that asks for work, whatever tracker it is from (design 3.7).
//
//   A task starts only from a MEMBER ACT. The act is checked, not the label: who put the label on, or assigned the ticket, is resolved to a member of the org (a link the
//   tracker's account has to a member, read live) who holds a role on the project that starts tasks. Anything else waits:
//     - someone outside the company, or an account no member is linked to      -> waits for a member to say "Start"  (reason `outsider`)
//     - an automation                                                          -> waits (reason `bot`); Rovara's own account starts nothing (the loop guard)
//     - a member who may not start tasks on the project                        -> waits (reason `no_authority`)
//   The ticket's text is data: it is framed as untrusted, redacted and made inert (`ticket-text.ts`), and nothing in it can name a person, a project, a budget or a tool.
//
//   One session per ticket: the ticket is one item (`store.ts`), claimed with a conditional write, so a poll that sees the ticket again, a webhook delivered twice or two members
//   pressing "Start" at once start it once. A start that is refused (the budget, the project) leaves the ticket waiting, with the refusal's code, for a member to try again; a fault
//   that may pass (the start service away) is thrown, after the ticket is given back, so the poll or the webhook's retry does it again.
//
// Nothing here knows a tracker. An adapter (a webhook provider, a poll's search) turns its tracker's words into an `IntakeCandidate`; this file decides.
import {
  AgentXError,
  INTAKE_TITLE_MAX,
  IntakeExternalRefSchema,
  intakeItemIdOf,
  type CodeIntentRequest,
  type IntakeExternalRef,
  type IntakeStanding,
  type IntakeTrackerChannel,
  type IntakeWaitReason,
  type OrgId,
  type SessionBinding,
} from "@agentx/contracts";
import { ticketRunInput, inertTitle, inertTicketLine, inertWriter, prepareTicketBody, WAITING_BODY_MAX_BYTES } from "./ticket-text.js";
import { intakeRequestId } from "./ids.js";
import { claimIntakeItem, claimIntakeStart, giveBackIntakeItem, listWaitingIntakeItems, markIntakeStarted, readIntakeItem, releaseIntakeItem, INTAKE_MAX_WAITING_PER_PROJECT, type IntakeItemRecord, type IntakeTable } from "./store.js";

/** Who made the act that asks for work, as the tracker's adapter knows them. Only `accountId` can ever make them a member, and only through a link the org holds. */
export interface IntakeActor {
  kind: "person" | "bot" | "rovara" | "unknown";
  /** The tracker's stable id for the account (never an email or a name taken from the ticket's text). */
  accountId?: string;
  display?: string;
}

/** What a channel's adapter hands the engine for one ticket. Every string is outsider-written text until the engine has made it safe. */
export interface IntakeCandidate {
  orgId: OrgId;
  project: string;
  channel: IntakeTrackerChannel;
  externalRef: IntakeExternalRef;
  title: string;
  body?: string | undefined;
  /** Who wrote the ticket (shown to the session as information about the text; never trusted). */
  reporter?: { display?: string | undefined } | undefined;
  /** Who made the act that asks for work. Absent for a poll that can't tell: then nobody is known to be a member and the ticket waits. */
  actor?: IntakeActor | undefined;
  /** The ticket's text is read for the session once, now. */
  occurredAt?: string | undefined;
}

export type IntakeOutcome =
  | { outcome: "started"; taskId: string; sessionId?: string | undefined }
  | { outcome: "waiting"; reason: IntakeWaitReason }
  | { outcome: "duplicate"; state: IntakeItemRecord["state"] }
  | { outcome: "skipped"; reason: "caused_by_rovara" | "invalid" | "waiting_full" };

/** What the engine reads and does outside itself. Each is the broker's own function in production; the tests supply others. */
export interface IntakePorts {
  table: IntakeTable;
  log(event: string, fields: Record<string, unknown>): void;
  /** The member of the org this tracker account is linked to, read now (a member who is removed or revoked is nobody), or undefined. */
  memberOfAccount(orgId: OrgId, system: string, accountId: string): Promise<string | undefined>;
  /** Whether the member, read now, holds a role on the project that starts tasks. A read that failed throws. */
  mayStart(orgId: OrgId, developerId: string, project: string): Promise<boolean>;
  /** `startCodeIntent`, as that member. Throws what a start throws. */
  start(orgId: OrgId, developerId: string, request: CodeIntentRequest): Promise<{ task: { taskId: string }; sessionId?: string | undefined }>;
  /** The session this ticket already follows in the org (a binding, whoever made it), or undefined. */
  sessionOfTicket(orgId: OrgId, binding: Extract<SessionBinding, { kind: "tracker_item" }>): Promise<{ sessionId: string } | undefined>;
  /** Tells the project's maintainers once that a flood of waiting tickets is not being stored (optional). */
  notifyWaitingFull?(orgId: OrgId, project: string): Promise<void>;
}

const errorCode = (error: unknown): string => (error instanceof AgentXError ? error.code : error instanceof Error ? error.name : "unknown");
/** A start's own refusal that will not pass by itself (the budget, the project, the process). A busy answer and anything from 500 up may pass, and are thrown to be tried again. */
const BUSY_CODES: ReadonlySet<string> = new Set(["WORKSPACE_BUSY", "TOO_MANY_REQUESTS"]);
const isPassing = (error: unknown): boolean => error instanceof AgentXError && error.statusCode < 500 && !BUSY_CODES.has(error.code);

interface Resolved {
  standing: IntakeStanding;
  developerId?: string;
  /** With `waiting` as the outcome of this: why. Absent when the act may start work. */
  reason?: IntakeWaitReason;
}

/**
 * Who asked, as the org knows them. A `person` with a linked account who holds a role that starts tasks is a member who may start. A linked member without that role is a member who
 * waits for someone who has it. Everything else is an outsider or a bot; an actor that is Rovara's own never reaches here.
 */
async function resolveStanding(ports: IntakePorts, candidate: IntakeCandidate): Promise<Resolved> {
  const actor = candidate.actor;
  if (actor === undefined || actor.kind === "unknown") return { standing: "outsider", reason: "outsider" };
  if (actor.kind === "bot") return { standing: "bot", reason: "bot" };
  if (actor.accountId === undefined) return { standing: "outsider", reason: "outsider" };
  const developerId = await ports.memberOfAccount(candidate.orgId, candidate.externalRef.system, actor.accountId);
  if (developerId === undefined) return { standing: "outsider", reason: "outsider" };
  if (!await ports.mayStart(candidate.orgId, developerId, candidate.project)) return { standing: "member", developerId, reason: "no_authority" };
  return { standing: "member", developerId };
}

function requestOf(record: Pick<IntakeItemRecord, "orgId" | "project" | "system" | "id" | "url" | "channel">, input: CodeIntentRequest["input"], developerId: string): CodeIntentRequest {
  const source = record.channel;
  return {
    requestId: intakeRequestId(record.orgId, record.system, record.id, developerId), project: record.project, input, source,
    binding: { kind: "tracker_item", system: record.system, id: record.id, url: record.url },
  };
}

/** The ticket's own link and ids were checked by the schema; build the binding the session follows. */
const bindingOf = (record: Pick<IntakeItemRecord, "system" | "id" | "url">): Extract<SessionBinding, { kind: "tracker_item" }> => ({ kind: "tracker_item", system: record.system, id: record.id, url: record.url });

/**
 * Starts the ticket that this caller already holds (`starting`) as `developerId`. A start that is refused leaves it waiting with the refusal's code; a start that finds the ticket already
 * has a session records that session; a fault that may pass gives the item back and is thrown.
 */
async function startHeld(ports: IntakePorts, record: IntakeItemRecord, input: CodeIntentRequest["input"], developerId: string, created: boolean): Promise<IntakeOutcome> {
  const { table } = ports;
  const { orgId, project, itemId } = record;
  const existing = await ports.sessionOfTicket(orgId, bindingOf(record));
  if (existing !== undefined) {
    await markIntakeStarted(table, orgId, project, itemId, { sessionId: existing.sessionId });
    return { outcome: "duplicate", state: "started" };
  }
  try {
    const started = await ports.start(orgId, developerId, requestOf(record, input, developerId));
    await markIntakeStarted(table, orgId, project, itemId, { taskId: started.task.taskId, sessionId: started.sessionId });
    ports.log("intake.started", { orgId, project, system: record.system, channel: record.channel });
    return { outcome: "started", taskId: started.task.taskId, ...(started.sessionId === undefined ? {} : { sessionId: started.sessionId }) };
  } catch (error) {
    if (isPassing(error)) {
      // The start's own refusal (no budget, the project is archived, the process is unavailable): the ticket waits, with the code, for a member to try again. A refusal that is "this ticket
      // already has a session" is the ticket being started by someone else first.
      const raced = await ports.sessionOfTicket(orgId, bindingOf(record)).catch(() => undefined);
      if (raced !== undefined) {
        await markIntakeStarted(table, orgId, project, itemId, { sessionId: raced.sessionId });
        return { outcome: "duplicate", state: "started" };
      }
      await giveBackIntakeItem(table, orgId, project, itemId, "start_refused", errorCode(error));
      ports.log("intake.start_refused", { orgId, project, system: record.system, code: errorCode(error) });
      return { outcome: "waiting", reason: "start_refused" };
    }
    // A fault that may pass: the item is given back (or, if this call created it just to start it, forgotten), and the poll's next tick or the webhook's retry does it again.
    if (created) await releaseIntakeItem(table, orgId, project, itemId);
    else await giveBackIntakeItem(table, orgId, project, itemId, record.reason ?? "outsider");
    ports.log("intake.start_failed", { orgId, project, system: record.system, error: errorCode(error) });
    throw error;
  }
}

export interface IngestContext {
  /** How many items the project already has waiting (computed once for a batch; the engine keeps it up to date as it stores more). */
  waiting?: { count: number };
}

/**
 * One ticket that asks for work. Idempotent: the same ticket handed over again is `duplicate` (unless it waits and this time a member asked, which starts it). Never throws for a
 * refusal; throws a fault that may pass, after leaving the ticket as it can be tried again.
 */
export async function ingestIntake(ports: IntakePorts, candidate: IntakeCandidate, context: IngestContext = {}): Promise<IntakeOutcome> {
  const ref = IntakeExternalRefSchema.safeParse(candidate.externalRef);
  if (!ref.success || candidate.title.trim() === "") return { outcome: "skipped", reason: "invalid" };
  // The loop guard: what Rovara's own account did never starts what Rovara does.
  if (candidate.actor?.kind === "rovara") return { outcome: "skipped", reason: "caused_by_rovara" };
  const { orgId, project } = candidate;
  const itemId = intakeItemIdOf(ref.data.system, ref.data.id);
  const known = await readIntakeItem(ports.table, orgId, project, itemId);
  // A ticket that is started or being started is done with, whoever asks again.
  if (known !== undefined && known.state !== "waiting") return { outcome: "duplicate", state: known.state };
  const resolved = await resolveStanding(ports, candidate);
  const title = inertTitle(candidate.title, ref.data.id).slice(0, INTAKE_TITLE_MAX);
  const writer = inertWriter(candidate.reporter?.display);
  const input = ticketRunInput({ system: ref.data.system, id: ref.data.id, title, body: prepareTicketBody(candidate.body), writer });
  const requester = { display: inertTicketLine(candidate.actor?.display ?? candidate.reporter?.display ?? "someone", 80) || "someone", standing: resolved.standing, ...(resolved.developerId === undefined ? {} : { developerId: resolved.developerId }) };
  const base = { orgId, project, itemId, channel: candidate.channel, system: ref.data.system, id: ref.data.id, url: ref.data.url, title, writer, requester };
  const mayStartNow = resolved.reason === undefined && resolved.developerId !== undefined;

  if (known !== undefined) {
    // The ticket waits. A member's act now starts it; anything else leaves it as it was.
    if (!mayStartNow) return { outcome: "duplicate", state: "waiting" };
    if (!await claimIntakeStart(ports.table, orgId, project, itemId, resolved.developerId!)) return { outcome: "duplicate", state: "starting" };
    return startHeld(ports, { ...known, ...base, state: "starting" }, input, resolved.developerId!, false);
  }

  if (mayStartNow) {
    const claimed = await claimIntakeItem(ports.table, { ...base, state: "starting", startedBy: resolved.developerId! });
    if (claimed.result !== "created") return { outcome: "duplicate", state: claimed.result === "exists" ? claimed.record.state : "waiting" };
    return startHeld(ports, { ...base, state: "starting", since: new Date(ports.table.now()).toISOString(), updatedAt: new Date(ports.table.now()).toISOString() }, input, resolved.developerId!, true);
  }

  // Waits for a member. A project holds a bounded number of waiting tickets, so a flood of outsiders' tickets costs a bounded amount.
  const waiting = context.waiting ?? { count: (await listWaitingIntakeItems(ports.table, orgId, project)).length };
  if (waiting.count >= INTAKE_MAX_WAITING_PER_PROJECT) {
    ports.log("intake.waiting_full", { orgId, project });
    await ports.notifyWaitingFull?.(orgId, project).catch(() => undefined);
    return { outcome: "skipped", reason: "waiting_full" };
  }
  const claimed = await claimIntakeItem(ports.table, { ...base, state: "waiting", reason: resolved.reason!, body: prepareTicketBody(candidate.body, WAITING_BODY_MAX_BYTES) });
  if (claimed.result !== "created") return { outcome: "duplicate", state: claimed.result === "exists" ? claimed.record.state : "waiting" };
  waiting.count += 1;
  ports.log("intake.waiting", { orgId, project, system: ref.data.system, reason: resolved.reason });
  return { outcome: "waiting", reason: resolved.reason! };
}

/** Hands a batch of tickets to `ingestIntake`, counting the project's waiting items once. A fault that may pass stops the batch (the rest are handed over again by the next poll). */
export async function ingestIntakeBatch(ports: IntakePorts, candidates: readonly IntakeCandidate[]): Promise<IntakeOutcome[]> {
  const counts = new Map<string, { count: number }>();
  const outcomes: IntakeOutcome[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.orgId}\0${candidate.project}`;
    let waiting = counts.get(key);
    if (waiting === undefined) {
      waiting = { count: (await listWaitingIntakeItems(ports.table, candidate.orgId, candidate.project)).length };
      counts.set(key, waiting);
    }
    outcomes.push(await ingestIntake(ports, candidate, { waiting }));
  }
  return outcomes;
}

/**
 * A member says "Start" for a ticket that waits. `approver` is the member pressing it: they must hold a role on the project that starts tasks (checked here and again by the start
 * itself), and the work is theirs: they start it and they pay. The ticket's text is read again from what was stored when it was handed over (inert), never from the request.
 */
export async function startWaitingIntake(
  ports: IntakePorts,
  input: { orgId: OrgId; project: string; itemId: string; approver: string },
): Promise<IntakeOutcome | { outcome: "not_found" } | { outcome: "forbidden" }> {
  const { orgId, project, itemId, approver } = input;
  if (!await ports.mayStart(orgId, approver, project)) return { outcome: "forbidden" };
  const record = await readIntakeItem(ports.table, orgId, project, itemId);
  if (record === undefined) return { outcome: "not_found" };
  if (record.state !== "waiting") return { outcome: "duplicate", state: record.state };
  if (!await claimIntakeStart(ports.table, orgId, project, itemId, approver)) {
    const now = await readIntakeItem(ports.table, orgId, project, itemId);
    return { outcome: "duplicate", state: now?.state ?? "starting" };
  }
  // The text is what was handed over and stored (already inert); the request carries none.
  const ticket = ticketRunInput({ system: record.system, id: record.id, title: record.title, body: record.body ?? "", writer: record.writer ?? "someone" });
  return startHeld(ports, { ...record, state: "starting" }, ticket, approver, false);
}
