// Live interaction F2: "Fix with agent", the light diagnosis, the broker's side. A person who can use an error's task (or who maintains the project) asks for a diagnosis of an error the app showed. The
// broker checks the person and that the error is the one the app showed, spends the rates, keeps the context text on the waiting request (never in the queue), queues one message of ids for the
// existing chat service (its no-tools answer turn) and, when the service answers, reads the answer again (`sanitizeDiagnosis`), stores the proposals and audits.
//
// A diagnosis can never act. What it writes is its own records: the request, the result, the person link, the rate counters and the audit. Its proposals are text for a person; a settings change
// reaches settings only through "Apply this change" (propose.ts), by the ordinary route and as that person.
// The switch (`fd`, LIVE_FIX_ENABLED) is OFF by default: every route then answers NOT_FOUND exactly as if it did not exist.
import { createHash } from "node:crypto";
import {
  DIAGNOSIS_REFUSALS, DIAGNOSIS_ROVARA_PAID_GLOBAL_DEFAULT_CENTS, DIAGNOSIS_ROVARA_PAID_ORG_LIMITS, DIAGNOSIS_UNAVAILABLE_MESSAGE, SETUP_DRAFT_STALE_MINUTES, DiagnosisAnsweredRequestSchema, DiagnosisIdSchema, DiagnosisQueueMessageSchema, DiagnosisRefSchema, DiagnosisStartBodySchema, DiagnosisStatusSchema,
  DiagnosisRecordSchema, agentXError, diagnosisRouteAttributes, errorRefKey,
  type DiagnosisRecord, type DiagnosisStatus, type DiagnosisTier, type DiagnosisTurnResult, type OrgId,
} from "@agentx/contracts";
import type { SlackRequestQueue } from "../developer/page-comments.js";
import { auditDiagnosisProposed, auditDiagnosisStarted } from "../audit/events.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import { auditDiagnosis, type DiagnosisAuditDependencies } from "./audit.js";
import { diagnosisSubjectFor, type DiagnosisAuthorityDependencies } from "./authority.js";
import { currentFacts, nonceFor, renderDiagnosisContext, type DiagnosisContextPorts } from "./context.js";
import { proposalCounts, sanitizeDiagnosis } from "./sanitize.js";

/** The words a failed deep run leaves (fixed; the light result stays). */
export const DEEP_DIAGNOSIS_FAILED_MESSAGE = "Couldn't read the code to diagnose this. The first diagnosis stays." as const;
import {
  REQUEST_STALE_MS, admitDiagnosis, claimProposedAudit, diagnosisEventId, diagnosisIdFor, freeOpenPlace, openDiagnosisFor, readDiagnosisRecord, readDiagnosisRequest, readDiagnosisRequester, settleDiagnosis,
  type DiagnosisOrgCap, type DiagnosisRequest,
} from "./store.js";

type Edition = "enterprise" | "public";

/** What every diagnosis route and every chat-service call needs: the table, the switch, who may see what, and the audit. */
export interface DiagnosisCoreDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  /** The `fd` switch. Off: every diagnosis route answers NOT_FOUND. */
  enabled: boolean;
  authority: DiagnosisAuthorityDependencies;
  audit: DiagnosisAuditDependencies;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/** What the person's own routes also need: the edition, the chat service's queue and the reads the context is built from. */
export interface DiagnosisDependencies extends DiagnosisCoreDependencies {
  edition: Edition;
  /** The chat service's request queue. Absent: the install cannot run a light diagnosis, and the route says so. */
  queue: SlackRequestQueue | undefined;
  context: DiagnosisContextPorts;
  /** DG-1 S1: the organization's daily ceiling on the light diagnoses Rovara pays for (Public). Absent: `DIAGNOSIS_ROVARA_PAID_ORG_LIMITS`. */
  rovaraPaidLimits?: DiagnosisOrgCap | undefined;
  /** DG-3: the install-wide daily ceiling, in cents, on the light diagnoses Rovara pays for across all organizations (the packed setting `fg`). Absent: `DIAGNOSIS_ROVARA_PAID_GLOBAL_DEFAULT_CENTS`. */
  rovaraPaidGlobalCents?: number | undefined;
}

