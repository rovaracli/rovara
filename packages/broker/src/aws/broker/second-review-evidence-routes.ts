// Second review (lane cr-settings, switch `cr`): the writers of the evidence that lets a model block. They are ADMIN-POOL routes: on the hosted cloud that pool is Rovara staff, on a single-company install it is the
// install's own administrator (the edition's closed list of operator routes names these two paths; `staff-routes.ts`). A company's admins, members and projects have no route that writes them; an admin can only withdraw
// a verdict (`/v1/app/org/second-review`, action `withdraw`).
//   POST /v1/admin/org/second-review/replay    { orgId?, run }                                              stores a replay run, once
//   POST /v1/admin/org/second-review/verdict   { orgId?, model, replayRunId, startedAt, endedAt }           stores the evidence for a model: the run it rests on and the shadow window (the broker counts it)
// `orgId` names the company on the hosted cloud (and must be a company that exists); on a single-company install it is that company, and a different one is refused. Nothing a caller sends is a pass: whether the
// model holds is recomputed from the stored run and window whenever it is read. Behind `cr`: with it off the paths are not found.
import { z } from "zod";
import { agentXError, auditEventId, auditOperatorId, OrgIdSchema, SecondReviewModelRefSchema, type AuditEventInput, type OrgId } from "@agentx/contracts";
import { randomUUID } from "node:crypto";
import type { AuthenticatedIdentity } from "../../auth.js";
import { flushAuditEvents } from "../../audit/flush.js";
import { auditPending } from "../../audit/outbox.js";
import { recordReplayRun, recordVerdict, type EvidenceFailure } from "../../org/second-review-evidence.js";
import type { ModeAudit } from "../../org/second-review-mode.js";
import { requireOrgId } from "../../org/resolve.js";
import { secondReviewEnabled } from "../../rovara-code/second-review-switch.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { orgStoreOf } from "./dependency-wiring.js";

export const SECOND_REVIEW_EVIDENCE_PATH = /^\/v1\/admin\/org\/second-review\/(replay|verdict)$/u;

const ReplayBody = z.object({ orgId: OrgIdSchema.optional(), run: z.unknown() }).strict();
const VerdictBody = z.object({ orgId: OrgIdSchema.optional(), model: SecondReviewModelRefSchema, replayRunId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/u), startedAt: z.string().datetime(), endedAt: z.string().datetime() }).strict();

const REFUSALS: Record<EvidenceFailure, () => Error> = {
  invalid: () => agentXError("CONFIG_INVALID", "run: not a valid replay run, or the evidence is not valid."),
  audit_unavailable: () => agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger."),
  run_exists: () => agentXError("CHANGE_STALE", "A replay run with that id is stored already; runs are never changed."),
  run_missing: () => agentXError("NOT_FOUND", "No such replay run for this company."),
  model_mismatch: () => agentXError("CONFIG_INVALID", "That replay run is for another model."),
  window_invalid: () => agentXError("CONFIG_INVALID", "The shadow window must start after the replay run and must not end in the future."),
  no_shadow_evidence: () => agentXError("CONFIG_INVALID", "This company's track record has no second opinions from that model in that window."),
  not_found: () => agentXError("NOT_FOUND", "No such verdict."),
  already_withdrawn: () => agentXError("CHANGE_STALE", "That verdict was withdrawn already."),
  conflict: () => agentXError("CHANGE_STALE", "The evidence could not be stored. Try again."),
};

async function orgOf(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, named: OrgId | undefined): Promise<OrgId> {
  // A single-company install has one company: the caller's. A hosted cloud has many, so the caller names one that exists.
  if (dependencies.cloud !== true) {
    const own = requireOrgId(identity.orgId);
    if (named !== undefined && named !== own) throw agentXError("FORBIDDEN", "This install has one company.");
    return own;
  }
  if (named === undefined) throw agentXError("CONFIG_INVALID", "orgId: required");
  if ((await orgStoreOf(dependencies).getOrg(named)) === undefined) throw agentXError("NOT_FOUND", "No such company.");
  return named;
}

/** The reply, or undefined when `cr` is off or the path is not one of these. */
export async function routeSecondReviewEvidence(dependencies: AwsBrokerDependencies, identity: AuthenticatedIdentity, request: { method: string }, url: URL, body: unknown, env: NodeJS.ProcessEnv = process.env): Promise<{ status: number; body: unknown } | undefined> {
  const match = SECOND_REVIEW_EVIDENCE_PATH.exec(url.pathname);
  if (match === null || !secondReviewEnabled(env) || request.method !== "POST") return undefined;
  if (!identity.isAdministrator) throw agentXError("FORBIDDEN", "administrator claim is required");
  const operator = { kind: "operator" as const, id: auditOperatorId(identity.issuer, identity.subject) };
  const auditDeps = { ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }) };
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  const parse = <T>(schema: z.ZodType<T>): T => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) { const issue = parsed.error.issues[0]; throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`); }
    return parsed.data;
  };
  const named = (match[1] === "replay" ? parse(ReplayBody) : parse(VerdictBody));
  const orgId = await orgOf(dependencies, identity, named.orgId);
  // The chain names the staff member or operator by a pseudonymous id, never by their identity.
  const audit: ModeAudit = {
    pending(event, _by, at) {
      const when = new Date(at).toISOString();
      const full: AuditEventInput = { ...event, eventId: auditEventId(event.action, orgId, when, operator.id, randomUUID()), orgId, actor: operator, occurredAt: when };
      const put = auditPending(auditDeps, full)[0]?.Put;
      return put === undefined ? undefined : { put: { Put: put }, flush: () => flushAuditEvents(auditDeps, [full]) };
    },
  };
  const deps = { table, audit, now: () => Date.now() };
  if (match[1] === "replay") {
    const result = await recordReplayRun(deps, { orgId, run: (named as z.infer<typeof ReplayBody>).run, by: operator.id });
    if (!result.ok) throw REFUSALS[result.code]();
    return { status: 201, body: { status: "stored", summary: result.summary } };
  }
  const verdict = named as z.infer<typeof VerdictBody>;
  const result = await recordVerdict(deps, { orgId, model: verdict.model, replayRunId: verdict.replayRunId, startedAt: verdict.startedAt, endedAt: verdict.endedAt, by: operator.id });
  if (!result.ok) throw REFUSALS[result.code]();
  // What holds NOW, recomputed, for the writer to read; nothing here is stored as a pass.
  return { status: 201, body: { status: "stored", holds: result.holds, replay: result.replay, shadow: result.shadow } };
}
