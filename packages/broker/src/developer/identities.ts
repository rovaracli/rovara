// packages/broker/src/developer/identities.ts
// Plan 2, Task 2: one developer per person, however they sign in. A sign-in identity (a provider's issuer and subject) is linked to a
// developer; a second route to the same verified email is linked to the first route's developer instead of becoming a second member.
import { normalizeEmail, type DeveloperSignInMethod } from "@agentx/contracts";
import { ownerKeyForSubject } from "../aws/lambda.js";
import type { OrgStore } from "../org/store.js";
import type { ProviderIdentity } from "./providers.js";
import type { DeveloperSignInStore } from "./store.js";

export interface ResolveSignInDeveloperDependencies {
  store: DeveloperSignInStore;
  orgs: Pick<OrgStore, "developerForVerifiedEmail" | "orgForDeveloper">;
}

/** `existing`: the identity was already linked. `new-self`: it starts its own developer. `new-linked`: it joined another developer by verified email. */
export type SignInLink = "existing" | "new-self" | "new-linked";

export interface ResolvedSignInDeveloper {
  developerId: string;
  /** The identity's own key, `ownerKeyForSubject(issuer, subject)`: what the session records, for unlinking. */
  identityKey: string;
  link: SignInLink;
}

/**
 * The developer a sign-in belongs to, linking the identity if it is new. In order:
 * 1. The identity has a link item: use it (a pre-plan developer with no link item does not count; see `developerForIdentity`).
 * 2. A cloud or GitHub sign-in with a verified ASCII email, whose own key has no org and was never unlinked, and whose email names
 *    another developer who has an org: link to that developer.
 * 3. Otherwise link the identity to its own key.
 * A concurrent sign-in that linked the identity first wins, and its developer is returned as `existing`.
 */
export async function resolveSignInDeveloper(
  deps: ResolveSignInDeveloperDependencies,
  input: { method: DeveloperSignInMethod; identity: ProviderIdentity },
): Promise<ResolvedSignInDeveloper> {
  const { identity, method } = input;
  const identityKey = ownerKeyForSubject(identity.issuer, identity.subject);
  const existing = await deps.store.getIdentityLink(identityKey);
  if (existing !== undefined) {
    // An unlinked identity (unlinkedFrom set, now pointing elsewhere) is not linked; its own developer link reads as one.
    if (existing.unlinkedFrom === undefined || existing.developerId === identityKey) return { developerId: existing.developerId, identityKey, link: "existing" };
  }

  const target = existing === undefined ? await joinableDeveloper(deps, method, identity, identityKey) : undefined;
  const developerId = target ?? identityKey;
  const linked = await deps.store.linkIdentity({
    identityKey, developerId, provider: method, issuer: identity.issuer, subject: identity.subject,
    ...(identity.email === undefined ? {} : { email: identity.email }),
    ...(identity.login === undefined ? {} : { login: identity.login }),
  });
  if (linked.developerId !== developerId) return { developerId: linked.developerId, identityKey, link: "existing" };
  return { developerId, identityKey, link: linked.created ? (target === undefined ? "new-self" : "new-linked") : "existing" };
}

/** Rule 2: the other developer a verified email names, when this identity may join them. */
async function joinableDeveloper(deps: ResolveSignInDeveloperDependencies, method: DeveloperSignInMethod, identity: ProviderIdentity, identityKey: string): Promise<string | undefined> {
  if (method !== "cloud" && method !== "github") return undefined;
  if (identity.emailVerified !== true || identity.email === undefined || !normalizeEmail(identity.email).ascii) return undefined;
  // Someone who already has an org of their own keeps it: two orgs are never merged by a sign-in.
  if (await deps.orgs.orgForDeveloper(identityKey) !== undefined) return undefined;
  const other = await deps.orgs.developerForVerifiedEmail(identity.email);
  if (other === undefined || other === identityKey) return undefined;
  return await deps.orgs.orgForDeveloper(other) === undefined ? undefined : other;
}
