// Second review by another AI company (SR-1, switch `cr`): `/v1/app/org/second-review`, the picker's preview and the company's choice. Behind `cr`: with it off the path is not found, as any unknown path. `org` is a
// browser route family, so the app reaches it as `/v1/web/org/second-review`. The settings screen on top of it is a pending item.
//   GET   ?project=<name>&builder=<provider>:<modelId>[&builder=...]   any member of the company: the list of models the company can actually use (its connected sources plus Rovara's own; maker, estimated cost per
//         review, fit against the models that write the code, notes), the 2-3 suggestions, the company's choice and the project's narrowing, and who would review now: the choice, else "Using default: <model> (change)",
//         else the reason nothing qualifies. Nothing here calls a model.
//   POST  from a live browser session only (a token, the CLI or Slack never change it); audited, never silent:
//           { action: "choose", primary, backup? }         an owner or admin. A primary and an optional backup, in order; each must be a model the company can use. Not a loosening, so no second person.
//           { action: "clear" }                            an owner or admin. Nobody has chosen: the default stands again.
//           { action: "narrow", project, models | null }   an owner, admin or the project's maintainer. A subset of the company's choice, never wider (anything outside it is refused).
//           { action: "mode", scope: "company", mode }      an owner or admin. `review.otherCompany`: off, shadow or on. Raising applies at once; `on` is refused unless the evidence for the chosen model holds.
//           { action: "mode", scope: "project", project, mode | "inherit" }   an owner, admin or the project's maintainer: a project override that can only be as strict as the company's mode or stricter ("inherit" clears it).
//                                                           Pinning a project to `on` is an ADMIN's decision (a maintainer may pin shadow), needs the evidence for the model even when the company is `on`, and lapses when the company is lowered.
//                                                           LOWERING either (on to shadow or off, shadow to off) is a proposal (202 needs_approval) that a DIFFERENT eligible person approves (the one-admin rule: no sole-owner exception).
//           { action: "approve-mode", changeId }            a different eligible person approves a lowering, signed in within the last 10 minutes (REAUTH_REQUIRED otherwise).
//           { action: "cancel-mode", changeId }             an eligible person withdraws a waiting proposal.
//           { action: "notice-seen", key }                  an owner or admin: "I've seen it" for the notice that the reviewer model stopped qualifying (the decision card goes away; the problem stays on the page until it is fixed).
//           { action: "withdraw", model }                   an owner or admin withdraws the verdict (the evidence) for a model: it stops blocking at once. Admins can only withdraw; staff write evidence (aws/broker/second-review-evidence-routes.ts).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SecondReviewContextSchema, SecondReviewModeSchema, SecondReviewModelListSchema, agentXError, configuredSecondReviewMode, narrowedSecondReviewModels, secondReviewModelKey, type AuditEventInput, type ModelIdentifier, type SecondReviewModelRef } from "@agentx/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { flushAuditEvents } from "../../audit/flush.js";
import { auditPending } from "../../audit/outbox.js";
import { auditEventId } from "@agentx/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { readGuardrails } from "../../agents/guardrails.js";
import { servableModels } from "../../model-sources/routing.js";
import { companyChoiceUpdate, companyContextUpdate, projectNarrowingUpdate, readSecondReviewSettings, type SettingsUpdate } from "../../org/second-review-settings.js";
import { approveSecondReviewModeChange, cancelSecondReviewModeChange, effectiveMode, getModeChange, openModeChanges, requestSecondReviewMode, type ModeAudit, type ModeDeps, type ModeFailure } from "../../org/second-review-mode.js";
import { evidenceViewOf, verdictHoldsFor, withdrawVerdict } from "../../org/second-review-evidence.js";
import { readTrackRecord } from "../../rovara-code/second-review-track.js";
import { markNoticeSeen, noticeLines, readNotice } from "../../rovara-code/second-review-notice.js";
import { requireFreshSignIn } from "./test-environment-wizard.js";
import { defaultModelLine, secondReviewPicker, SECOND_REVIEW_TYPICAL_REVIEW_TOKENS } from "../../rovara-code/second-review-picker.js";
import { planSecondReview } from "../../rovara-code/second-review.js";
import { secondReviewEnabled } from "../../rovara-code/second-review-switch.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const SECOND_REVIEW_PATH = "/v1/app/org/second-review";
export const SECOND_REVIEW_BROWSER_MESSAGE = "Use a live browser session to change the second review's model.";

