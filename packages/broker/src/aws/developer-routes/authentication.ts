import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { DEVELOPER_TOKEN_AUDIENCE, agentXError, singleOrgIdForEnv, type DeveloperSignInMethod, type OrgId, type OrgRole, OrgIdSchema, OrgRoleSchema } from "@agentx/contracts";
import { methodAllowedByEdition, sessionWithinEditionCap } from "../../developer/edition-methods.js";
import { safeDisplayName } from "../../developer/person-name.js";
import { requireAuditorEdition } from "../../org/auditor.js";
import { readChosenName } from "../../developer/chosen-name.js";
import {
  META,
  endedByAdmin,
  endedByUnlink,
  samlSessionEnded,
  startedBeforeMethodOn,
  type DeveloperMarks,
  type DeveloperRecord,
  type SessionRecord,
} from "../../developer/store.js";
import type { DeveloperApiConfiguration, DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

const SIGN_IN_AGAIN = "your AgentX sign-in has ended; run agentx login <url> again";

/** What a verified developer token names: who, which sign-in, and the org and role the token was issued for. */
export interface DeveloperTokenClaims { developerId: string; sessionId: string; amr: DeveloperSignInMethod; orgId: OrgId; orgRole: OrgRole }

export function developerClaims(claims: Record<string, unknown> | undefined, config: DeveloperApiConfiguration): DeveloperTokenClaims {
  if (claims === undefined || (claims.iss !== config.issuer && (config.previousIssuer === undefined || claims.iss !== config.previousIssuer)) || claims.aud !== DEVELOPER_TOKEN_AUDIENCE || claims.env !== config.env) {
    throw agentXError("AUTH_REQUIRED", "this route needs an AgentX developer sign-in; run agentx login <url>");
  }
  if (typeof claims.sub !== "string" || !/^[a-f0-9]{64}$/.test(claims.sub) || typeof claims.sid !== "string" || claims.sid === "") {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  const amr = claims.amr;
  if (amr !== "slack" && amr !== "oidc" && amr !== "cloud" && amr !== "github" && amr !== "saml") throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (config.methods[amr] !== true) {
    throw agentXError("AUTH_REQUIRED", `${amr === "slack" ? "Slack" : amr === "cloud" ? "Cloud" : amr === "github" ? "GitHub" : amr === "saml" ? "SAML" : "Company"} sign-in is turned off in this environment; sign in another way with agentx login <url>`);
  }
  // A token with no org (one issued before orgs, or forged) is refused like a token with no session: sign in again.
  const orgId = OrgIdSchema.safeParse(claims.org);
  const orgRole = OrgRoleSchema.safeParse(claims.org_role);
  if (!orgId.success || !orgRole.success) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  return { developerId: claims.sub, sessionId: claims.sid, amr, orgId: orgId.data, orgRole: orgRole.data };
}

export async function getSignIn<T>(deps: DeveloperRouteDependencies, pk: string): Promise<T | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.developer.signInTableName, Key: { pk, sk: META }, ConsistentRead: true })) as { Item?: T };
  return response.Item;
}

export async function authenticateDeveloper(deps: DeveloperRouteDependencies, claims: Record<string, unknown> | undefined): Promise<DeveloperCaller> {
  const token = developerClaims(claims, deps.developer);
  return authenticateSession(deps, token);
}

/**
 * Plan 3, Task 21a-presence: who a bearer token names, for the confirmation machinery (it refuses a token but mints a ticket for its member).
 * The same checks as every developer route: the token, its live session, the method, and the org membership now.
 */
export async function authenticateBearer(deps: DeveloperRouteDependencies, authorization: string): Promise<{ developerId: string; orgId: OrgId }> {
  const caller = await authenticateDeveloper(deps, await deps.developer.verifyAccessToken(authorization));
  return { developerId: caller.developerId, orgId: caller.orgId };
}

