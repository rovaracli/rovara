// packages/broker/src/org/sign-in.ts
// Multi-tenancy: which org a person lands in when they sign in. A developer who already belongs to an
// org keeps it. Otherwise, in order: an invite token joins the org that invited them, a cloud sign-in
// creates an org of its own, and a Slack or company sign-in joins the install's single org (ruling R2)
// as a member. A person's second sign-in route is never a second member: identities.ts links it to the
// first route's developer before this runs, so that developer already has its org. A GitHub sign-in
// (Task 22) is a cloud sign-in route for all of this: it accepts invites and creates an org like `cloud`.
import { agentXError, normalizeEmail, type DeveloperSignInMethod, type OrgId, type OrgRole } from "@agentx/contracts";
import type { OrgStore } from "./store.js";
import { defaultTeamName } from "../developer/person-name.js";

export interface ResolveOrgOnSignInDependencies {
  orgs: Pick<OrgStore, "orgForDeveloper" | "createOrgWithOwner" | "addMember" | "acceptInvite" | "peekInvite" | "ensureOrg" | "isBanned">;
  /** The install's single org (ruling R3); unset in an install that has none. */
  singleOrgId?: OrgId;
  /** The name that single org is created with the first time someone joins it; the environment's name. */
  singleOrgName?: string;
  /**
   * Called after a sign-in created or joined an org (not for a person who already had one), so the model proxy knows the org and
   * the member before the first key names them. Best effort: a failure is logged and never fails the sign-in, and the first key
   * syncs lazily if this did not.
   */
  onOrgJoined?: (input: { orgId: OrgId; developerId: string }) => Promise<void>;
  log?: (entry: Record<string, unknown>) => void;
}

export interface ResolveOrgOnSignInInput {
  method: DeveloperSignInMethod;
  developerId: string;
  displayName: string;
  email?: string;
  /** The provider vouched for `email`. An unverified email is never indexed and never satisfies an invite; a non-ASCII one is never indexed either. */
  emailVerified: boolean;
  /** SHA-256 of the invite token in base64url (inviteTokenHash): a sign-in never holds the token itself. */
  inviteTokenHash?: string;
  /**
   * false: a join. The sign-in may only join the org an invite names; creating an org (a cloud sign-in's own trial org) and joining the
   * install's single org are both skipped, and the result is `{ noOrg: true }`. Absent or true: rules 1 to 4 as always.
   */
  allowCreate?: boolean;
}

export interface SignInOrg {
  orgId: OrgId;
  role: OrgRole;
  /**
   * An invite was presented and not used: the person already belongs to an org (ALREADY_IN_ORG), the invite is written for another email
   * (INVITE_WRONG_EMAIL), or it is unknown, expired, used or into a closed org (INVITE_INVALID).
   */
  inviteError?: "ALREADY_IN_ORG" | "INVITE_INVALID" | "INVITE_WRONG_EMAIL";
}

/** What a join (`allowCreate: false`) answers when the invite did not put the person in an org: they have none, and nothing was created. */
export interface SignInNoOrg {
  noOrg: true;
  orgId?: undefined;
  role?: undefined;
  inviteError?: "INVITE_INVALID" | "INVITE_WRONG_EMAIL";
}

/** What rule 4 says on an install with no single org (a cloud install, ruling R51): a Slack or company sign-in has no org to join there. */
export const NO_ORG_ON_INSTALL_MESSAGE = "Sign in with Rovara on this install: Slack and company sign-ins do not create or join an organization here";
export const REMOVED_FROM_ORG_MESSAGE = "You were removed from this organization. Ask an admin to invite you again.";
const codeOf = (error: unknown) => (error as { code?: unknown }).code;
/** The same address on both sides, and only for ASCII ones: Unicode folding must not make two different addresses equal (U+212A is "k"). */
export const sameEmail = (a: string, b: string) => {
  const [left, right] = [normalizeEmail(a), normalizeEmail(b)];
  return left.ascii && right.ascii && left.email === right.email;
};

/** The org and role this sign-in belongs to, creating or joining one on a first sign-in. A join (`allowCreate: false`) may answer `noOrg` instead. */
export function resolveOrgOnSignIn(deps: ResolveOrgOnSignInDependencies, input: ResolveOrgOnSignInInput & { allowCreate: false }): Promise<SignInOrg | SignInNoOrg>;
export function resolveOrgOnSignIn(deps: ResolveOrgOnSignInDependencies, input: ResolveOrgOnSignInInput & { allowCreate?: true }): Promise<SignInOrg>;
export async function resolveOrgOnSignIn(deps: ResolveOrgOnSignInDependencies, input: ResolveOrgOnSignInInput): Promise<SignInOrg | SignInNoOrg> {
  const { onOrgJoined } = deps;
  if (onOrgJoined === undefined) return resolveOrg(deps, input);
  const hadOrg = await deps.orgs.orgForDeveloper(input.developerId) !== undefined;
  const org = await resolveOrg(deps, input);
  if (!hadOrg && org.orgId !== undefined) {
    try {
      await onOrgJoined({ orgId: org.orgId, developerId: input.developerId });
    } catch (error) {
      (deps.log ?? (() => undefined))({ event: "signin.org_hook_failed", errorName: error instanceof Error ? error.name : "unknown" });
    }
  }
  return org;
}

