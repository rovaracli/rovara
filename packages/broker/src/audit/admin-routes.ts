// The staff path to an org's audit log (Task 12, I7): Rovara staff (the admin pool) read one org's log or export it, and the
// route is fail-closed. Every request needs a `reason` (1 to 300 characters; a `ticket` of 1 to 64 is optional), and the
// `audit.staff_read` record is made durable BEFORE anything is read: if it cannot be put the answer is 503 AUDIT_UNAVAILABLE and
// the ledger, the exports and the download link stay untouched. The record goes into the org being read, with the staff member
// as an `op_` actor and the reason and ticket in `details` (shredded with the org); only the staff member's own id is in the chain.
//
//   GET  /v1/admin/audit/{orgId}/records?...&reason=...&ticket=...
//   POST /v1/admin/audit/{orgId}/exports                  { requestId, fromSeq, toSeq, withDetails?, reason, ticket? }
//   GET  /v1/admin/audit/{orgId}/exports/{exportId}?reason=...&ticket=...   (the status and the link: itself a staff read)
//
//   POST /v1/admin/audit/{orgId}/erase-subject            { requestId, developerId, reason }   (Task 15: erase one person's details)
//
// The org comes from the path and nowhere else, and must be an org that exists: a mistyped id would otherwise start a chain
// for an org that is not there, in a ledger that cannot be corrected. Nothing below builds an object key.
import { AUDIT_ERROR_MESSAGES, auditOperatorId } from "@agentx/cloud-contracts";
import { OrgIdSchema, agentXError, type OrgId } from "@rovara-code/contracts";
import { type AuditActor } from "@agentx/cloud-contracts";
import { auditErasedMessage, eraseAuditSubject, isAuditSubjectId, type AuditEraseDeps } from "./erase.js";
import { auditExportId, isAuditExportId, refuseShreddedExport, startAuditExport, type AuditExportClientDeps } from "./export.js";
import { auditStaffRead } from "./events.js";
import { recordAuditEventDurably } from "./flush.js";
import { checkReadQuery, readAuditRecords } from "./reader.js";
import { UNKNOWN_FIELD, configInvalid, exportAnswer, exportRequestWithout, isRecord, noParameters, notFound, pageSizeOf, readQueryOf, startedReply, type AuditRouteReply, type AuditRouteRequest } from "./routes.js";

export interface AuditAdminDependencies {
  /** Absent on an install with no ledger (a legacy install). */
  ledger: AuditExportClientDeps | undefined;
  /** Whether the org exists (its record is in the State table). Asked before anything is recorded. */
  orgExists: (orgId: OrgId) => Promise<boolean>;
  /** Task 15: what the erase route needs; the route does not exist without it. */
  erase?: AuditEraseDeps;
  /** The person's name for the erase route's answer (their developer record), if there is one. Asked before the details are erased. */
  personName?: (developerId: string) => Promise<string | undefined>;
}

/** The staff member, from the admin pool's claims. */
export interface AuditAdminCaller {
  issuer: string;
  subject: string;
  isAdministrator: boolean;
}

const REASON_MAX = 300;
const TICKET_MAX = 64;
const STAFF_PARAMETERS = ["reason", "ticket"] as const;
const STAFF_PATH = /^\/v1\/admin\/audit\/([^/]+)\/(records|exports|erase-subject)(?:\/([^/]+))?$/;

interface Justification {
  reason: string;
  ticket?: string;
}

/** Control (Cc) and format (Cf) characters: C0 and C1 controls, ANSI escapes, zero-width and bidi characters. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;
/** A ticket is a reference such as `SUP-42`: printable ASCII, no spaces. */
const TICKET_SHAPE = /^[\x21-\x7e]+$/;

/**
 * The reason is required (AUDIT_REASON_REQUIRED) and is shown later, in a terminal or a page, to the org's admins from an append-only
 * record that cannot be corrected: so it may hold no control, format or bidi character (CONFIG_INVALID, checked before trimming).
 * The ticket may be left out, but if it is given it is 1 to 64 printable ASCII characters.
 */
function justification(reason: unknown, ticket: unknown): Justification {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 1 || why.length > REASON_MAX) throw agentXError("AUDIT_REASON_REQUIRED", AUDIT_ERROR_MESSAGES.AUDIT_REASON_REQUIRED);
  if (UNSAFE_TEXT.test(reason as string)) throw configInvalid("The reason holds a character that is not allowed: use plain text.");
  if (ticket === undefined) return { reason: why };
  if (typeof ticket !== "string" || ticket.length < 1 || ticket.length > TICKET_MAX || !TICKET_SHAPE.test(ticket)) {
    throw configInvalid(`The ticket is 1 to ${String(TICKET_MAX)} printable ASCII characters without spaces, or leave it out.`);
  }
  return { reason: why, ticket };
}

const ERASE_FIELDS = ["requestId", "developerId", "reason"] as const;
const REQUEST_ID_MAX = 200;
const NAME_MAX = 100;

/** A name for the answer: plain text only (no control, format or bidi character), cut to a sensible length; undefined if nothing is left. */
function plainName(name: string | undefined): string | undefined {
  const cleaned = (name ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, NAME_MAX).trim();
  return cleaned === "" ? undefined : cleaned;
}

/** The reason and ticket of a GET: each at most once. More than one `reason` is no reason; more than one `ticket` is refused. */
function justificationOfQuery(params: URLSearchParams): Justification {
  const reasons = params.getAll("reason");
  const tickets = params.getAll("ticket");
  if (tickets.length > 1) throw configInvalid("A parameter was given more than once.");
  return justification(reasons.length === 1 ? reasons[0] : reasons.length === 0 ? undefined : reasons, tickets[0]);
}

