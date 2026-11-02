// Second review by another AI company (SR-1, switch `cr`): `/v1/app/org/second-review`, the picker's preview and the company's choice. Behind `cr`: with it off the path is not found, as any unknown path. `org` is a
// browser route family, so the app reaches it as `/v1/web/org/second-review`. The settings screen on top of it is a pending item.
//   GET   ?project=<name>&builder=<provider>:<modelId>[&builder=...]   any member of the company: the list of models the company can actually use (its connected sources plus Rovara's own; maker, estimated cost per
//         review, fit against the models that write the code, notes), the 2-3 suggestions, the company's choice and the project's narrowing, and who would review now: the choice, else "Using default: <model> (change)",
//         else the reason nothing qualifies. Nothing here calls a model.
//   POST  from a live browser session only (a token, the CLI or Slack never change it); audited, never silent:
//           { action: "choose", primary, backup? }         an owner or admin. A primary and an optional backup, in order; each must be a model the company can use. Not a loosening, so no second person.
//           { action: "clear" }                            an owner or admin. Nobody has chosen: the default stands again.
//           { action: "narrow", project, models | null }   an owner, admin or the project's maintainer. A subset of the company's choice, never wider (anything outside it is refused).
// The mode (off, shadow, on) and the evidence that lets a model block are not set here; this route changes which model reviews, never whether it blocks.
import { z } from "zod";
import { SecondReviewModelListSchema, agentXError, configuredSecondReviewMode, narrowedSecondReviewModels, secondReviewModelKey, type AuditEventInput, type ModelIdentifier, type SecondReviewModelRef } from "@agentx/contracts";
import { listPricesPerMillion } from "@agentx/model-runtime/catalog";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { flushAuditEvents } from "../../audit/flush.js";
import { auditPending } from "../../audit/outbox.js";
import { auditEventId } from "@agentx/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { readGuardrails } from "../../agents/guardrails.js";
import { servableModels } from "../../model-sources/routing.js";
import { readSecondReviewSettings, writeCompanyChoice, writeProjectNarrowing } from "../../org/second-review-settings.js";
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
  z.object({ action: z.literal("narrow"), project: z.string().min(1).max(64), models: z.array(Ref).max(2).nullable() }).strict(),
]);

const isAdmin = (caller: DeveloperCaller): boolean => caller.orgRole === "owner" || caller.orgRole === "admin";
const builderOf = (url: URL): ModelIdentifier[] => url.searchParams.getAll("builder").flatMap((value) => {
  const at = value.indexOf(":");
  return at > 0 && at < value.length - 1 ? [{ provider: value.slice(0, at), modelId: value.slice(at + 1) }] : [];
});

async function listOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller, project: string | undefined, against: readonly ModelIdentifier[]) {
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  const routing = deps.agents?.modelRouting ?? {};
  const sources = await servableModels(routing, caller.orgId, project);
  const forbidden = (await readGuardrails({ documentClient: deps.documentClient, tableName: deps.tableName } as never, caller.orgId)).forbiddenModels ?? [];
  const settings = await readSecondReviewSettings(table, caller.orgId, project ?? "");
  const price = (model: ModelIdentifier) => { const found = listPricesPerMillion(model); return found === undefined ? undefined : { inputUsdPerMTok: found.input, outputUsdPerMTok: found.output }; };
  const picker = secondReviewPicker({ sources, project: {}, forbidden, against, price, verdicts: settings.verdicts, replayRuns: settings.replayRuns });
  return { picker, settings, sources, forbidden, price };
}

