import { agentXError } from "@rovara-code/contracts";

/** Conservative policy: every newly listed rule is a widening, including a
 * replacement that might be semantically narrower under wildcard matching. */
export function isAllowedDomainWidening(before: readonly string[], after: readonly string[]): boolean {
 const previous = new Set(before.map(domain => domain.toLowerCase()));
 return after.some(domain => !previous.has(domain.toLowerCase()));
}
export function refuseAllowedDomainWidening(): never {
 throw agentXError("FORBIDDEN", "Widening allowed websites requires the browser proposal flow.");
}
