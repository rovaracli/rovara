// Enterprise foundations I-1: what the edition allows of a sign-in session, checked wherever a session is used (the sign-in server and every broker request), so a session
// that already existed when an install became Enterprise (Slack, cloud, or a company session from before the group mapping) is held to the same rules as a new one.
import type { DeveloperSignInMethod, EditionPolicy } from "@agentx/contracts";

/** Whether the edition allows a sign-in method: where it has no public sign-in methods, only the company's own (`oidc`). */
export function methodAllowedByEdition(policy: EditionPolicy | undefined, method: DeveloperSignInMethod): boolean {
  return policy === undefined || policy.features.publicSignInMethods || method === "oidc";
}

/**
 * Whether a session is still inside the edition's session cap, counted from the moment it started. An edition with a cap (Enterprise: 8 hours) ends EVERY session at
 * the cap, old ones included, so a group removal at the identity provider takes effect within it. A start time that cannot be read is outside the cap.
 */
export function sessionWithinEditionCap(policy: EditionPolicy | undefined, startedAt: string, nowMs: number): boolean {
  if (policy === undefined || policy.sessionMaxSeconds === undefined) return true;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) && nowMs - started <= policy.sessionMaxSeconds * 1000;
}