/** The reply, or undefined when the switch is off or the path is not this one. */
export async function routeSecondReview(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  if (!secondReviewEnabled(env) || url.pathname !== SECOND_REVIEW_PATH) return undefined;
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  if (request.method === "GET") {
    const project = url.searchParams.get("project") ?? undefined;
    const against = builderOf(url);
    if (against.length === 0) throw agentXError("CONFIG_INVALID", "Name the model that writes the code (builder=provider:model) so each model's fit can be shown.");
    const { picker, settings, sources, forbidden, price } = await listOf(deps, caller, project, against);
    const mode = configuredSecondReviewMode({ project: settings.projectMode, companyDefault: settings.companyDefault, companyLock: settings.companyLock });
    const plan = planSecondReview({ switchOn: true, mode: mode === "off" ? "shadow" : mode, against, project: {}, forbidden, sources, verdicts: settings.verdicts, replayRuns: settings.replayRuns,
      companyModels: settings.companyModels, projectModels: settings.projectModels, price });
    const chosen = narrowedSecondReviewModels({ company: settings.companyModels, project: settings.projectModels });
    return new StatusReply(200, {
      mode,
      models: picker.entries,
      suggested: picker.suggested.map((entry) => ({ provider: entry.model.provider, modelId: entry.model.modelId })),
      typicalReview: SECOND_REVIEW_TYPICAL_REVIEW_TOKENS,
      choice: settings.companyModels === undefined ? null : { models: settings.companyModels },
      projectNarrowing: settings.projectModels === undefined ? null : { models: settings.projectModels },
      current: plan.run
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
  if (body.action !== "narrow" && !isAdmin(caller)) throw agentXError("FORBIDDEN", "Only a company owner or admin can change this.");
  if (body.action === "narrow" && !isAdmin(caller)) {
    const role = await deps.agents?.projectMembers.roleOf(caller.orgId, body.project, { developerId: caller.developerId, orgRole: caller.orgRole });
    if (role !== "maintainer") throw agentXError("FORBIDDEN", "Only a company owner or admin, or the project's maintainer, can change this.");
  }
  const at = deps.now();
  // The audit event is written to the pending outbox and sent; with no ledger the write throws and nothing is changed (a change of who reviews code is never silent).
  const auditDeps = { ...(deps.audit === undefined ? {} : { audit: deps.audit }) };
  const record = async (action: "company.second_review_choice_changed" | "project.second_review_narrowed", change: "choose" | "clear", count: number, project?: string): Promise<void> => {
    const when = new Date(at).toISOString();
    const event: AuditEventInput = {
      eventId: auditEventId(action, caller.orgId, when, caller.developerId), orgId: caller.orgId, action, actor: { kind: "member", id: caller.developerId },
      target: project === undefined ? { kind: "org", id: caller.orgId.slice(0, 100) } : { kind: "project", name: project }, occurredAt: when, facts: { change, count },
    };
    const put = auditPending(auditDeps, event)[0]?.Put;
    if (put === undefined) throw agentXError("AUDIT_UNAVAILABLE", "This change needs the audit ledger.");
    await deps.documentClient.send(new PutCommand(put));
    await flushAuditEvents(auditDeps, [event]);
  };
  if (body.action === "clear") {
    await record("company.second_review_choice_changed", "clear", 0);
    await writeCompanyChoice(table, { orgId: caller.orgId, models: undefined, by: caller.developerId, at });
    logDeveloperEvent({ event: "developer.second_review_choice_cleared", orgId: caller.orgId });
    return new StatusReply(200, { status: "applied", choice: null });
  }
  // A model must be one the company can use today (its sources plus Rovara's, allowed, not forbidden); fit against a particular builder is checked when a review starts, not here.
  const { picker, settings } = await listOf(deps, caller, body.action === "narrow" ? body.project : undefined, []);
  const usable = new Set(picker.entries.map((entry) => secondReviewModelKey(entry.model)));
  const requested: SecondReviewModelRef[] = body.action === "choose" ? [body.primary, ...(body.backup === undefined ? [] : [body.backup])] : body.models ?? [];
  const valid = SecondReviewModelListSchema.safeParse(requested);
  if (!valid.success) throw agentXError("CONFIG_INVALID", "models: a model appears twice");
  if (requested.some((model) => !usable.has(secondReviewModelKey(model)))) throw agentXError("MODEL_NOT_ALLOWED", "That model is not one your company can use.");
  if (body.action === "choose") {
    await record("company.second_review_choice_changed", "choose", requested.length);
    await writeCompanyChoice(table, { orgId: caller.orgId, models: requested, by: caller.developerId, at });
    logDeveloperEvent({ event: "developer.second_review_choice_set", orgId: caller.orgId, count: String(requested.length) });
    return new StatusReply(200, { status: "applied", choice: { models: requested } });
  }
  // Narrowing: a subset of the company's choice, never wider. With no company choice it is a subset of the models the company can use.
  if (settings.companyModels !== undefined) {
    const allowed = new Set(settings.companyModels.map(secondReviewModelKey));
    if (requested.some((model) => !allowed.has(secondReviewModelKey(model)))) throw agentXError("FORBIDDEN", "A project can narrow the company's choice but never widen it.");
  }
  await record("project.second_review_narrowed", body.models === null ? "clear" : "choose", requested.length, body.project);
  await writeProjectNarrowing(table, { orgId: caller.orgId, project: body.project, models: body.models === null ? undefined : requested, by: caller.developerId, at });
  logDeveloperEvent({ event: "developer.second_review_narrowed", orgId: caller.orgId, count: String(requested.length) });
  return new StatusReply(200, { status: "applied", projectNarrowing: body.models === null ? null : { models: requested } });
}