/** A session's identity; `orgId` is present when a token named the org it was issued for, which must still be the developer's. */
export async function authenticateSession(deps: DeveloperRouteDependencies, token: { developerId: string; sessionId: string; amr: DeveloperSignInMethod; orgId?: OrgId }): Promise<DeveloperCaller> {
  const session = await getSignIn<Pick<SessionRecord, "developerId" | "amr" | "endsAt" | "revokedAt" | "startedAt" | "authTime" | "slackUserId" | "identityKey">>(deps, `SESSION#${token.sessionId}`);
  if (session === undefined || session.developerId !== token.developerId || session.revokedAt !== undefined || session.endsAt <= Math.floor(deps.now() / 1000)) {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  if (session.amr !== token.amr) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  // The edition's rules hold for a session that already existed when the install became Enterprise: a method the edition does not offer (Slack, cloud, GitHub) is
  // refused at every request, and no session outlasts the edition's cap.
  if (!methodAllowedByEdition(deps.editionPolicy, session.amr) || !sessionWithinEditionCap(deps.editionPolicy, session.startedAt, deps.now())) {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  // The broker may only read the sign-in table (R13), so it refuses; the token endpoint revokes the
  // session at its next refresh.
  if (startedBeforeMethodOn(session.startedAt, deps.developer.since?.[token.amr])) {
    throw agentXError("AUTH_REQUIRED", `your sign-in ended when ${token.amr === "slack" ? "Slack" : token.amr === "cloud" ? "cloud sign-in" : token.amr === "github" ? "GitHub sign-in" : "company sign-in"} was turned off; sign in again with agentx login <url>`);
  }
  // SAML is turned off, and its certificate rotated, by the saved settings (not the environment): their cutoff ends the sessions that started before it (Enterprise foundations I4, review S3).
  // Settings that cannot be read, or none, end the session: a SAML session with nothing to stand on is not kept.
  if (session.amr === "saml") {
    let validFrom = Number.MAX_SAFE_INTEGER;
    try {
      validFrom = (await deps.sso?.saml.config.get(singleOrgIdForEnv(deps.developer.env)))?.sessionsValidFrom ?? validFrom;
    } catch {
      validFrom = Number.MAX_SAFE_INTEGER;
    }
    if (samlSessionEnded(session, validFrom)) throw agentXError("AUTH_REQUIRED", "your sign-in ended when SAML single sign-on was changed; sign in again");
  }
  // Release 0.4.18: the name the person chose is an item in the State table, read with their sign-in record.
  const [developer, chosenName] = await Promise.all([
    getSignIn<Pick<DeveloperRecord, "displayName" | "displayNameChosen" | "slackUserId" | "email" | "revoked" | "sessionsEndedAt"> & DeveloperMarks>(deps, `DEVELOPER#${token.developerId}`),
    readChosenName(deps.documentClient, deps.tableName, token.developerId),
  ]);
  if (developer === undefined || developer.revoked) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  if (endedByAdmin(session.startedAt, developer.sessionsEndedAt)) {
    // E9: D16's per-request check ends the session at once; the token endpoint revokes it at its next refresh.
    throw agentXError("AUTH_REQUIRED", "an AgentX admin ended your sign-in; run agentx login <url> again");
  }
  // Plan 2, Task 8: the person removed this session's sign-in method from their account (the others' sessions go on).
  if (endedByUnlink(session, developer)) {
    throw agentXError("AUTH_REQUIRED", "this sign-in method was removed from your account; run agentx login <url> again");
  }
  // The org is the developer's membership now: a person removed from the org, or moved to another, is refused even
  // while their token is still valid. The role is the current one, so a demotion applies at once.
  const membership = await deps.orgs?.orgForDeveloper(token.developerId);
  if (membership === undefined || (token.orgId !== undefined && membership.orgId !== token.orgId)) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  // I2: the Auditor is an Enterprise role. A membership that holds it where the edition does not (or is not known) is refused, not treated as a member.
  if (membership.role === "auditor") requireAuditorEdition(deps.editionPolicy);
  return {
    developerId: token.developerId,
    sessionId: token.sessionId,
    amr: token.amr,
    orgId: membership.orgId,
    orgRole: membership.role,
    // Release 0.4.16: the caller's name is everywhere a task, a session or a comment names them, so it is never an email address.
    name: chosenName ?? safeDisplayName(developer.displayName, token.developerId),
    nameChosen: chosenName !== undefined || developer.displayNameChosen === true,
    ...(developer.slackUserId === undefined ? {} : { slackUserId: developer.slackUserId }),
    ...(developer.email === undefined ? {} : { email: developer.email }),
  };
}

/** Rechecks an opaque browser-cookie session against DeveloperIdentity on every page/API request. */
export async function authenticateDeveloperSessionId(deps: DeveloperRouteDependencies, sessionId: string): Promise<DeveloperCaller> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  const session = await getSignIn<Pick<SessionRecord, "developerId" | "amr" | "reviewExpiresAt">>(deps, `SESSION#${sessionId}`);
  if (session === undefined || (session.amr !== "slack" && session.amr !== "oidc" && session.amr !== "cloud" && session.amr !== "github" && session.amr !== "saml")
    || session.reviewExpiresAt === undefined || session.reviewExpiresAt <= Math.floor(deps.now() / 1000)) {
    throw agentXError("AUTH_REQUIRED", SIGN_IN_AGAIN);
  }
  return authenticateSession(deps, { developerId: session.developerId, sessionId, amr: session.amr });
}
