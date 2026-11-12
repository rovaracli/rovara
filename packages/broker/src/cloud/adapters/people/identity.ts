// Convergence A6 (`cloud/people`): Cloud's IdentityProvider on Code's port (`@rovara-code/contracts` ports/policy.ts). A wrapper, not a second copy: every answer comes from the functions Cloud's routes use
// today, so a person the routes refuse is refused here too.
//   authenticate      a developer token (`authenticateDeveloper`) or the browser's review session id (`authenticateDeveloperSessionId`, plus the method switch `authenticateWebRequest` applies). The session's live checks
//                     all run: revoked, ended by an admin, unlinked method, the edition's methods and cap, a SAML cutoff, the person's company NOW and its role NOW (a demotion applies at once), the Auditor only on an
//                     edition that has it. The web boundary's Origin and CSRF checks stay with the HTTP surface: this answers WHO, never "this came from Rovara's page".
//   getPrincipal      the person's live membership in THAT company (`orgForDeveloper`, the pointer every request reads) and their sign-in record (not revoked); an Auditor only on an edition that has the role.
//   resolveExternalAccount / accountsOf   a Slack user, by the verified Slack sign-in link the approval-place rule uses (`developerOfSlackUser`), then the company check above. Cross-company is nobody.
//   listMembers       the company's member records (`OrgStore.listMembers`), each read through `getPrincipal`, oldest first (the directory's order).
// `Principal.provider` is the sign-in method (`slack`, `oidc`, `cloud`, `github`, `saml`): Cloud's existing closed names (convergence plan D6). `authTime` is the person's last INTERACTIVE Rovara sign-in by email code
// or company sign-in (`lastInteractiveSignInAt`, the approval-place rule's "recent"), never a Slack or GitHub sign-in and never a refresh.
// Not offered: interactive sign-in (`beginSignIn`/`completeSignIn`/`signOut`). Cloud's sign-in pages run in the separate developer sign-in service, which alone may write the sign-in table (R13); the broker reads it.
// `companySignIn` is false: Cloud has no "trust any active company sign-in" setting today, so declaring it would only open a choice Cloud does not have.
import type { AuthResult, ExternalAccountRef, IdentityMemberPage, IdentityProvider, PresentedCredential, Principal } from "@rovara-code/contracts";
import { AgentXError, OrgIdSchema } from "@rovara-code/contracts";
import { OrgRoleSchema } from "@agentx/cloud-contracts";
import { authenticateDeveloper, authenticateDeveloperSessionId } from "../../../aws/developer-routes/authentication.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "../../../aws/developer-routes/types.js";
import { RECENT_SIGN_IN_METHODS } from "../../../approval-place/evaluate.js";
import { DeveloperSignInStore } from "../../../developer/store.js";
import { safeDisplayName } from "../../../developer/person-name.js";
import { auditorAllowedByEdition } from "../../../org/auditor.js";
import { BEARER_SCHEME, BROWSER_SESSION_SCHEME, SLACK_ACCOUNT_PROVIDER } from "./methods.js";

/** What the adapter reads: the broker's route dependencies (the sign-in table, the State table, the org store, the developer token verifier, the edition). */
export type CloudPeopleDependencies = DeveloperRouteDependencies;

const PERSON_ID = /^[a-f0-9]{64}$/u;
const MEMBERS_PAGE_MAX = 100;

export const signInStoreFor = (deps: CloudPeopleDependencies): DeveloperSignInStore =>
  new DeveloperSignInStore({ documentClient: deps.documentClient, tableName: deps.developer.signInTableName, nameTableName: deps.tableName, now: deps.now });

/** The Principal of a caller the routes authenticated, with the person's last interactive Rovara sign-in. */
export async function principalOfCaller(deps: CloudPeopleDependencies, caller: DeveloperCaller): Promise<Principal> {
  const authTime = await signInStoreFor(deps).lastInteractiveSignInAt(caller.developerId, RECENT_SIGN_IN_METHODS);
  return {
    companyId: caller.orgId, personId: caller.developerId, displayName: caller.name, roles: [caller.orgRole], provider: caller.amr, methods: [caller.amr],
    ...(authTime === undefined ? {} : { authTime }),
  };
}

/** A refusal from the routes' checks, as the port's reason. Anything that is not a refusal (a store that cannot be read) is thrown: the caller fails closed and says to try again. */
function refusalOf(error: unknown): AuthResult {
  if (error instanceof AgentXError) return { ok: false, reason: error.code === "AUTH_REQUIRED" || error.code === "REAUTH_REQUIRED" ? "expired" : "refused" };
  throw error;
}

