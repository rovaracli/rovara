// packages/broker/src/org/sign-in.ts
// Multi-tenancy (ruling R2): which org a person lands in when they sign in. A developer who already
// belongs to an org keeps it (rule 1); a Slack or company sign-in joins the install's single org as a
// member (rule 5). Task 6 adds the cloud method and the rules between these two.
import { agentXError, type DeveloperSignInMethod, type OrgId, type OrgRole } from "@agentx/contracts";
import type { OrgStore } from "./store.js";

export interface ResolveOrgOnSignInDependencies {
  orgs: Pick<OrgStore, "orgForDeveloper" | "ensureOrg" | "addMember">;
  /** The install's single org (ruling R3); unset in an install that has none. */
  singleOrgId?: OrgId;
  /** The name that single org is created with the first time someone joins it; the environment's name. */
  singleOrgName?: string;
}

export interface ResolveOrgOnSignInInput {
  method: DeveloperSignInMethod;
  developerId: string;
  displayName: string;
  email?: string;
  emailVerified: boolean;
  inviteToken?: string;
}

export interface SignInOrg {
  orgId: OrgId;
  role: OrgRole;
  inviteError?: "ALREADY_IN_ORG" | "INVITE_INVALID";
}

/** The org and role this sign-in belongs to, joining the install's single org on a first sign-in. */
export async function resolveOrgOnSignIn(deps: ResolveOrgOnSignInDependencies, input: ResolveOrgOnSignInInput): Promise<SignInOrg> {
  const existing = await deps.orgs.orgForDeveloper(input.developerId);
  if (existing !== undefined) return existing;
  if (deps.singleOrgId === undefined) throw agentXError("CONFIG_INVALID", "this environment has no organization for new sign-ins to join");
  // No email pointer here: the email index links one person's cloud identities (Task 6), and a Slack or company
  // sign-in joins by identity alone.
  await deps.orgs.ensureOrg(deps.singleOrgId, deps.singleOrgName ?? "default");
  try {
    await deps.orgs.addMember({ orgId: deps.singleOrgId, developerId: input.developerId, role: "member" });
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ALREADY_IN_ORG") throw error;
    // The same person signed in twice at once: the other sign-in's membership stands.
    const winner = await deps.orgs.orgForDeveloper(input.developerId);
    if (winner === undefined) throw error;
    return winner;
  }
  return { orgId: deps.singleOrgId, role: "member" };
}
