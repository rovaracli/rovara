// packages/broker/src/org/sign-in.ts
// Multi-tenancy: which org a person lands in when they sign in. A developer who already belongs to an
// org keeps it. Otherwise, in order: a cloud sign-in whose verified email is already linked to another
// developer joins that developer's org (one person, two sign-in routes), an invite token joins the
// org that invited them, a cloud sign-in creates an org of its own, and a Slack or company sign-in
// joins the install's single org (ruling R2) as a member.
import { agentXError, type DeveloperSignInMethod, type OrgId, type OrgRole } from "@agentx/contracts";
import type { OrgStore } from "./store.js";

export interface ResolveOrgOnSignInDependencies {
  orgs: Pick<OrgStore, "orgForDeveloper" | "developerForVerifiedEmail" | "createOrgWithOwner" | "addMember" | "acceptInvite" | "peekInvite" | "ensureOrg">;
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
  /** The provider vouched for `email`. An unverified email never links two sign-ins, is never indexed and never satisfies an invite. */
  emailVerified: boolean;
  inviteToken?: string;
}

export interface SignInOrg {
  orgId: OrgId;
  role: OrgRole;
  /** An invite was presented and not used: the person already belongs to an org, or the invite is unknown, expired, used or written for another email. */
  inviteError?: "ALREADY_IN_ORG" | "INVITE_INVALID";
}

const codeOf = (error: unknown) => (error as { code?: unknown }).code;
const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The org and role this sign-in belongs to, creating or joining one on a first sign-in. */
export async function resolveOrgOnSignIn(deps: ResolveOrgOnSignInDependencies, input: ResolveOrgOnSignInInput): Promise<SignInOrg> {
  const { onOrgJoined } = deps;
  if (onOrgJoined === undefined) return resolveOrg(deps, input);
  const hadOrg = await deps.orgs.orgForDeveloper(input.developerId) !== undefined;
  const org = await resolveOrg(deps, input);
  if (!hadOrg) {
    try {
      await onOrgJoined({ orgId: org.orgId, developerId: input.developerId });
    } catch (error) {
      (deps.log ?? (() => undefined))({ event: "signin.org_hook_failed", errorName: error instanceof Error ? error.name : "unknown" });
    }
  }
  return org;
}

async function resolveOrg(deps: ResolveOrgOnSignInDependencies, input: ResolveOrgOnSignInInput): Promise<SignInOrg> {
  const { orgs } = deps;
  const cloud = input.method === "cloud";
  const verifiedEmail = input.emailVerified ? input.email : undefined;
  const withInviteError = (org: { orgId: OrgId; role: OrgRole }, inviteError: SignInOrg["inviteError"]): SignInOrg =>
    inviteError === undefined ? org : { ...org, inviteError };

  const joinOrg = (orgId: OrgId, role: OrgRole) => orgs.addMember({ orgId, developerId: input.developerId, role });

  /** Rule 2: the org of another developer who signed in with the same verified email. */
  const linkByEmail = async (): Promise<{ orgId: OrgId; role: OrgRole } | undefined> => {
    if (!cloud || verifiedEmail === undefined) return undefined;
    const linked = await orgs.developerForVerifiedEmail(verifiedEmail);
    if (linked === undefined || linked === input.developerId) return undefined;
    const membership = await orgs.orgForDeveloper(linked);
    if (membership === undefined) return undefined;
    // No email here: the pointer already names the first sign-in route, and it stays there.
    await joinOrg(membership.orgId, membership.role);
    return membership;
  };

  /** The membership a concurrent sign-in of the same person created, or the org their email links them to. */
  const winnerOfRace = async (): Promise<{ orgId: OrgId; role: OrgRole } | undefined> =>
    (await orgs.orgForDeveloper(input.developerId)) ?? linkByEmail();

  const inviteGiven = input.inviteToken !== undefined;

  // Rule 1: a person keeps the org they have.
  const existing = await orgs.orgForDeveloper(input.developerId);
  if (existing !== undefined) return withInviteError(existing, inviteGiven ? "ALREADY_IN_ORG" : undefined);

  // Rule 2: the same person by another cloud sign-in route.
  try {
    const linked = await linkByEmail();
    if (linked !== undefined) return withInviteError(linked, inviteGiven ? "ALREADY_IN_ORG" : undefined);
  } catch (error) {
    if (codeOf(error) !== "ALREADY_IN_ORG") throw error;
    const winner = await orgs.orgForDeveloper(input.developerId);
    if (winner === undefined) throw error;
    return withInviteError(winner, inviteGiven ? "ALREADY_IN_ORG" : undefined);
  }

  // Rule 3: an invite, which an email-targeted invite grants only to that verified email (ruling R7).
  let inviteError: SignInOrg["inviteError"];
  if (input.inviteToken !== undefined) {
    const invite = await orgs.peekInvite(input.inviteToken);
    if (invite === undefined || (invite.email !== undefined && (verifiedEmail === undefined || !sameEmail(invite.email, verifiedEmail)))) {
      inviteError = "INVITE_INVALID";
    } else {
      try {
        return await orgs.acceptInvite({
          token: input.inviteToken, developerId: input.developerId,
          // Index the email only for the cloud method, which is what links its sign-in routes.
          ...(cloud && verifiedEmail !== undefined ? { email: verifiedEmail } : {}),
        });
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

  // Rule 4: a cloud sign-in with nowhere to go starts an org of its own.
  if (cloud) {
    try {
      const orgId = await orgs.createOrgWithOwner({
        name: `${input.displayName}'s team`, developerId: input.developerId, ...(verifiedEmail === undefined ? {} : { email: verifiedEmail }),
      });
      return withInviteError({ orgId, role: "owner" }, inviteError);
    } catch (error) {
      if (codeOf(error) !== "ALREADY_IN_ORG") throw error;
      // The same person signed in twice at once, or by two routes: the other sign-in's membership stands.
      const winner = await winnerOfRace();
      if (winner === undefined) throw error;
      return withInviteError(winner, inviteError);
    }
  }

  // Rule 5: a Slack or company sign-in joins the install's single org.
  if (deps.singleOrgId === undefined) throw agentXError("CONFIG_INVALID", "this environment has no organization for new sign-ins to join");
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