/** Who a credential names, as the routes decide it, or a refusal. */
export async function authenticateCloudCredential(deps: CloudPeopleDependencies, credential: PresentedCredential): Promise<DeveloperCaller | AuthResult> {
  if (typeof credential.value !== "string" || credential.value === "") return { ok: false, reason: "unknown" };
  if (credential.scheme === BEARER_SCHEME) {
    let claims: Record<string, unknown>;
    // A token the verifier does not accept (a bad signature, another issuer, garbage) is unknown, whatever the verifier throws.
    try { claims = await deps.developer.verifyAccessToken(`Bearer ${credential.value}`); } catch { return { ok: false, reason: "unknown" }; }
    try { return await authenticateDeveloper(deps, claims); } catch (error) { return refusalOf(error); }
  }
  if (credential.scheme === BROWSER_SESSION_SCHEME) {
    let caller: DeveloperCaller;
    try { caller = await authenticateDeveloperSessionId(deps, credential.value); } catch (error) { return refusalOf(error); }
    // The browser boundary's own rule (`authenticateWebRequest`): a session whose method is turned off now is signed out.
    if (deps.developer.methods[caller.amr] !== true) return { ok: false, reason: "expired" };
    return caller;
  }
  return { ok: false, reason: "unknown" };
}

export function createCloudIdentityProvider(deps: CloudPeopleDependencies): IdentityProvider {
  const store = (): DeveloperSignInStore => signInStoreFor(deps);

  async function getPrincipal(companyId: string, personId: string): Promise<Principal | undefined> {
    if (!OrgIdSchema.safeParse(companyId).success || !PERSON_ID.test(personId) || deps.orgs === undefined) return undefined;
    const membership = await deps.orgs.orgForDeveloper(personId);
    if (membership === undefined || membership.orgId !== companyId) return undefined;
    const role = OrgRoleSchema.safeParse(membership.role);
    if (!role.success) return undefined;
    if (role.data === "auditor" && !auditorAllowedByEdition(deps.editionPolicy)) return undefined;
    const signIn = store();
    const record = await signIn.getDeveloper(personId);
    if (record === undefined || record.revoked || record.mergedInto !== undefined) return undefined;
    const authTime = await signIn.lastInteractiveSignInAt(personId, RECENT_SIGN_IN_METHODS);
    return {
      companyId, personId, displayName: safeDisplayName(record.displayName, personId), roles: [role.data], provider: record.provider,
      ...(authTime === undefined ? {} : { authTime }),
    };
  }

  /** The person a Slack account is linked to by a verified Slack sign-in (the approval-place rule's "linked"), in this company. */
  async function slackPerson(companyId: string, slackUserId: string): Promise<Principal | undefined> {
    const developerId = await store().developerOfSlackUser(slackUserId);
    return developerId === undefined ? undefined : getPrincipal(companyId, developerId);
  }

  return {
    capabilities: { interactiveSignIn: false, externalAccounts: true, members: true, companySignIn: false },

    async authenticate(credential) {
      const answer = await authenticateCloudCredential(deps, credential);
      if ("ok" in answer) return answer;
      return { ok: true, principal: await principalOfCaller(deps, answer) };
    },

    getPrincipal,

    async resolveExternalAccount(companyId, account) {
      if (account.provider !== SLACK_ACCOUNT_PROVIDER) return undefined;
      return slackPerson(companyId, account.accountId);
    },

    async accountsOf(companyId, personId): Promise<readonly ExternalAccountRef[]> {
      if (await getPrincipal(companyId, personId) === undefined) return [];
      const record = await store().getDeveloper(personId);
      const slackUserId = record?.slackUserId;
      // Only an account that resolves back to this very person (the link is verified and still theirs): the other way round from `resolveExternalAccount`, never wider.
      if (slackUserId === undefined || (await store().developerOfSlackUser(slackUserId)) !== personId) return [];
      return [{ provider: SLACK_ACCOUNT_PROVIDER, tenant: deps.developer.slackTeamId ?? "", accountId: slackUserId }];
    },

    async listMembers(companyId, page = {}): Promise<IdentityMemberPage> {
      if (!OrgIdSchema.safeParse(companyId).success || deps.orgs === undefined) return { members: [] };
      const records = [...await deps.orgs.listMembers(companyId as never)]
        .filter((member) => member.orgId === companyId)
        .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.developerId.localeCompare(b.developerId));
      const start = page.cursor === undefined ? 0 : Number.parseInt(page.cursor, 10);
      if (!Number.isSafeInteger(start) || start < 0) return { members: [] };
      const limit = Math.min(Math.max(1, page.limit ?? MEMBERS_PAGE_MAX), MEMBERS_PAGE_MAX);
      const slice = records.slice(start, start + limit);
      const members = (await Promise.all(slice.map((member) => getPrincipal(companyId, member.developerId)))).filter((member): member is Principal => member !== undefined);
      return { members, ...(start + limit < records.length ? { nextCursor: String(start + limit) } : {}) };
    },
  };
}
