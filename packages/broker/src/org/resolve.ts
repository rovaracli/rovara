// packages/broker/src/org/resolve.ts
// Multi-tenancy (ruling R1): which org a caller belongs to. The resolver is injected where
// identities and developer callers are built. The default serves a single-org install (ruling R3);
// Task 5 sources the org from the sign-in token, and a test can inject a resolver with two orgs.
import { OrgIdSchema, agentXError, singleOrgIdForEnv, type OrgId } from "@agentx/contracts";

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