const Ref = z.object({ provider: z.string().min(1).max(128), modelId: z.string().min(1).max(256) }).strict();
const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("choose"), primary: Ref, backup: Ref.optional() }).strict(),
  z.object({ action: z.literal("clear") }).strict(),
  z.object({ action: z.literal("context"), context: SecondReviewContextSchema }).strict(),
  z.object({ action: z.literal("narrow"), project: z.string().min(1).max(64), models: z.array(Ref).max(2).nullable() }).strict(),
  // One schema for both scopes (a discriminated union cannot hold the same action twice): a company mode names no project and cannot "inherit"; a project mode names its project.
  z.object({ action: z.literal("mode"), scope: z.enum(["company", "project"]), project: z.string().min(1).max(64).optional(), mode: z.union([SecondReviewModeSchema, z.literal("inherit")]) }).strict()
    .superRefine((body, context) => {
      if (body.scope === "company" && (body.project !== undefined || body.mode === "inherit")) context.addIssue({ code: "custom", path: ["scope"], message: "a company mode names no project and is not inherited" });
      if (body.scope === "project" && body.project === undefined) context.addIssue({ code: "custom", path: ["project"], message: "required" });
    }),
  z.object({ action: z.literal("approve-mode"), changeId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u) }).strict(),
  z.object({ action: z.literal("cancel-mode"), changeId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u) }).strict(),
  z.object({ action: z.literal("withdraw"), model: Ref }).strict(),
  z.object({ action: z.literal("notice-seen"), key: z.string().regex(/^[a-f0-9]{32}$/u) }).strict(),
]);

/** What each refusal of the mode writer says, in fixed words (the code decides the error, never a message from below). */
function modeRefusal(code: ModeFailure): Error {
  switch (code) {
    case "not_eligible": return agentXError("FORBIDDEN", "Only a company owner or admin, or the project's maintainer, can change this.");
    case "second_person_required": return agentXError("FORBIDDEN", "A different admin has to approve lowering this.");
    case "eligibility_unavailable": return agentXError("RUNTIME_UNAVAILABLE", "Rovara could not check who may change this. Try again.");
    case "audit_unavailable": return agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
    case "already_open": return agentXError("CHANGE_STALE", "A proposal to lower this is already waiting for a different admin.");
    case "expired": return agentXError("CHANGE_STALE", "That proposal expired. Ask again.");
    case "not_found": return agentXError("NOT_FOUND", "No such proposal.");
    case "below_company_mode": return agentXError("FORBIDDEN", "A project can be as strict as the company's setting or stricter, never less strict.");
    case "verdict_missing": return agentXError("FORBIDDEN", "Blocking can be turned on only for a reviewer model whose trial record and replay check hold. Choose the model first, then wait for its record.");
    case "membership_changed_retry": return agentXError("CHANGE_STALE", "Someone joined or left the admins meanwhile. Check and approve again.");
    case "settings_unreadable": return agentXError("RUNTIME_UNAVAILABLE", "Rovara could not read this setting. Try again.");
    default: return agentXError("CHANGE_STALE", "This setting changed. Reload and try again.");
  }
}

const isAdmin = (caller: DeveloperCaller): boolean => caller.orgRole === "owner" || caller.orgRole === "admin";
const builderOf = (url: URL): ModelIdentifier[] => url.searchParams.getAll("builder").flatMap((value) => {
  const at = value.indexOf(":");
  return at > 0 && at < value.length - 1 ? [{ provider: value.slice(0, at), modelId: value.slice(at + 1) }] : [];
});