export type DiagnosisCaller = { orgId: OrgId; developerId: string };

/** The error kinds a diagnosis is offered for: the ones whose current state the broker can read again. The rows for connectors, model access and intake do not report a failure yet. */
export const DIAGNOSABLE_KINDS: ReadonlySet<string> = new Set(["workflow_block", "operation_failed", "setup_check"]);

/** What the chat turn is told it is: a fixed role. The project's own chat instructions are admin-written configuration and are not part of a diagnosis. */
export const DIAGNOSIS_TURN_INSTRUCTIONS = "You diagnose one error for the people who run a software project. Answer only from the data you are given.";

const notFound = () => agentXError("NOT_FOUND", "route not found");
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", DIAGNOSIS_UNAVAILABLE_MESSAGE);

/** A uuid made from a diagnosis id: the chat runtime wants a workspace id for its turn, and a diagnosis has no workspace (its turn has no tools and reads none). */
export function diagnosisWorkspaceId(diagnosisId: string): string {
  const bytes = createHash("sha256").update(`diagnosis-workspace\0${diagnosisId}`, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ---- the status a person reads

export async function statusOf(deps: DiagnosisCoreDependencies, orgId: OrgId, request: DiagnosisRequest): Promise<DiagnosisStatus> {
  const base = { diagnosisId: request.diagnosisId, tier: request.tier, errorRef: request.errorRef } as const;
  const deep = request.tier === "light" ? await openDiagnosisFor(deps, orgId, "deep", request.errorRef).catch(() => undefined) : undefined;
  const withDeep = deep === undefined ? {} : { deepDiagnosisId: deep };
  // A request nobody answered in time reads as failed, never as waiting for ever; the open place is freed so the error can be asked about again.
  // (A deep diagnosis is a task that clones and reads repositories: it is given a setup draft's hour, and a task that ended without the broker hearing of it is the stuck-task sweep's.)
  const staleMs = request.tier === "deep" ? SETUP_DRAFT_STALE_MINUTES * 60_000 : REQUEST_STALE_MS;
  if (request.state === "queued" && deps.now() - Date.parse(request.createdAt) > staleMs) {
    await settleDiagnosis(deps, orgId, request, { state: "failed" }).catch(() => undefined);
    return DiagnosisStatusSchema.parse({ ...base, state: "failed", failure: DIAGNOSIS_UNAVAILABLE_MESSAGE, ...withDeep });
  }
  if (request.state === "ready") {
    const record = await readDiagnosisRecord(deps, orgId, request.diagnosisId);
    if (record !== undefined) {
      // A deep diagnosis ends in its task's result transaction, which cannot audit: the first read of its result does, once.
      if (request.tier === "deep" && await claimProposedAudit(deps, orgId, request.diagnosisId)) {
        const requester = await readDiagnosisRequester(deps, orgId, request.diagnosisId).catch(() => undefined);
        await auditDiagnosis(deps.audit, () => auditDiagnosisProposed({
          orgId, actor: auditActorOf(requester ?? "system"), occurredAt: new Date(deps.now()).toISOString(), occurrence: request.diagnosisId,
          diagnosisId: request.diagnosisId, counts: proposalCounts(record.proposals), dropped: record.droppedProposals,
        }));
      }
      return DiagnosisStatusSchema.parse({ ...base, state: "ready", proposals: record.proposals, droppedProposals: record.droppedProposals, needsCode: record.needsCode, ...withDeep });
    }
    return DiagnosisStatusSchema.parse({ ...base, state: "failed", failure: DIAGNOSIS_UNAVAILABLE_MESSAGE, ...withDeep });
  }
  if (request.state === "failed") {
    // A deep diagnosis whose task ended without an answer lets go of its error's place the first time that is seen, so the error can be asked about again.
    if (request.tier === "deep") await freeOpenPlace(deps, orgId, request).catch(() => undefined);
    return DiagnosisStatusSchema.parse({ ...base, state: "failed", failure: request.tier === "deep" ? DEEP_DIAGNOSIS_FAILED_MESSAGE : DIAGNOSIS_UNAVAILABLE_MESSAGE, ...withDeep });
  }
  return DiagnosisStatusSchema.parse({ ...base, state: "queued", ...withDeep });
}

/** Where a diagnosis is, for a person who may diagnose its error now (anyone else: NOT_FOUND, so a diagnosis's existence never leaks). */
export async function diagnosisStatusFor(deps: DiagnosisCoreDependencies, caller: DiagnosisCaller, diagnosisId: string): Promise<DiagnosisStatus> {
  if (!deps.enabled) throw notFound();
  if (!DiagnosisIdSchema.safeParse(diagnosisId).success) throw notFound();
  const request = await readDiagnosisRequest(deps, caller.orgId, diagnosisId);
  if (request === undefined) throw notFound();
  if (await diagnosisSubjectFor(deps.authority, caller, request.errorRef) === undefined) throw notFound();
  return statusOf(deps, caller.orgId, request);
}

// ---- starting

/**
 * `POST /v1/app/diagnoses`: a person asks for a light diagnosis of the error the app showed. Checks, in this order: the switch; the body; that the kind is one the broker can read again; the
 * person's right now; that the error is still the one shown; the open diagnosis of the same error (answered, nothing spent); the rates; then queues. A repeat of the same request is the same
 * diagnosis.
 */
export async function startLightDiagnosis(deps: DiagnosisDependencies, caller: DiagnosisCaller, value: unknown): Promise<DiagnosisStatus> {
  if (!deps.enabled) throw notFound();
  const body = DiagnosisStartBodySchema.safeParse(value);
  if (!body.success) throw agentXError("CONFIG_INVALID", "a diagnosis needs a request ID and the error reference the app showed");
  const { errorRef } = body.data;
  if (!DIAGNOSABLE_KINDS.has(errorRef.kind)) throw agentXError("NOT_FOUND", DIAGNOSIS_REFUSALS.notAvailable);
  if (deps.queue === undefined) throw unavailable();
  const subject = await diagnosisSubjectFor(deps.authority, caller, errorRef);
  if (subject === undefined) throw agentXError("FORBIDDEN", DIAGNOSIS_REFUSALS.notAllowed);
  const tier: DiagnosisTier = "light";

  // The same request again, or the same error while its diagnosis is open: the existing diagnosis, with nothing spent and nothing built.
  const own = await readDiagnosisRequest(deps, caller.orgId, diagnosisIdFor(caller.orgId, caller.developerId, body.data.requestId, tier));
  if (own !== undefined) return statusOf(deps, caller.orgId, own);
  const open = await openDiagnosisFor(deps, caller.orgId, tier, errorRef);
  if (open !== undefined) {
    const existing = await readDiagnosisRequest(deps, caller.orgId, open);
    if (existing !== undefined) return statusOf(deps, caller.orgId, existing);
  }

  const facts = await currentFacts(deps.context, caller, errorRef, subject);
  if (facts === undefined) throw agentXError("CONFIG_INVALID", DIAGNOSIS_REFUSALS.notCurrent);
  const diagnosisId = diagnosisIdFor(caller.orgId, caller.developerId, body.data.requestId, tier);
  const rendered = renderDiagnosisContext(facts, nonceFor(deps.context.tagKey, diagnosisId));
  const admitted = await admitDiagnosis(deps, {
    orgId: caller.orgId, developerId: caller.developerId, requestId: body.data.requestId, tier, errorRef: facts.errorRef, project: subject.project, context: rendered.text,
    ...(deps.edition === "public" /* the edition where Rovara pays for the turn (`rovaraPaysForLight`) */ ? { rovaraPaid: deps.rovaraPaidLimits ?? DIAGNOSIS_ROVARA_PAID_ORG_LIMITS, rovaraPaidGlobalCentsPerDay: deps.rovaraPaidGlobalCents ?? DIAGNOSIS_ROVARA_PAID_GLOBAL_DEFAULT_CENTS } : {}),
  });
  const request = await readDiagnosisRequest(deps, caller.orgId, admitted.diagnosisId);
  if (request === undefined) throw unavailable();
  if (!admitted.created) return statusOf(deps, caller.orgId, request);

  try {
    const message = DiagnosisQueueMessageSchema.parse({ version: 1, eventId: diagnosisEventId(admitted.diagnosisId), diagnosis: { orgId: caller.orgId, diagnosisId: admitted.diagnosisId }, receivedAt: new Date(deps.now()).toISOString() });
    await deps.queue.send({ body: JSON.stringify(message), groupId: createHash("sha256").update(`diagnosis\0${errorRefKey(facts.errorRef)}`, "utf8").digest("hex"), deduplicationId: message.eventId, attributes: diagnosisRouteAttributes() });
  } catch (error) {
    // The queue refused it: the diagnosis is over (failed), the error's open place is let go, and the person is told in fixed words. Nothing is retried in the background.
    deps.log?.({ event: "diagnosis.queue_failed", orgId: caller.orgId, error: error instanceof Error ? error.name : "unknown" });
    await settleDiagnosis(deps, caller.orgId, request, { state: "failed" }).catch(() => undefined);
    throw unavailable();
  }
  await auditDiagnosis(deps.audit, () => auditDiagnosisStarted({
    orgId: caller.orgId, actor: auditActorOf(caller.developerId), occurredAt: new Date(deps.now()).toISOString(), occurrence: admitted.diagnosisId,
    diagnosisId: admitted.diagnosisId, errorKind: facts.errorRef.kind, errorCode: facts.errorRef.code, tier,
  }));
  return statusOf(deps, caller.orgId, request);
}

// ---- the chat service's routes (the service role only; see service.ts)

interface Waiting { request: DiagnosisRequest; requester: string }

/** The waiting light diagnosis the service names, or undefined: not made by the broker, not light, not waiting, another org's, or its person was erased. */
async function waitingDiagnosis(deps: DiagnosisCoreDependencies, ref: { orgId: OrgId; diagnosisId: string }): Promise<Waiting | undefined> {
  const request = await readDiagnosisRequest(deps, ref.orgId, ref.diagnosisId);
  if (request === undefined || request.state !== "queued" || request.tier !== "light") return undefined;
  const requester = await readDiagnosisRequester(deps, ref.orgId, ref.diagnosisId);
  return requester === undefined ? undefined : { request, requester };
}

/** Whether the requester may still be answered now: their right to the error is read again, so a person whose "can use" ended since asking gets nothing. */
export async function requesterMayStillBeAnswered(deps: DiagnosisCoreDependencies, orgId: OrgId, waiting: Waiting): Promise<boolean> {
  return await diagnosisSubjectFor(deps.authority, { orgId, developerId: waiting.requester }, waiting.request.errorRef) !== undefined;
}

/** The waiting diagnosis for the service's model-access call: its project, its requester and the right to answer (undefined: refuse). */
export async function waitingForKey(deps: DiagnosisCoreDependencies, value: unknown): Promise<{ orgId: OrgId; diagnosisId: string; project: string; requester: string } | undefined> {
  if (!deps.enabled) throw notFound();
  const ref = DiagnosisRefSchema.safeParse(value);
  if (!ref.success) return undefined;
  const waiting = await waitingDiagnosis(deps, ref.data);
  if (waiting === undefined || !(await requesterMayStillBeAnswered(deps, ref.data.orgId, waiting))) return undefined;
  return { orgId: ref.data.orgId, diagnosisId: ref.data.diagnosisId, project: waiting.request.project, requester: waiting.requester };
}

/** The context of one waiting diagnosis, after its requester's right to the error was read again. Throws a fixed error and the service then reports the diagnosis failed. */
export async function prepareDiagnosisTurn(deps: DiagnosisCoreDependencies, value: unknown): Promise<DiagnosisTurnResult> {
  if (!deps.enabled) throw notFound();
  const ref = DiagnosisRefSchema.safeParse(value);
  if (!ref.success) throw agentXError("CONFIG_INVALID", "a diagnosis is named by its org and diagnosis ID");
  const waiting = await waitingDiagnosis(deps, ref.data);
  if (waiting === undefined || waiting.request.context === undefined) throw notFound();
  if (!(await requesterMayStillBeAnswered(deps, ref.data.orgId, waiting))) throw agentXError("FORBIDDEN", "this diagnosis can't be answered now");
  return { workspaceId: diagnosisWorkspaceId(ref.data.diagnosisId), orchestratorInstructions: DIAGNOSIS_TURN_INSTRUCTIONS, taskContext: waiting.request.context };
}

/**
 * The service's answer (or that there is none). Only a waiting light diagnosis takes one, once: the request moves from queued to ready or failed in one conditional step, and only the call that
 * made the move audits it, so a redelivery writes nothing twice. The answer is read again here: it is the closed set of proposals, or one inert explanation, and nothing else.
 */
export async function completeDiagnosis(deps: DiagnosisCoreDependencies, value: unknown): Promise<{ outcome: "ANSWERED" | "FAILED" }> {
  if (!deps.enabled) throw notFound();
  const parsed = DiagnosisAnsweredRequestSchema.safeParse(value);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "an answer needs the diagnosis, an outcome and, for an answer, its text");
  const answer = parsed.data;
  const waiting = await waitingDiagnosis(deps, answer);
  if (waiting === undefined) {
    // A repeat of an outcome already recorded answers the same.
    const request = await readDiagnosisRequest(deps, answer.orgId, answer.diagnosisId);
    if (request !== undefined && (request.state === "ready" || request.state === "failed")) return { outcome: request.state === "ready" ? "ANSWERED" : "FAILED" };
    throw notFound();
  }
  const { request } = waiting;
  if (answer.outcome === "FAILED" || answer.text === undefined || answer.text.trim() === "") {
    await settleDiagnosis(deps, answer.orgId, request, { state: "failed" });
    return { outcome: "FAILED" };
  }
  const sanitized = sanitizeDiagnosis(answer.text);
  if (sanitized.proposals.length === 0) {
    await settleDiagnosis(deps, answer.orgId, request, { state: "failed" });
    return { outcome: "FAILED" };
  }
  const nowMs = deps.now();
  const record: DiagnosisRecord = DiagnosisRecordSchema.parse({
    diagnosisId: request.diagnosisId, errorRef: request.errorRef, tier: "light", proposals: sanitized.proposals, droppedProposals: sanitized.dropped, needsCode: sanitized.needsCode,
    model: answer.model ?? "chat-runtime", costCents: 0, createdAt: new Date(nowMs).toISOString(), ttl: Math.floor(nowMs / 1000) + 30 * 86_400,
  });
  const settled = await settleDiagnosis(deps, answer.orgId, request, { state: "ready", record });
  if (settled) {
    await auditDiagnosis(deps.audit, () => auditDiagnosisProposed({
      orgId: answer.orgId, actor: auditActorOf(waiting.requester), occurredAt: new Date(nowMs).toISOString(), occurrence: request.diagnosisId,
      diagnosisId: request.diagnosisId, counts: proposalCounts(sanitized.proposals), dropped: sanitized.dropped,
    }));
  }
  return { outcome: "ANSWERED" };
}
