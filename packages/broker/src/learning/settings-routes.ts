// v1.2 learning loop: `GET` and `PUT /v1/app/org/learning-settings`, the company's master "suggestions" switch (suggestions-switch.ts). A live browser session only (developer-routes.ts refuses
// anything else before it gets here, with the normal CSRF and origin checks of the web boundary). Any company member reads; only the company's owner or an admin changes it, at once and with
// no second person (both directions are safe: `on` only shows cards a maintainer still has to Accept). Bodies are strict; the caller's role is the live one from this request's session.
import { LearningCompanySettingsBodySchema, agentXError, type LearningCompanySettingsAnswer } from "@rovara-code/contracts";
import { orgScoped } from "@rovara-code/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { takeRateAt } from "../developer/page-comments.js";
import { memberActor } from "./audit.js";
import { canChangeSuggestions, effectiveSuggestions, putSuggestionsSwitch, settingsAnswer } from "./suggestions-switch.js";
import type { LearningDeps } from "./store.js";

export const LEARNING_SETTINGS_PATH = "/v1/app/org/learning-settings";

/** Changes a minute: per person, and per company across all its people. */
export const LEARNING_SETTINGS_PER_PERSON_PER_MINUTE = 10;
export const LEARNING_SETTINGS_PER_COMPANY_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;

export type LearningSettingsRouteDependencies = Pick<LearningDeps, "documentClient" | "tableName" | "now" | "audit"> & {
  limits?: { person?: number; company?: number };
};

async function throttle(deps: LearningSettingsRouteDependencies, caller: DeveloperCaller): Promise<void> {
  const buckets = [
    { actor: caller.developerId, limit: deps.limits?.person ?? LEARNING_SETTINGS_PER_PERSON_PER_MINUTE },
    { actor: "ALL", limit: deps.limits?.company ?? LEARNING_SETTINGS_PER_COMPANY_PER_MINUTE },
  ];
  for (const bucket of buckets) {
    let accepted: boolean;
    try { accepted = await takeRateAt({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, { pk: orgScoped(caller.orgId, "LEARNING_SETTINGS_WRITES"), sk: bucket.actor }, bucket.limit, RATE_WINDOW_MS); }
    catch { throw agentXError("RUNTIME_UNAVAILABLE", "The setting could not be saved. Try again."); }
    if (!accepted) throw agentXError("TOO_MANY_REQUESTS", "Too many changes to this setting. Try again in a minute.");
  }
}

export async function routeLearningSettings(deps: LearningSettingsRouteDependencies, caller: DeveloperCaller, method: string, body: () => unknown): Promise<LearningCompanySettingsAnswer> {
  if (method === "GET") return settingsAnswer(await effectiveSuggestions(deps, caller.orgId), caller.orgRole);
  if (!canChangeSuggestions(caller.orgRole)) throw agentXError("FORBIDDEN", "Only a company owner or admin can change this setting.");
  const parsed = LearningCompanySettingsBodySchema.safeParse(body());
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the caller's.
    const path = issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".");
    throw agentXError("CONFIG_INVALID", `${path}: ${issue === undefined || issue.code === "unrecognized_keys" ? "has a field this route does not take" : issue.message}`);
  }
  await throttle(deps, caller);
  const written = await putSuggestionsSwitch(deps, {
    orgId: caller.orgId, actor: memberActor(caller.developerId), developerId: caller.developerId, expectedRevision: parsed.data.expectedRevision, suggestions: parsed.data.suggestions,
  });
  return settingsAnswer(written, caller.orgRole);
}
