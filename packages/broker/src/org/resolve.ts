// packages/broker/src/org/resolve.ts
// Multi-tenancy (ruling R1): which org a caller belongs to. The resolver is injected where
// identities and developer callers are built. The default serves a single-org install (ruling R3);
// Task 5 sources the org from the sign-in token, and a test can inject a resolver with two orgs.
import { OrgIdSchema, agentXError, singleOrgIdForEnv, type OrgId } from "@rovara-code/contracts";
import type { OrgStore } from "./store.js";

/** Who is asking: an admin or workspace owner by `ownerKey`, a developer by `developerId`. */
export interface OrgSubject {
  ownerKey?: string;
  developerId?: string;
}

/** The org the subject belongs to, or undefined when it belongs to none (a cloud operator, ruling R6). */
export type OrgResolver = (subject: OrgSubject) => Promise<OrgId | undefined>;

/** Every subject belongs to the one org of a single-org install. */
export function singleOrgResolver(env: string): OrgResolver {
  const orgId = singleOrgIdForEnv(env);
  return async () => orgId;
}

/**
 * Membership decides: a developer (or an owner key, which is the developer's id for a signed-in developer) belongs to the
 * org it joined, and any other subject, such as an operator of the admin pool, belongs to none (ruling R6).
 */
export function membershipOrgResolver(orgs: Pick<OrgStore, "orgForDeveloper">): OrgResolver {
  return async (subject) => {
    const developerId = subject.developerId ?? subject.ownerKey;
    return developerId === undefined ? undefined : (await orgs.orgForDeveloper(developerId))?.orgId;
  };
}

/**
 * The org resolver an install picks for itself: membership-based once the cloud sign-in is configured
 * (DEVELOPER_CLOUD_ISSUER), so operators with no membership get no org (ruling R6); otherwise absent, and
 * the install's single org serves everyone (ruling R3).
 */
export function orgResolverFromEnvironment(env: NodeJS.ProcessEnv, orgs: Pick<OrgStore, "orgForDeveloper">): OrgResolver | undefined {
  return (env.DEVELOPER_CLOUD_ISSUER ?? "") === "" ? undefined : membershipOrgResolver(orgs);
}

/** Ruling R6: an org-scoped route refuses a caller that has no org. */
export function requireOrgId(orgId: OrgId | undefined): OrgId {
  if (orgId === undefined) throw agentXError("FORBIDDEN", "this action needs an organization, and your account does not belong to one");
  return orgId;
}

/**
 * The install's environment name: AGENTX_ENV in a named environment, "default" in the legacy,
 * unnamed one. A Lambda with no broker dependencies reads it once at start-up and derives the
 * install's single org id (`singleOrgIdForEnv`) from it.
 */
export function installEnvironmentName(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.AGENTX_ENV;
  return name === undefined || name === "" ? "default" : name;
}

/**
 * The org a stored row belongs to: the first record that names one (Task 5 stamps `orgId` on records), else
 * `fallback`, the install's single org. Background readers (Lambdas with no caller) use it on the row they read.
 */
export function orgOf(fallback: OrgId, ...records: ReadonlyArray<Record<string, unknown> | undefined>): OrgId {
  for (const candidate of records) {
    const parsed = OrgIdSchema.safeParse(candidate?.orgId);
    if (parsed.success) return parsed.data;
  }
  return fallback;
}

/** The install's single org id (ruling R3), for a Lambda that has no caller and whose records name no org yet. */
export function installOrgIdFromEnvironment(env: NodeJS.ProcessEnv = process.env): OrgId {
  return singleOrgIdForEnv(installEnvironmentName(env));
}

/**
 * The org a Slack team is bound to. A team that no org has bound is refused with SLACK_TEAM_NOT_BOUND:
 * a channel binding is looked up only inside the team's own org, never across orgs.
 */
export async function resolveSlackOrg(orgs: Pick<OrgStore, "orgForSlackTeam">, teamId: string): Promise<OrgId> {
  const orgId = await orgs.orgForSlackTeam(teamId);
  if (orgId === undefined) throw agentXError("SLACK_TEAM_NOT_BOUND", "this Slack workspace is not connected to an organization");
  return orgId;
}

/**
 * `resolveSlackOrg` for a single-org install: the install's own Slack team (its configured SLACK_TEAM_ID)
 * needs no manual binding, so the first time it is seen it is bound to the install's org, which is created
 * if it does not exist yet (ruling R3). Any other unbound team is still refused. An install with its own
 * multi-org resolver passes `installOrg: undefined` and binds teams only through the admin path.
 */
export async function resolveSlackOrgForInstall(
  orgs: Pick<OrgStore, "orgForSlackTeam" | "ensureOrg" | "bindSlackTeam">,
  teamId: string,
  installOrg: { orgId: OrgId; name: string; slackTeamId: string | undefined } | undefined,
): Promise<OrgId> {
  try {
    return await resolveSlackOrg(orgs, teamId);
  } catch (error) {
    if (installOrg === undefined || installOrg.slackTeamId === undefined || installOrg.slackTeamId !== teamId
      || !(error instanceof Error) || (error as { code?: unknown }).code !== "SLACK_TEAM_NOT_BOUND") throw error;
  }
  await orgs.ensureOrg(installOrg.orgId, installOrg.name);
  await orgs.bindSlackTeam({ orgId: installOrg.orgId, teamId });
  return installOrg.orgId;
}
