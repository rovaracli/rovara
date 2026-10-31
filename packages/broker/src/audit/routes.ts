// The audit log's routes for an org's owners and admins (Task 12). The org is always the caller's own, from their session: no
// parameter, body field or id in a path can name another one, and every read below takes the org as an argument.
//
//   GET  /v1/app/org/audit/records            a page of the org's records, details opened
//   GET  /v1/app/org/audit/status             how far the log is sealed, the latest independent time, the limits copy
//   POST /v1/app/org/audit/exports            start an export (asynchronous: the export function builds it)
//   GET  /v1/app/org/audit/exports/{id}       the export's status and, once it is ready, a download link
//
// The same routes answer under `/v1/dev/org/audit/*`, the prefix the CLI and the MCP server use today.
//
// Reads are recorded after they are served (`recordAuditRead`, best effort): the one documented exception to recording in the
// action's own transaction, since a read has no write to join. The staff path (admin-routes.ts) records before it reads.
import {
  AUDIT_LIMITS_COPY,
  AUDIT_ERROR_MESSAGES,
  agentXError,
  type AuditActor,
  type OrgId,
  type OrgRole,
} from "@agentx/contracts";
import { canReadAuditLog } from "../org/auditor.js";
import { indexedQueryOf, readIndexedAudit } from "./indexed-reader.js";
import { z } from "zod";
import { assertExportRange, exportDownloadUrl, getAuditExport, startAuditExport, type AuditExportClientDeps, type AuditExportRequest, type AuditExportView } from "./export.js";
import { auditRead } from "./events.js";
import { recordAuditRead } from "./flush.js";
import { AUDIT_READ_PAGE_DEFAULT, AUDIT_READ_PAGE_MAX, readAuditRecords, readAuditStatus, type AuditReadQuery, type AuditReadResult } from "./reader.js";

/** A route's answer: the broker writes the status and the JSON body. */
export interface AuditRouteReply {
  status: number;
  body: object;
}

/** What a route needs of a request. `body` is the parsed JSON body (`{}` when there is none). */
export interface AuditRouteRequest {
  method: string;
  body: unknown;
  /** The API Gateway request id: what makes one read's audit record different from the next. */
  requestId: string;
}

/** The caller, from their session (never from the request). */
export interface AuditOrgCaller {
  developerId: string;
  orgId: OrgId;
  orgRole: OrgRole;
}

export const AUDIT_ORG_FORBIDDEN = "Only your organization's owners and admins can see its audit log.";
const NOT_SET_UP = "the audit log is not set up in this deployment";
const EXPORT_NOT_FOUND = "That export was not found.";

const ORG_AUDIT_PATH = /^\/v1\/(?:app|dev)\/org\/audit(\/.*)?$/;
/** Whether the router should hand this path to `routeAuditRequest`. */
export const isAuditOrgPath = (pathname: string): boolean => ORG_AUDIT_PATH.test(pathname);

export const notFound = (): Error => agentXError("NOT_FOUND", "route not found");
const rangeInvalid = (): Error => agentXError("AUDIT_RANGE_INVALID", AUDIT_ERROR_MESSAGES.AUDIT_RANGE_INVALID);
export const configInvalid = (message: string): Error => agentXError("CONFIG_INVALID", message);

// ---- the request's parts ----------------------------------------------------------------------------------------------

// Fixed text: a message never repeats a parameter or field name the client chose.
const UNKNOWN_PARAMETER = "This request has a parameter that this route does not take.";
const REPEATED_PARAMETER = "A parameter was given more than once.";
export const UNKNOWN_FIELD = "This request has a field that this route does not take.";

const QUERY_PARAMETERS = ["fromSeq", "toSeq", "from", "to", "action", "actorId", "cursor", "limit"] as const;

/** One whole number of at most 15 digits (a sequence number or a page size); anything else is a range the route cannot serve. */
function wholeNumber(text: string): number {
  if (!/^\d{1,15}$/.test(text)) throw rangeInvalid();
  return Number(text);
}

