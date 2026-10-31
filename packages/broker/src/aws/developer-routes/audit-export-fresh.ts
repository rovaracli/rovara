// Enterprise foundations I2/I1 (controller default, pending the owner's answer): starting an audit export needs a sign-in made within the last few minutes (the rule of the other
// high-risk actions, `isFreshSignIn`). An export is the whole log in one file, and the Auditor, who exists to read it, signs in through the company's provider, so a stolen or
// long-running session cannot pull it out unnoticed. Reading records and status, and fetching an export that is ready, do not need it.
import { agentXError } from "@agentx/contracts";
import { isFreshSignIn, type SessionRecord } from "../../developer/store.js";
import { getSignIn } from "./authentication.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const AUDIT_EXPORT_FRESH_SIGN_IN_MESSAGE = "Sign in again to export the audit log.";

/** Whether this request starts an audit export (POST to the exports collection, under either audit prefix). */
export const startsAuditExport = (method: string, pathname: string): boolean => method === "POST" && /^\/v1\/(?:app|dev)\/org\/audit\/exports$/u.test(pathname);

/** Throws REAUTH_REQUIRED unless the caller's session was signed in within the fresh window. A session that cannot be read, or has no readable sign-in time, is not fresh. */
export async function requireFreshSignInForExport(deps: DeveloperRouteDependencies, caller: Pick<DeveloperCaller, "sessionId">): Promise<void> {
  const session = await getSignIn<Pick<SessionRecord, "authTime">>(deps, `SESSION#${caller.sessionId}`);
  if (session === undefined || !isFreshSignIn(session, deps.now())) throw agentXError("REAUTH_REQUIRED", AUDIT_EXPORT_FRESH_SIGN_IN_MESSAGE);
}
