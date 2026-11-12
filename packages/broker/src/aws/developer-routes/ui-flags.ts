// Runtime per-company UI flags (lane U5, requirement P-52): the owner's and admin's "Company screens" routes.
//
//   GET /v1/app/org/ui-flags    the company's flags: each with its own switch, the install operator's hold and what people get; the preview permission; the revision
//   PUT /v1/app/org/ui-flags    { expectedRevision, flags?: { <name>: boolean | null }, previews?: boolean }    changes only what is named (null: back to the default)
//
// An owner or admin of the company only (a member learns the flags from the navigation answer, `uiFlags`), from a live browser session only (a token, the CLI or Slack never read or change them). A change needs a sign-in within the
// last ten minutes (REAUTH_REQUIRED) and the audit ledger (`company.ui_flags_changed`, in the same transaction as the change). A flag name outside the closed list is refused. Nothing the caller sent is repeated in a refusal.
import { UiFlagsBodySchema } from "@agentx/cloud-contracts";
import { agentXError, orgScoped } from "@rovara-code/contracts";
import { takeRateAt } from "../../developer/page-comments.js";
import { isFreshSignIn, type SessionRecord } from "../../developer/store.js";
import { adminAnswerOf, operatorForcedOff, readUiFlags, writeUiFlags } from "../../org/ui-flags/store.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { getSignIn } from "./authentication.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const UI_FLAGS_PATH = "/v1/app/org/ui-flags";
export const UI_FLAGS_BROWSER_MESSAGE = "Use a live browser session to see or change company screens.";
export const UI_FLAGS_FRESH_SIGN_IN_MESSAGE = "Sign in again to change company screens.";
/** Changes a minute, for the whole company. */
export const UI_FLAGS_PER_MINUTE = 10;
const RATE_WINDOW_MS = 60_000;

async function requireFreshBrowserSignIn(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<void> {
  const session = await getSignIn<Pick<SessionRecord, "authTime">>(deps, `SESSION#${caller.sessionId}`);
  if (session === undefined || !isFreshSignIn(session, deps.now())) throw agentXError("REAUTH_REQUIRED", UI_FLAGS_FRESH_SIGN_IN_MESSAGE);
}

async function throttle(deps: DeveloperRouteDependencies, caller: DeveloperCaller): Promise<void> {
  let accepted: boolean;
  try { accepted = await takeRateAt({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, { pk: orgScoped(caller.orgId, "UI_FLAGS_WRITES"), sk: "ALL" }, UI_FLAGS_PER_MINUTE, RATE_WINDOW_MS); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "The change could not be saved. Try again."); }
  if (!accepted) throw agentXError("TOO_MANY_REQUESTS", "Too many changes to company screens. Try again in a minute.");
}

/** The reply, or undefined when the path is not this one. */
export async function routeUiFlags(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, pathname: string, environment: Record<string, string | undefined> = process.env): Promise<unknown> {
  if (pathname !== UI_FLAGS_PATH) return undefined;
  if (request.method !== "GET" && request.method !== "PUT") throw agentXError("NOT_FOUND", "route not found");
  // Defence in depth: the entry file refuses a token before this, and so does this.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", UI_FLAGS_BROWSER_MESSAGE);
  if (caller.orgRole !== "owner" && caller.orgRole !== "admin") throw agentXError("FORBIDDEN", "Only a company owner or admin can see or change company screens.");
  const store = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, audit: deps.audit };
  if (request.method === "GET") return adminAnswerOf(await readUiFlags(store, caller.orgId), operatorForcedOff(environment));
  await requireFreshBrowserSignIn(deps, caller);
  const parsed = UiFlagsBodySchema.safeParse(jsonBody(request));
  // Field names only: the values and any unknown key are the caller's.
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "The change names a screen setting this company does not have, names nothing to change, or has a field this route does not take.");
  await throttle(deps, caller);
  const written = await writeUiFlags(store, { orgId: caller.orgId, developerId: caller.developerId, expectedRevision: parsed.data.expectedRevision, change: { flags: parsed.data.flags, previews: parsed.data.previews } });
  return adminAnswerOf(written, operatorForcedOff(environment));
}