/**
 * The records query from the URL: only the parameters of the route and `extra` (which the caller reads itself), each at most
 * once. Whole numbers are checked here; what a range means is the reader's to judge.
 */
export function readQueryOf(params: URLSearchParams, extra: readonly string[] = []): AuditReadQuery {
  const known = new Set<string>([...QUERY_PARAMETERS, ...extra]);
  for (const name of new Set(params.keys())) {
    if (!known.has(name)) throw configInvalid(UNKNOWN_PARAMETER);
    if (params.getAll(name).length > 1) throw configInvalid(REPEATED_PARAMETER);
  }
  const text = (name: (typeof QUERY_PARAMETERS)[number]): string | undefined => params.get(name) ?? undefined;
  const number = (name: "fromSeq" | "toSeq" | "limit"): number | undefined => {
    const value = text(name);
    return value === undefined ? undefined : wholeNumber(value);
  };
  const fromSeq = number("fromSeq");
  const toSeq = number("toSeq");
  const limit = number("limit");
  const from = text("from");
  const to = text("to");
  const action = text("action");
  const actorId = text("actorId");
  const cursor = text("cursor");
  return {
    ...(fromSeq === undefined ? {} : { fromSeq }),
    ...(toSeq === undefined ? {} : { toSeq }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(action === undefined ? {} : { action }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const ExportBodySchema = z.object({
  requestId: z.string().min(1).max(200),
  fromSeq: z.number(),
  toSeq: z.number(),
  withDetails: z.boolean().optional(),
}).strict();

/**
 * The body of an export request. A range that is not whole numbers or not a range of at most 200,000 records is
 * AUDIT_RANGE_INVALID (checked here, so that nothing is recorded or started for it); any other fault is CONFIG_INVALID, naming
 * the field and never repeating what the client sent.
 */
export function exportRequestOf(body: unknown): AuditExportRequest {
  const parsed = ExportBodySchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0];
    if (field === "fromSeq" || field === "toSeq") throw rangeInvalid();
    // The path names a field of this route's own schema; an unrecognized key is the client's word and is never repeated.
    if (issue?.code === "unrecognized_keys") throw configInvalid(UNKNOWN_FIELD);
    throw configInvalid(`${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const { requestId, fromSeq, toSeq, withDetails } = parsed.data;
  assertExportRange(fromSeq, toSeq);
  return { requestId, fromSeq, toSeq, ...(withDetails === undefined ? {} : { withDetails }) };
}

/** `exportRequestOf` for a body that may also carry fields the caller reads itself (the staff path's `reason` and `ticket`). */
export function exportRequestWithout(body: Record<string, unknown>, fields: readonly string[]): AuditExportRequest {
  return exportRequestOf(Object.fromEntries(Object.entries(body).filter(([name]) => !fields.includes(name))));
}

// ---- shared answers ---------------------------------------------------------------------------------------------------

/** What the answer of an export read holds: the export's view, and for a ready one the link (`exportDownloadUrl` signs the file the record names). */
export async function exportAnswer(ledger: AuditExportClientDeps, orgId: OrgId, exportId: string): Promise<{ view: AuditExportView; body: object; download: boolean; link?: AuditExportLink }> {
  const view = await getAuditExport(ledger, orgId, exportId);
  if (view === undefined) throw agentXError("NOT_FOUND", EXPORT_NOT_FOUND);
  if (view.status !== "ready") return { view, body: { ...view }, download: false };
  // A signing failure (RUNTIME_UNAVAILABLE) is the caller's 503, as it comes.
  const link = await exportDownloadUrl(ledger, orgId, exportId);
  return { view, body: { ...view, download: link }, download: true, link };
}

/** A signed download link and how long it works. */
export interface AuditExportLink {
  url: string;
  expiresInSeconds: number;
}

/** What a started export answers: 202 while it runs, 200 for an export that already finished (a repeat of its request) or could not start. */
export const startedReply = (started: { exportId: string; status: string }): AuditRouteReply => ({ status: started.status === "running" ? 202 : 200, body: started });

/** The first and last sequence number of a page, and how many records it held: all zero for an empty page. */
export function pageFacts(result: AuditReadResult): { fromSeq: number; toSeq: number; count: number } {
  const first = result.records[0]?.record.seq;
  const last = result.records.at(-1)?.record.seq;
  return first === undefined || last === undefined ? { fromSeq: 0, toSeq: 0, count: 0 } : { fromSeq: first, toSeq: last, count: result.records.length };
}

/** The most records a page request can return: the page size asked for, at the most the reader serves. */
export const pageSizeOf = (query: AuditReadQuery): number => Math.min(query.limit ?? AUDIT_READ_PAGE_DEFAULT, AUDIT_READ_PAGE_MAX);

// ---- the routes -------------------------------------------------------------------------------------------------------

export async function routeAuditRequest(ledger: AuditExportClientDeps | undefined, caller: AuditOrgCaller, request: AuditRouteRequest, url: URL): Promise<AuditRouteReply> {
  const matched = ORG_AUDIT_PATH.exec(url.pathname);
  if (matched === null) throw notFound();
  const rest = matched[1] ?? "";
  // Owners, admins and the Auditor only; the check comes before anything else is said about the route.
  if (!canReadAuditLog(caller.orgRole)) throw agentXError("FORBIDDEN", AUDIT_ORG_FORBIDDEN);
  if (ledger === undefined) throw agentXError("NOT_FOUND", NOT_SET_UP);
  const orgId = caller.orgId;
  const actor: AuditActor = { kind: "member", id: caller.developerId };
  const reading = (facts: { fromSeq: number; toSeq: number; count: number }, via: string) =>
    recordAuditRead(ledger, auditRead({ orgId, actor, occurredAt: new Date(ledger.now()).toISOString(), occurrence: request.requestId, ...facts, via }));

  if (request.method === "GET" && rest === "/records") {
    if (url.searchParams.has("filterVersion")) {
      const result = await readIndexedAudit(ledger, caller, indexedQueryOf(url.searchParams));
      const first = result.records[0]?.record.seq, last = result.records.at(-1)?.record.seq;
      await reading({ fromSeq: first ?? 0, toSeq: last ?? 0, count: result.records.length }, "api");
      return { status: 200, body: result };
    }
    const result = await readAuditRecords(ledger, orgId, readQueryOf(url.searchParams));
    await reading(pageFacts(result), "api");
    return { status: 200, body: result };
  }
  if (request.method === "GET" && rest === "/status") {
    noParameters(url.searchParams);
    const status = await readAuditStatus(ledger, orgId);
    await reading({ fromSeq: 0, toSeq: 0, count: 0 }, "status");
    return { status: 200, body: { ...status, limits: AUDIT_LIMITS_COPY } };
  }
  if (request.method === "POST" && rest === "/exports") {
    noParameters(url.searchParams);
    if (!isRecord(request.body)) throw configInvalid("body: expected an object");
    return startedReply(await startAuditExport(ledger, { orgId, actor }, exportRequestOf(request.body)));
  }
  const exportId = /^\/exports\/([^/]+)$/.exec(rest)?.[1];
  if (request.method === "GET" && exportId !== undefined) {
    noParameters(url.searchParams);
    const answer = await exportAnswer(ledger, orgId, exportId);
    // A link is the way to the whole log, so handing one out is a read; a status that holds none is not.
    if (answer.download) await reading({ fromSeq: answer.view.range.fromSeq, toSeq: answer.view.range.toSeq, count: answer.view.summary?.records ?? 0 }, "export-download");
    return { status: 200, body: answer.body };
  }
  throw notFound();
}

/** A route with no query parameters of its own, besides `allowed`, refuses any other. */
export function noParameters(params: URLSearchParams, allowed: readonly string[] = []): void {
  for (const name of params.keys()) if (!allowed.includes(name)) throw configInvalid(UNKNOWN_PARAMETER);
}
