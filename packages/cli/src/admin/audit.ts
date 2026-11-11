// `agentx admin audit log | export` (Task 14): Rovara staff read one organization's audit log through the administrator sign-in, over
// `/v1/admin/audit/{orgId}/*`. The route is fail-closed: it records the read, with the reason and ticket given here, before it
// reads anything, and answers 503 AUDIT_UNAVAILABLE (nothing read) when it cannot. Nothing here reads another way.
//
// The reason and ticket are checked here with the control plane's own rules and words (broker/audit/admin-routes.ts), so a typo is
// refused before a call is made. Every staff poll of an export is itself a recorded read, so the poll is no more often than every
// 10 seconds, and it stops the moment the export is ready, failed or expired.
import { AUDIT_ERROR_MESSAGES } from "@agentx/cloud-contracts";
import { OrgIdSchema, agentXError, type OrgId } from "@rovara-code/contracts";
import {
  AuditExportStartSchema,
  AuditExportViewSchema,
  AuditRecordsSchema,
  auditLogQuery,
  neutralised,
  type AuditExportTransport,
  type AuditLogFlags,
  type AuditRecords,
} from "../developer/audit.js";
import { adminResponseBody } from "./http.js";

const REASON_MAX = 300;
const TICKET_MAX = 64;
/** Control (Cc) and format (Cf) characters: C0 and C1 controls, ANSI escapes, zero-width and bidi characters. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;
/** A ticket is a reference such as `SUP-42`: printable ASCII, no spaces. */
const TICKET_SHAPE = /^[\x21-\x7e]+$/;
/** The staff export poll: each one is a recorded read, so no more often than this. */
export const STAFF_POLL_MS = 10_000;
/** After this long the staff poll slows down, so one long export does not fill the customer's log with reads. */
const STAFF_BACKOFF = { afterMs: 2 * 60 * 1000, pollMs: 30_000 } as const;
const REQUEST_TIMEOUT_MS = 30_000;

export interface StaffJustification {
  reason: string;
  ticket?: string;
}

/**
 * The reason (1 to 300 characters after trimming; no control, format or bidi character anywhere in it) and the optional ticket
 * (1 to 64 printable ASCII characters, no spaces). The same rules and messages as the control plane's.
 */
export function staffJustification(reason: string | undefined, ticket: string | undefined): StaffJustification {
  const why = reason === undefined ? "" : reason.trim();
  if (why.length < 1 || why.length > REASON_MAX) throw agentXError("AUDIT_REASON_REQUIRED", AUDIT_ERROR_MESSAGES.AUDIT_REASON_REQUIRED);
  if (UNSAFE_TEXT.test(reason as string)) throw agentXError("CONFIG_INVALID", "The reason holds a character that is not allowed: use plain text.");
  if (ticket === undefined) return { reason: why };
  if (ticket.length < 1 || ticket.length > TICKET_MAX || !TICKET_SHAPE.test(ticket)) {
    throw agentXError("CONFIG_INVALID", `The ticket is 1 to ${String(TICKET_MAX)} printable ASCII characters without spaces, or leave it out.`);
  }
  return { reason: why, ticket };
}

/** The organization argument: an ID of the shape `org_` and 20 lowercase letters and digits, so nothing else reaches the path. */
export function staffOrgId(text: string): OrgId {
  const parsed = OrgIdSchema.safeParse(text);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "name the organization by its ID: org_ followed by 20 lowercase letters and digits");
  return parsed.data;
}

export interface StaffAuditContext {
  controlPlaneUrl: string;
  accessToken: string;
  fetch: typeof fetch;
}

function justificationParams(params: URLSearchParams, why: StaffJustification): URLSearchParams {
  params.set("reason", why.reason);
  if (why.ticket !== undefined) params.set("ticket", why.ticket);
  return params;
}

async function staffRequest<T>(
  context: StaffAuditContext,
  path: string,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  options: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  return neutralised(() => staffCall(context, path, schema, options));
}

async function staffCall<T>(
  context: StaffAuditContext,
  path: string,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  options: { method?: "GET" | "POST"; body?: unknown },
): Promise<T> {
  let response: Response;
  try {
    response = await context.fetch(`${context.controlPlaneUrl.replace(/\/$/, "")}${path}`, {
      method: options.method ?? "GET",
      headers: { authorization: `Bearer ${context.accessToken}`, ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", "could not reach the control plane; check your connection and try again");
  }
  const parsed = schema.safeParse(await adminResponseBody(response));
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "the control plane answered with something unexpected; upgrade the CLI and try again");
  return parsed.data;
}

/** The flags are checked before this is called (`auditLogQuery`, `staffJustification`); the control plane records the read, then answers. */
export async function fetchStaffRecords(context: StaffAuditContext, orgId: OrgId, why: StaffJustification, flags: AuditLogFlags): Promise<AuditRecords> {
  const params = justificationParams(auditLogQuery(flags), why);
  return staffRequest(context, `/v1/admin/audit/${orgId}/records?${params.toString()}`, AuditRecordsSchema);
}

export function staffExportTransport(context: StaffAuditContext, orgId: OrgId, why: StaffJustification): AuditExportTransport {
  const base = `/v1/admin/audit/${orgId}/exports`;
  return {
    pollMs: STAFF_POLL_MS,
    backoff: STAFF_BACKOFF,
    orgId: async () => orgId,
    start: (request) => staffRequest(context, base, AuditExportStartSchema, { method: "POST", body: { ...request, reason: why.reason, ...(why.ticket === undefined ? {} : { ticket: why.ticket }) } }),
    poll: (exportId) => staffRequest(context, `${base}/${exportId}?${justificationParams(new URLSearchParams(), why).toString()}`, AuditExportViewSchema),
  };
}