async function listOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller, project: string | undefined, against: readonly ModelIdentifier[], fitUnknown = false) {
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  const routing = deps.agents?.modelRouting ?? {};
  const sources = await servableModels(routing, caller.orgId, project);
  const forbidden = (await readGuardrails({ documentClient: deps.documentClient, tableName: deps.tableName }, caller.orgId)).forbiddenModels ?? [];
  const settings = await readSecondReviewSettings(table, caller.orgId, project ?? "");
  const price = (model: ModelIdentifier) => { const found = listPricesPerMillion(model); return found === undefined ? undefined : { inputUsdPerMTok: found.input, outputUsdPerMTok: found.output }; };
  const picker = secondReviewPicker({ sources, project: {}, forbidden, against, fitUnknown, price, verdicts: settings.verdicts, replayRuns: settings.replayRuns });
  return { picker, settings, sources, forbidden, price };
}

/** The reply, or undefined when the switch is off or the path is not this one. */
export async function routeSecondReview(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  if (!secondReviewEnabled(env) || url.pathname !== SECOND_REVIEW_PATH) return undefined;
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  if (request.method === "GET") {
    const project = url.searchParams.get("project") ?? undefined;
    // A project is named only by someone who is in it (and only a project the company has): anyone else is told it is not there, as the models list does.
    if (project !== undefined && await deps.agents?.projectMembers.roleOf(caller.orgId, project, { developerId: caller.developerId, orgRole: caller.orgRole }) === undefined) throw agentXError("NOT_FOUND", "Not found.");
    const against = builderOf(url);
    // Without the model that writes the code (the company's settings page: it differs per task) fit is only "its maker is known", and `fitKnown` says so; a task checks the real fit when it starts.
    const fitKnown = against.length > 0;
    const { picker, settings, sources, forbidden, price } = await listOf(deps, caller, project, against, !fitKnown);
    const mode = configuredSecondReviewMode({ project: settings.projectMode, companyDefault: settings.companyDefault, companyLock: settings.companyLock });
    const plan = !fitKnown ? undefined : planSecondReview({ switchOn: true, mode: mode === "off" ? "shadow" : mode, against, project: {}, forbidden, sources, verdicts: settings.verdicts, replayRuns: settings.replayRuns,
      companyModels: settings.companyModels, projectModels: settings.projectModels, price });
    const chosen = narrowedSecondReviewModels({ company: settings.companyModels, project: settings.projectModels });
    // The model the admin's "turn on" decision is about: the company's (or the project's narrowed) primary, else the one that would review now. Its evidence and its track record on this company.
    const topSuggestion = picker.suggested[0]?.model;
    const primary = chosen.models?.[0] ?? (plan?.run === true ? plan.model : plan === undefined ? topSuggestion : undefined);
    const evidence = primary === undefined ? null : evidenceViewOf(settings, primary);
    const trackRecord = primary === undefined ? null : await readTrackRecord(table, caller.orgId, secondReviewModelKey(primary), undefined, deps.now()).catch(() => null);
    const pending = await openModeChanges(table, caller.orgId, deps.now()).catch(() => []);
    const notice = await readNotice(table, caller.orgId).catch(() => undefined);
    return new StatusReply(200, {
      mode,
      modes: { company: effectiveMode(settings, { kind: "company" }), project: project === undefined ? null : settings.projectMode ?? null, effective: mode },
      // A member sees that a lowering is waiting; only an admin is told which, and whether it is theirs.
      pendingLowering: pending.some((change) => project === undefined || change.scope.kind === "company" || change.scope.project === project),
      ...(isAdmin(caller) ? { pending: pending.map((change) => ({ changeId: change.id, scope: change.scope.kind, ...(change.scope.kind === "project" ? { project: change.scope.project } : {}), from: change.from, to: change.to, proposedByYou: change.proposedBy === caller.developerId, expiresAt: new Date(change.expiresAt).toISOString() })) } : {}),
      evidence,
      trackRecord,
      // The notice that the model stopped qualifying, while the mode is not off. Anyone who reads the page sees that there is one; the words are the same fixed sentences.
      notice: notice === undefined || mode === "off" ? null : { key: notice.key, code: notice.code, seen: notice.status === "seen", lines: noticeLines(notice), createdAt: notice.createdAt },
      context: settings.context,
      alsoSees: settings.context === "same_as_first" ? "Second reviewer also sees what the first reviewer sees: the connected sources, lessons and step instructions." : null,
      models: picker.entries,
      suggested: picker.suggested.map((entry) => ({ provider: entry.model.provider, modelId: entry.model.modelId })),
      typicalReview: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS,
      choice: settings.companyModels === undefined ? null : { models: settings.companyModels },
      projectNarrowing: settings.projectModels === undefined ? null : { models: settings.projectModels },
      fitKnown,
      current: plan === undefined
        ? (chosen.choice === "company" && chosen.models !== undefined && chosen.models.length > 0
          ? { source: "company", models: chosen.models, line: `Reviewed by ${chosen.models[0]!.modelId} (company choice)` }
          : topSuggestion !== undefined ? { source: "default", models: [topSuggestion], line: defaultModelLine(topSuggestion, false) } : { source: "none", models: [], reason: "no-candidate" })
        : plan.run
        ? { source: plan.choice, models: plan.candidates, line: plan.choice === "default" ? defaultModelLine(plan.model, false) : `Reviewed by ${plan.model.modelId} (company choice)`, ...(plan.skipped.length === 0 ? {} : { skipped: plan.skipped }) }
        : { source: chosen.choice === "company" ? "choice" : "none", models: [], reason: plan.reason, ...(plan.skipped === undefined ? {} : { skipped: plan.skipped }) },
    });
  }
  if (request.method !== "POST") return undefined;
  // Defence in depth: the entry file refuses a token before this, and so does this.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", SECOND_REVIEW_BROWSER_MESSAGE);
  const parsed = BodySchema.safeParse(jsonBody(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the person's.
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const body = parsed.data;
  const projectAction = body.action === "narrow" || (body.action === "mode" && body.scope === "project");
  const changeAction = body.action === "approve-mode" || body.action === "cancel-mode";
  if (!projectAction && !changeAction && !isAdmin(caller)) throw agentXError("FORBIDDEN", "Only a company owner or admin can change this.");
  const mayAsMaintainer = async (project: string): Promise<void> => {
    // The project must be one the company has (an unknown name is not found, for an admin too), and the caller its maintainer (an owner or admin counts as one).
    const role = await deps.agents?.projectMembers.roleOf(caller.orgId, project, { developerId: caller.developerId, orgRole: caller.orgRole });
    if (role === undefined) throw agentXError("NOT_FOUND", "Not found.");
    if (role !== "maintainer") throw agentXError("FORBIDDEN", "Only a company owner or admin, or the project's maintainer, can change this.");
  };
  if (body.action === "narrow") await mayAsMaintainer(body.project);
  if (body.action === "mode" && body.scope === "project") await mayAsMaintainer(body.project ?? "");
  const at = deps.now();
  const auditDeps = { ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
  /**
   * The change and its audit event in ONE transaction: a change is never unaudited, and an audit event never names a change that was not made. With no ledger the change is refused. The event is sent on after it commits.
   */
  const commit = async (change: SettingsUpdate, event: Omit<AuditEventInput, "eventId" | "orgId" | "actor" | "occurredAt">): Promise<void> => {
    const when = new Date(at).toISOString();
    const full: AuditEventInput = { ...event, eventId: auditEventId(event.action, caller.orgId, when, caller.developerId, randomUUID()), orgId: caller.orgId, actor: { kind: "member", id: caller.developerId }, occurredAt: when };
    const put = auditPending(auditDeps, full)[0]?.Put;
    if (put === undefined) throw agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [change, { Put: put }] }));
    await flushAuditEvents(auditDeps, [full]);
  };
  const orgTarget = { kind: "org" as const, id: caller.orgId.slice(0, 100) };
  if (body.action === "clear") {
    await commit(companyChoiceUpdate(table, { orgId: caller.orgId, models: undefined, by: caller.developerId, at }), { action: "company.second_review_choice_changed", target: orgTarget, facts: { change: "clear", count: 0 } });
    logDeveloperEvent({ event: "developer.second_review_choice_cleared", orgId: caller.orgId });
    return new StatusReply(200, { status: "applied", choice: null });
  }
  if (body.action === "context") {
    // Not a loosening that needs a second person, but it widens what is shared with the second reviewer's company when it goes to `same_as_first`, so the audit event says so.
    const current = (await readSecondReviewSettings(table, caller.orgId, "")).context;
    await commit(companyContextUpdate(table, { orgId: caller.orgId, context: body.context, by: caller.developerId, at }),
      { action: "company.second_review_context_changed", target: orgTarget, facts: { to: body.context, widens: current === "change_only" && body.context === "same_as_first" } });
    logDeveloperEvent({ event: "developer.second_review_context_set", orgId: caller.orgId, to: body.context });
    return new StatusReply(200, { status: "applied", context: body.context });
  }
  if (body.action === "mode" || body.action === "approve-mode" || body.action === "cancel-mode") return modeAction(deps, caller, body, at, mayAsMaintainer, modeAuditOf(deps, caller, auditDeps));
  if (body.action === "notice-seen") {
    const seen = await markNoticeSeen(table, caller.orgId, body.key, at);
    if (!seen) throw agentXError("CHANGE_STALE", "That notice changed or was seen already. Reload.");
    return new StatusReply(200, { status: "applied" });
  }
  if (body.action === "withdraw") {
    const result = await withdrawVerdict({ table, audit: modeAuditOf(deps, caller, auditDeps), now: () => at }, { orgId: caller.orgId, model: body.model, by: caller.developerId });
    if (!result.ok) throw result.code === "not_found" ? agentXError("NOT_FOUND", "No such verdict.") : result.code === "audit_unavailable" ? agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.") : agentXError("CHANGE_STALE", "That verdict was withdrawn already.");
    logDeveloperEvent({ event: "developer.second_review_verdict_withdrawn", orgId: caller.orgId });
    return new StatusReply(200, { status: "applied", evidence: evidenceViewOf(await readSecondReviewSettings(table, caller.orgId, ""), body.model) });
  }
  // A model must be one the company can use today (its sources plus Rovara's, allowed, not forbidden); fit against a particular builder is checked when a review starts, not here.
  const { picker, settings } = await listOf(deps, caller, body.action === "narrow" ? body.project : undefined, []);
  const usable = new Set(picker.entries.map((entry) => secondReviewModelKey(entry.model)));
  const requested: SecondReviewModelRef[] = body.action === "choose" ? [body.primary, ...(body.backup === undefined ? [] : [body.backup])] : body.models ?? [];
  const valid = SecondReviewModelListSchema.safeParse(requested);
  if (!valid.success) throw agentXError("CONFIG_INVALID", "models: a model appears twice");
  if (requested.some((model) => !usable.has(secondReviewModelKey(model)))) throw agentXError("MODEL_NOT_ALLOWED", "That model is not one your company can use.");
  if (body.action === "choose") {
    await commit(companyChoiceUpdate(table, { orgId: caller.orgId, models: requested, by: caller.developerId, at }), { action: "company.second_review_choice_changed", target: orgTarget, facts: { change: "choose", count: requested.length } });
    logDeveloperEvent({ event: "developer.second_review_choice_set", orgId: caller.orgId, count: String(requested.length) });
    return new StatusReply(200, { status: "applied", choice: { models: requested } });
  }
  // Narrowing: a subset of the company's choice, never wider. With no company choice it is a subset of the models the company can use.
  if (settings.companyModels !== undefined) {
    const allowed = new Set(settings.companyModels.map(secondReviewModelKey));
    if (requested.some((model) => !allowed.has(secondReviewModelKey(model)))) throw agentXError("FORBIDDEN", "A project can narrow the company's choice but never widen it.");
  }
  await commit(projectNarrowingUpdate(table, { orgId: caller.orgId, project: body.project, models: body.models === null ? undefined : requested, by: caller.developerId, at }),
    { action: "project.second_review_narrowed", target: { kind: "project", name: body.project }, facts: { change: body.models === null ? "clear" : "choose", count: requested.length } });
  logDeveloperEvent({ event: "developer.second_review_narrowed", orgId: caller.orgId, count: String(requested.length) });
  return new StatusReply(200, { status: "applied", projectNarrowing: body.models === null ? null : { models: requested } });
}


