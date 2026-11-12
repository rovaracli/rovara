// packages/broker/src/developer/identities.ts
// Plan 2, Task 2: one developer per person, however they sign in. A sign-in identity (a provider's issuer and subject) is linked to a
// developer; a second route to the same verified email is linked to the first route's developer instead of becoming a second member.
import { normalizeEmail } from "@rovara-code/contracts";
import { type DeveloperSignInMethod } from "@agentx/cloud-contracts";
import { ownerKeyForSubject } from "../aws/lambda.js";
import type { MergeDuplicateMemberInput, MergeDuplicateMemberResult } from "../org/merge-members.js";
import type { OrgStore } from "../org/store.js";
import type { ProviderIdentity } from "./providers.js";
import type { DeveloperSignInStore } from "./store.js";

export interface ResolveSignInDeveloperDependencies {
  store: DeveloperSignInStore;
  orgs: Pick<OrgStore, "developerForVerifiedEmail" | "orgForDeveloper">;
  /** Rule 1b: merges a duplicate member into the member its email names (mergeDuplicateMember, bound to its tables). Without it a duplicate is not healed. */
  mergeDuplicate?: (input: MergeDuplicateMemberInput) => Promise<MergeDuplicateMemberResult>;
  log?: (entry: Record<string, unknown>) => void;
}

/** Why rule 1b left a duplicate in another company alone: healing only ever acts within one company. */
export const CROSS_COMPANY_REASON = "the other member is in a different company; sign-ins are never merged across companies";

/** `existing`: the identity was already linked. `new-self`: it starts its own developer. `new-linked`: it joined another developer by verified email. */
export type SignInLink = "existing" | "new-self" | "new-linked";

export interface ResolvedSignInDeveloper {
  developerId: string;
  /** The identity's own key, `ownerKeyForSubject(issuer, subject)`: what the session records, for unlinking. */
  identityKey: string;
  link: SignInLink;
  /** The developer this identity was removed from (its link's `unlinkedFrom`), when it now signs in as its own developer. */
  separatedFrom?: string;
}

/**
 * The developer a sign-in belongs to, linking the identity if it is new. In order:
 * 1. The identity has a link item: use it (a pre-plan developer with no link item does not count; see `developerForIdentity`).
 * 1b. Before rule 1 answers for an identity that is its own developer (no link item, or a link to itself that was never unlinked),
 *    and that developer belongs to org O: when this is a cloud or GitHub sign-in with a verified ASCII email whose pointer names another
 *    developer who is not revoked or merged, the two are one person who became two members. If the other developer is in O too, the
 *    duplicate is merged into them and the sign-in resolves to the other developer. Healing never crosses companies (IDENTITY-HEALING-
 *    CROSS-ORG, 0.5.15): when the other developer is in a different org, nothing is merged and no org is closed, whatever either org
 *    holds; `signin.duplicate_other_org` records it and the sign-in goes on as itself. One person may hold two companies on purpose
 *    (programme T), so a shared email is never proof that a second company is a leftover; routes are joined only by the link flow.
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
    if (existing.unlinkedFrom === undefined || existing.developerId === identityKey) {
      // Its own developer, never unlinked: it may be a duplicate of the person's first member (rule 1b).
      if (existing.developerId === identityKey && existing.unlinkedFrom === undefined) {
        const survivor = await healDuplicate(deps, method, identity, identityKey);
        if (survivor !== undefined) return { developerId: survivor, identityKey, link: "new-linked" };
      }
      return { developerId: existing.developerId, identityKey, link: "existing", ...(existing.unlinkedFrom === undefined ? {} : { separatedFrom: existing.unlinkedFrom }) };
    }
  } else {
    const survivor = await healDuplicate(deps, method, identity, identityKey);
    if (survivor !== undefined) return { developerId: survivor, identityKey, link: "new-linked" };
  }

  const target = existing === undefined ? await joinableDeveloper(deps, method, identity, identityKey) : undefined;
  const developerId = target ?? identityKey;
  const linked = await deps.store.linkIdentity({
    identityKey, developerId, provider: method, issuer: identity.issuer, subject: identity.subject,
    ...(identity.email === undefined ? {} : { email: identity.email }),
    ...(identity.login === undefined ? {} : { login: identity.login }),
  });
  if (linked.developerId !== developerId) return { developerId: linked.developerId, identityKey, link: "existing" };
  // A removed identity (a tombstone pointing at the developer it left) links to its own key here: it was separated on purpose.
  const separated = existing?.unlinkedFrom !== undefined && developerId === identityKey ? { separatedFrom: existing.unlinkedFrom } : {};
  return { developerId, identityKey, link: linked.created ? (target === undefined ? "new-self" : "new-linked") : "existing", ...separated };
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

/**
 * Rule 1b: the survivor a duplicate member was merged into, or undefined when this sign-in is not a duplicate of anyone. A developer an
 * admin revoked is not merged, so a revoked sign-in cannot come back as the person's other, unrevoked member; nor is anyone merged into a
 * developer who is revoked or was merged away. The cheap check is first: most sign-ins are their email's own member and stop there.
 */
async function healDuplicate(deps: ResolveSignInDeveloperDependencies, method: DeveloperSignInMethod, identity: ProviderIdentity, identityKey: string): Promise<string | undefined> {
  if (deps.mergeDuplicate === undefined || (method !== "cloud" && method !== "github")) return undefined;
  if (identity.emailVerified !== true || identity.email === undefined || !normalizeEmail(identity.email).ascii) return undefined;
  const survivorId = await deps.orgs.developerForVerifiedEmail(identity.email);
  if (survivorId === undefined || survivorId === identityKey) return undefined;
  const record = await deps.store.getDeveloper(identityKey);
  if (record === undefined || record.revoked || record.mergedInto !== undefined || ownerKeyForSubject(record.issuer, record.subject) !== identityKey) return undefined;
  const own = await deps.orgs.orgForDeveloper(identityKey);
  if (own === undefined) return undefined;
  const other = await deps.orgs.orgForDeveloper(survivorId);
  if (other === undefined) return undefined;
  const survivorRecord = await deps.store.getDeveloper(survivorId);
  if (survivorRecord === undefined || survivorRecord.revoked || survivorRecord.mergedInto !== undefined) return undefined;
  if (other.orgId !== own.orgId) {
    // Two companies: never merged and never closed by a sign-in (IDENTITY-HEALING-CROSS-ORG). The survivor's company is not touched either.
    deps.log?.({ event: "signin.duplicate_other_org", developerId: identityKey, orgId: own.orgId, otherDeveloperId: survivorId, otherOrgId: other.orgId, reason: CROSS_COMPANY_REASON });
    return undefined;
  }
  const merged = await deps.mergeDuplicate({
    orgId: own.orgId, survivorId, duplicateId: identityKey, duplicateIdentityKey: identityKey,
    identity: { email: identity.email, ...(identity.login === undefined ? {} : { login: identity.login }) },
  });
  deps.log?.({ event: "signin.duplicate_merged", developerId: identityKey, survivorId, orgId: own.orgId, grantsMoved: merged.grantsMoved, overrideMoved: merged.overrideMoved });
  return survivorId;
}
