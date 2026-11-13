// Company rollout gates (TE-A1): the owner's and admin's "Preview features" route.
//
//   GET /v1/app/org/feature-rollout    the company's gates: each with its own switch and whether the install's switch lets it take effect; the revision
//   PUT /v1/app/org/feature-rollout    { expectedRevision, features: { <name>: boolean | null } }    changes only what is named (null: back to the default)
//
// An owner or admin of the company only, from a live browser session only (a token, the CLI or Slack never read or change them). The company is always the caller's checked company: the route takes no company, key or id from the
// request, so another company's gates cannot be named, read or written. A change needs a sign-in within the last ten minutes (REAUTH_REQUIRED) and the audit ledger (`company.feature_rollout_changed`, in the same transaction as the
// change). A gate name outside the closed list is refused. Nothing the caller sent is repeated in a refusal.
import { FeatureRolloutBodySchema } from "@agentx/cloud-contracts";
import { agentXError, orgScoped } from "@rovara-code/contracts";
import { takeRateAt } from "../../developer/page-comments.js";
import { isFreshSignIn, type SessionRecord } from "../../developer/store.js";
import { adminAnswerOf, readFeatureRolloutFresh, writeFeatureRollout } from "../../org/feature-rollout.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { getSignIn } from "./authentication.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const FEATURE_ROLLOUT_PATH = "/v1/app/org/feature-rollout";
export const FEATURE_ROLLOUT_BROWSER_MESSAGE = "Use a live browser session to see or change preview features.";
export const FEATURE_ROLLOUT_FRESH_SIGN_IN_MESSAGE = "Sign in again to change preview features.";
/** Changes a minute, for the whole company. */
export const FEATURE_ROLLOUT_PER_MINUTE = 10;
const RATE_WINDOW_MS = 60_000;

async function requireFreshBrowserSignIn(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<void> {
  const session = await getSignIn<Pick<SessionRecord, "authTime">>(deps, `SESSION#${caller.sessionId}`);
  if (session === undefined || !isFreshSignIn(session, deps.now())) throw agentXError("REAUTH_REQUIRED", FEATURE_ROLLOUT_FRESH_SIGN_IN_MESSAGE);
}

async function throttle(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<void> {
  let accepted: boolean;
  try { accepted = await takeRateAt({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, { pk: orgScoped(caller.orgId, "FEATURE_ROLLOUT_WRITES"), sk: "ALL" }, FEATURE_ROLLOUT_PER_MINUTE, RATE_WINDOW_MS); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "The change could not be saved. Try again."); }
  if (!accepted) throw agentXError("TOO_MANY_REQUESTS", "Too many changes to preview features. Try again in a minute.");
}

/** The reply, or undefined when the path is not this one. */
export async function routeFeatureRollout(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, pathname: string, environment: Record<string, string | undefined> = process.env): Promise<unknown> {
  if (pathname !== FEATURE_ROLLOUT_PATH) return undefined;
  if (request.method !== "GET" && request.method !== "PUT") throw agentXError("NOT_FOUND", "route not found");
  // Defence in depth: the entry file refuses a token before this, and so does this.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", FEATURE_ROLLOUT_BROWSER_MESSAGE);
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "Only a company owner or admin can see or change preview features.");
  const store = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, audit: deps.audit };
  if (request.method === "GET") return adminAnswerOf(await readFeatureRolloutFresh(store, caller.orgId), environment);
  await requireFreshBrowserSignIn(deps, caller);
  const parsed = FeatureRolloutBodySchema.safeParse(jsonBody(request));
  // Field names only: the values and any unknown key are the caller's.
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "The change names a preview feature this company does not have, names nothing to change, or has a field this route does not take.");
  await throttle(deps, caller);
  const written = await writeFeatureRollout(store, { orgId: caller.orgId, developerId: caller.developerId, expectedRevision: parsed.data.expectedRevision, change: parsed.data.features });
  return adminAnswerOf(written, environment);
}