export async function routeAuditAdminRequest(deps: AuditAdminDependencies, caller: AuditAdminCaller, request: AuditRouteRequest, url: URL): Promise<AuditRouteReply | undefined> {
  if (url.pathname !== "/v1/admin/audit" && !url.pathname.startsWith("/v1/admin/audit/")) return undefined;
  if (!caller.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const matched = STAFF_PATH.exec(url.pathname);
  if (matched === null) throw notFound();
  const [, orgText, kind, exportId] = matched;
  const parsedOrg = OrgIdSchema.safeParse(orgText);
  if (!parsedOrg.success) throw agentXError("NOT_FOUND", "That organization was not found.");
  const orgId = parsedOrg.data;
  if (deps.ledger === undefined) throw agentXError("NOT_FOUND", "the audit log is not set up in this deployment");
  const ledger = deps.ledger;
  const actor: Extract<AuditActor, { kind: "operator" }> = { kind: "operator", id: auditOperatorId(caller.issuer, caller.subject) };

  /** The record, made durable before the first read (or the 503 that stops the request); then the read goes on. */
  const recordFirst = async (why: Justification, facts: { fromSeq: number; toSeq: number; count: number }, via: string, exportRef?: string): Promise<void> => {
    // `recordAuditEventDurably` does nothing without an outbox; a staff read must not go unrecorded.
    if (ledger.audit === undefined) throw agentXError("AUDIT_UNAVAILABLE", AUDIT_ERROR_MESSAGES.AUDIT_UNAVAILABLE);
    await recordAuditEventDurably(ledger, auditStaffRead({
      orgId,
      actor,
      occurredAt: new Date(ledger.now()).toISOString(),
      occurrence: request.requestId,
      ...facts,
      via,
      details: [{ subject: "org", fields: { reason: why.reason, ...(why.ticket === undefined ? {} : { ticket: why.ticket }), ...(exportRef === undefined ? {} : { exportId: exportRef }) } }],
    }));
  };
  const requireOrg = async (): Promise<void> => {
    if (!(await deps.orgExists(orgId))) throw agentXError("NOT_FOUND", "That organization was not found.");
  };

  if (request.method === "POST" && kind === "erase-subject" && exportId === undefined) {
    const erase = deps.erase;
    if (erase === undefined) throw agentXError("NOT_FOUND", "the audit log is not set up in this deployment");
    const body = isRecord(request.body) ? request.body : {};
    const why = justification(body.reason, undefined);
    noParameters(url.searchParams);
    if (Object.keys(body).some((name) => !(ERASE_FIELDS as readonly string[]).includes(name))) throw configInvalid(UNKNOWN_FIELD);
    const { requestId, developerId } = body;
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > REQUEST_ID_MAX) throw configInvalid(`Give each erasure request an id of 1 to ${String(REQUEST_ID_MAX)} characters.`);
    if (!isAuditSubjectId(developerId)) throw configInvalid("Name the person by their developer id.");
    await requireOrg();
    // The name is read now: after this the person's details cannot be read any more.
    const name = plainName(await deps.personName?.(developerId));
    const erased = await eraseAuditSubject(erase, { orgId, developerId, by: actor, reason: why.reason, requestId });
    return { status: 200, body: { message: auditErasedMessage(name ?? "That person"), erasedAt: erased.erasedAt, alreadyErased: erased.alreadyErased } };
  }
  if (request.method === "GET" && kind === "records" && exportId === undefined) {
    const why = justificationOfQuery(url.searchParams);
    const query = readQueryOf(url.searchParams, STAFF_PARAMETERS);
    // Every check the reader would make, before the record: a typo must not leave a staff read of a read that never happened.
    checkReadQuery(query);
    await requireOrg();
    // The record is made before the read, so what the read returns is not known yet: `count` is the page size the request allows.
    await recordFirst(why, { fromSeq: query.fromSeq ?? 0, toSeq: query.toSeq ?? 0, count: pageSizeOf(query) }, "api");
    return { status: 200, body: await readAuditRecords(ledger, orgId, query) };
  }
  if (request.method === "POST" && kind === "exports" && exportId === undefined) {
    const body = isRecord(request.body) ? request.body : {};
    const why = justification(body.reason, body.ticket);
    noParameters(url.searchParams);
    const exportRequest = exportRequestWithout(body, STAFF_PARAMETERS);
    await requireOrg();
    // A shredded org gets no export: refused before anything is recorded (the read would never happen).
    await refuseShreddedExport(ledger, orgId, "start");
    await recordFirst(why, { fromSeq: exportRequest.fromSeq, toSeq: exportRequest.toSeq, count: exportRequest.toSeq - exportRequest.fromSeq + 1 }, "export", auditExportId(orgId, exportRequest.requestId));
    return startedReply(await startAuditExport(ledger, { orgId, actor }, exportRequest));
  }
  if (request.method === "GET" && kind === "exports" && exportId !== undefined) {
    const why = justificationOfQuery(url.searchParams);
    noParameters(url.searchParams, STAFF_PARAMETERS);
    // An id of any other shape names no export: nothing to read, so nothing to record.
    if (!isAuditExportId(exportId)) throw agentXError("NOT_FOUND", "That export was not found.");
    await requireOrg();
    await refuseShreddedExport(ledger, orgId, "download");
    await recordFirst(why, { fromSeq: 0, toSeq: 0, count: 0 }, "export-download", exportId);
    return { status: 200, body: (await exportAnswer(ledger, orgId, exportId)).body };
  }
  throw notFound();
}