async function resolveOrg(deps: ResolveOrgOnSignInDependencies, input: ResolveOrgOnSignInInput): Promise<SignInOrg | SignInNoOrg> {
  const { orgs } = deps;
  // The methods that make accounts on a cloud install: "cloud" (Cognito) and "github" behave identically here.
  const cloud = input.method === "cloud" || input.method === "github";
  const verifiedEmail = input.emailVerified ? input.email : undefined;
  // Only an ASCII address is indexed: Unicode folding can map another address onto it (normalizeEmail), and the index key would collide.
  const indexedEmail = verifiedEmail !== undefined && normalizeEmail(verifiedEmail).ascii ? verifiedEmail : undefined;
  const withInviteError = (org: { orgId: OrgId; role: OrgRole }, inviteError: SignInOrg["inviteError"]): SignInOrg =>
    inviteError === undefined ? org : { ...org, inviteError };

  const joinOrg = (orgId: OrgId, role: OrgRole) => orgs.addMember({ orgId, developerId: input.developerId, role });

  /** The membership a concurrent sign-in of the same person created. */
  const winnerOfRace = (): Promise<{ orgId: OrgId; role: OrgRole } | undefined> => orgs.orgForDeveloper(input.developerId);

  /**
   * `attempt` with the email to index. Refused as ALREADY_IN_ORG while this developer has no membership, the email pointer names another
   * developer (the same person's other sign-in route raced this one to it): once more without the pointer, so this sign-in still gets
   * its org and the pointer stays with the first. Merging the two is left to the duplicate healing, not to a sign-in.
   */
  const indexing = async <T>(attempt: (email: string | undefined) => Promise<T>): Promise<T> => {
    try {
      return await attempt(cloud ? indexedEmail : undefined);
    } catch (error) {
      if (!cloud || indexedEmail === undefined || codeOf(error) !== "ALREADY_IN_ORG" || await winnerOfRace() !== undefined) throw error;
      // This can leave one person with two orgs; the line lets the duplicate be found and healed.
      (deps.log ?? (() => undefined))({ event: "signin.email_pointer_conflict", developerId: input.developerId });
      return attempt(undefined);
    }
  };

  const inviteGiven = input.inviteTokenHash !== undefined;

  // Rule 1: a person keeps the org they have.
  const existing = await orgs.orgForDeveloper(input.developerId);
  if (existing !== undefined) return withInviteError(existing, inviteGiven ? "ALREADY_IN_ORG" : undefined);

  // Rule 2: an invite, which an email-targeted invite grants only to that verified email (ruling R7). Written for another address (or
  // for one this sign-in cannot vouch for) is INVITE_WRONG_EMAIL, so the person is told which address to use.
  let inviteError: SignInOrg["inviteError"];
  if (input.inviteTokenHash !== undefined) {
    const invite = await orgs.peekInvite(input.inviteTokenHash);
    if (invite === undefined) {
      inviteError = "INVITE_INVALID";
    } else if (invite.email !== undefined && (verifiedEmail === undefined || !sameEmail(invite.email, verifiedEmail))) {
      inviteError = "INVITE_WRONG_EMAIL";
    } else {
      try {
        const tokenHash = input.inviteTokenHash;
        // The email is indexed only for the cloud methods, whose sign-in routes it links.
        return await indexing((email) => orgs.acceptInvite({ tokenHash, developerId: input.developerId, ...(email === undefined ? {} : { email }) }));
      } catch (error) {
        if (codeOf(error) === "INVITE_INVALID") inviteError = "INVITE_INVALID";
        else if (codeOf(error) === "ALREADY_IN_ORG") {
          const winner = await winnerOfRace();
          if (winner === undefined) throw error;
          return withInviteError(winner, "ALREADY_IN_ORG");
        } else throw error;
      }
    }
  }

  // A join never creates anything: no org of its own, no seat in the install's single org. The person stays as they were.
  if (input.allowCreate === false) {
    return { noOrg: true, ...(inviteError === undefined || inviteError === "ALREADY_IN_ORG" ? { inviteError: "INVITE_INVALID" as const } : { inviteError }) };
  }

  // Rule 3: a cloud sign-in with nowhere to go starts an org of its own.
  if (cloud) {
    try {
      const orgId = await indexing((email) => orgs.createOrgWithOwner({
        name: defaultTeamName(input.displayName, input.developerId), developerId: input.developerId, ...(email === undefined ? {} : { email }),
      }));
      return withInviteError({ orgId, role: "owner" }, inviteError);
    } catch (error) {
      if (codeOf(error) !== "ALREADY_IN_ORG") throw error;
      // The same person signed in twice at once, or by two routes: the other sign-in's membership stands.
      const winner = await winnerOfRace();
      if (winner === undefined) throw error;
      return withInviteError(winner, inviteError);
    }
  }

  // Rule 4: a Slack or company sign-in joins the install's single org.
  if (deps.singleOrgId === undefined) throw agentXError("CONFIG_INVALID", NO_ORG_ON_INSTALL_MESSAGE);
  // Removed from this install's org with a ban: not back by signing in again. An invite (above) still works and clears the ban.
  if (await orgs.isBanned(deps.singleOrgId, input.developerId)) throw agentXError("REMOVED_FROM_ORG", REMOVED_FROM_ORG_MESSAGE);
  // No email pointer here: the email index links one person's cloud identities, and a Slack or company
  // sign-in joins by identity alone.
  await orgs.ensureOrg(deps.singleOrgId, deps.singleOrgName ?? "default");
  try {
    await joinOrg(deps.singleOrgId, "member");
  } catch (error) {
    if (codeOf(error) !== "ALREADY_IN_ORG") throw error;
    // The same person signed in twice at once: the other sign-in's membership stands.
    const winner = await orgs.orgForDeveloper(input.developerId);
    if (winner === undefined) throw error;
    return withInviteError(winner, inviteError);
  }
  return withInviteError({ orgId: deps.singleOrgId, role: "member" }, inviteError);
}