/** The mode writer's audit events, as pending items in the same transaction as the change, sent on after it commits. */
function modeAuditOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller, auditDeps: { audit?: NonNullable<DeveloperRouteDependencies["audit"]> }): ModeAudit {
  return {
    pending(event, actorId, at) {
      const when = new Date(at).toISOString();
      const full: AuditEventInput = { ...event, eventId: auditEventId(event.action, caller.orgId, when, actorId, randomUUID()), orgId: caller.orgId, actor: { kind: "member", id: actorId }, occurredAt: when };
      const put = auditPending(auditDeps, full)[0]?.Put;
      return put === undefined ? undefined : { put: { Put: put }, flush: () => flushAuditEvents(auditDeps, [full]) };
    },
  };
}

type ModeBody = Extract<z.infer<typeof BodySchema>, { action: "mode" | "approve-mode" | "cancel-mode" }>;

async function modeAction(deps: DeveloperRouteDependencies, caller: DeveloperCaller, body: ModeBody, at: number, mayAsMaintainer: (project: string) => Promise<void>, audit: ModeAudit): Promise<StatusReply> {
  const signInTableName = deps.developer?.signInTableName;
  if (signInTableName === undefined || signInTableName === "") throw agentXError("RUNTIME_UNAVAILABLE", "This setting is not available here.");
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  const modeDeps: ModeDeps = { table, evidence: { documentClient: deps.documentClient, tableName: deps.tableName, signInTableName, now: deps.now }, audit, now: () => at };
  if (body.action === "mode") {
    const scope = body.scope === "company" ? { kind: "company" as const } : { kind: "project" as const, project: body.project ?? "" };
    // Blocking for a project is an admin's decision, not the project maintainer's (owner decision 2026-11-02).
    if (scope.kind === "project" && body.mode === "on" && !isAdmin(caller)) throw agentXError("FORBIDDEN", "Only a company owner or admin can turn blocking on for a project.");
    // `on` needs the evidence for the model the company (or the project's narrowed list) chose first; with nobody having chosen there is no model for the evidence to be about.
    const settings = await readSecondReviewSettings(table, caller.orgId, scope.kind === "project" ? scope.project : "");
    const chosen = scope.kind === "company" ? settings.companyModels : narrowedSecondReviewModels({ company: settings.companyModels, project: settings.projectModels }).models;
    const onAllowed = chosen?.[0] !== undefined && verdictHoldsFor(settings, chosen[0]);
    const result = await requestSecondReviewMode(modeDeps, { orgId: caller.orgId, scope, to: body.mode, requestedBy: caller.developerId, onAllowed, requesterIsAdmin: isAdmin(caller) });
    if (!result.ok) throw modeRefusal(result.code);
    logDeveloperEvent({ event: "developer.second_review_mode_set", orgId: caller.orgId, status: result.status });
    if (result.status === "needs_approval") return new StatusReply(202, { status: "needs_approval", changeId: result.changeId });
    return new StatusReply(200, { status: "applied", mode: result.mode });
  }
  // Approving or withdrawing a proposal: it names its own scope, and the person must be allowed to act there (a company: an admin; a project: its maintainer or an admin).
  const change = await getModeChange(table, caller.orgId, body.changeId).catch(() => undefined);
  if (change === undefined) throw agentXError("NOT_FOUND", "No such proposal.");
  if (change.scope.kind === "company") { if (!isAdmin(caller)) throw agentXError("FORBIDDEN", "Only a company owner or admin can change this."); } else await mayAsMaintainer(change.scope.project);
  if (body.action === "cancel-mode") {
    const result = await cancelSecondReviewModeChange(modeDeps, { orgId: caller.orgId, changeId: body.changeId, actorId: caller.developerId });
    if (!result.ok) throw modeRefusal(result.code);
    return new StatusReply(200, { status: "cancelled" });
  }
  // Lowering needs the approver to have signed in within the last 10 minutes (the same rule as turning "always two people" off): a left-open browser cannot lower the safeguard.
  await requireFreshSignIn(deps, caller);
  const result = await approveSecondReviewModeChange(modeDeps, { orgId: caller.orgId, changeId: body.changeId, approverId: caller.developerId });
  if (!result.ok) throw modeRefusal(result.code);
  logDeveloperEvent({ event: "developer.second_review_mode_approved", orgId: caller.orgId });
  return new StatusReply(200, { status: "applied", mode: result.mode });
}
