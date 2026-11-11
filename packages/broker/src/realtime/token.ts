// The realtime token (Plan 5 Task 8): `POST /v1/app/realtime/token` gives a signed-in person a short-lived token that lets a client connect to the events API and
// subscribe to what it may see. The token is signed through the developer token signer (KMS, in the sign-in function), carries the audience `rovara-realtime` (a
// sign-in token is never accepted by the authorizer and this token is never a sign-in), and says which org and person it is for and which project channels they had
// a role on when it was made. The authorizer checks every subscription against it.
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { REALTIME_TOKEN_AUDIENCE, REALTIME_TOKEN_ISSUER, REALTIME_TOKEN_PROJECTS_MAX, RealtimeTokenClaimsSchema, projectChannel, projectSegment, userChannel, type OrgRole, type RealtimeTokenClaims, type RealtimeTokenRequest, type RealtimeTokenResponse } from "@agentx/cloud-contracts";
import { REALTIME_TOKEN_SECONDS, agentXError, type OrgId } from "@rovara-code/contracts";
import { randomUUID } from "node:crypto";
import type { PublicSigningJwk, TokenSigner } from "../developer/tokens.js";

const NOT_BEFORE_SKEW_SECONDS = 30;
const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A token for `orgId`'s `developerId`; `projects` is their project segments, or `"lookup"` when they have more than `REALTIME_TOKEN_PROJECTS_MAX`. */
export async function issueRealtimeToken(signer: TokenSigner, input: { orgId: OrgId; developerId: string; projects: string[] | "lookup"; now: number }): Promise<{ token: string; expiresAt: string }> {
  const { kid } = await signer.publicJwk();
  const iat = Math.floor(input.now / 1000);
  const exp = iat + REALTIME_TOKEN_SECONDS;
  const payload = {
    iss: REALTIME_TOKEN_ISSUER, aud: REALTIME_TOKEN_AUDIENCE, sub: input.developerId, org: input.orgId, projects: input.projects,
    iat, nbf: iat - NOT_BEFORE_SKEW_SECONDS, exp, jti: randomUUID(),
  };
  const signingInput = `${base64url({ alg: "RS256", typ: "JWT", kid })}.${base64url(payload)}`;
  const signature = await signer.sign(Buffer.from(signingInput));
  return { token: `${signingInput}.${signature.toString("base64url")}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * The claims of a realtime token, or undefined for anything that is not a good one (wrong audience, issuer, key, signature or shape; expired; not yet valid).
 * Never throws for a bad token. `publicKey` is the token key's public half; a failure to read it throws (the caller refuses and logs).
 */
export async function verifyRealtimeToken(publicKey: () => Promise<PublicSigningJwk>, authorization: string | undefined, now: number): Promise<RealtimeTokenClaims | undefined> {
  const token = /^(?:Bearer )?([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(authorization ?? "")?.[1];
  if (token === undefined) return undefined;
  const jwk = await publicKey();
  try {
    const header = decodeProtectedHeader(token);
    // The algorithm and any critical extension are refused by the verification below, which accepts RS256 only.
    if (header.kid !== jwk.kid) return undefined;
    const { payload } = await jwtVerify(token, await importJWK({ kty: "RSA", n: jwk.n, e: jwk.e }, "RS256"), {
      algorithms: ["RS256"], issuer: REALTIME_TOKEN_ISSUER, audience: REALTIME_TOKEN_AUDIENCE, clockTolerance: NOT_BEFORE_SKEW_SECONDS,
      currentDate: new Date(now), requiredClaims: ["exp", "nbf", "iat"],
    });
    const claims = RealtimeTokenClaimsSchema.safeParse(payload);
    return claims.success ? claims.data : undefined;
  } catch {
    return undefined;
  }
}

/** The events API's websocket address for its HTTP one: `https://<dns prefix>.appsync-api.<region>…/event` becomes `wss://<dns prefix>.appsync-realtime-api.<region>…/event/realtime`. */
export function realtimeSocketEndpoint(httpEndpoint: string): string {
  const url = new URL(httpEndpoint);
  return `wss://${url.host.replace(".appsync-api.", ".appsync-realtime-api.")}${url.pathname.replace(/\/+$/u, "")}/realtime`;
}

export interface RealtimeTokenDependencies {
  /** The events API's HTTP endpoint; without it no token is given. */
  endpoint: string | undefined;
  /** The project names the person has a role on now. */
  projectsOf(caller: { orgId: OrgId; developerId: string; orgRole: OrgRole }): Promise<string[]>;
  /** Asks the sign-in function to sign the token. */
  mint(request: RealtimeTokenRequest): Promise<{ token: string; expiresAt: string }>;
}

/** `POST /v1/app/realtime/token`: the token, when it ends, where to connect, and the channels to subscribe to (every project the person has a role on, even past the token's own list). */
export async function realtimeTokenFor(deps: RealtimeTokenDependencies, caller: { orgId: OrgId; developerId: string; orgRole: OrgRole }): Promise<RealtimeTokenResponse> {
  if (deps.endpoint === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "Live updates aren't available right now.");
  const names = [...new Set(await deps.projectsOf(caller))].sort();
  const segments = names.map((name) => projectSegment(caller.orgId, name));
  const minted = await deps.mint({
    kind: "realtime-token", orgId: caller.orgId, developerId: caller.developerId,
    projects: names.length > REALTIME_TOKEN_PROJECTS_MAX ? "lookup" : segments,
  });
  return {
    token: minted.token, expiresAt: minted.expiresAt, endpoint: realtimeSocketEndpoint(deps.endpoint),
    channels: { user: userChannel(caller.orgId, caller.developerId), projects: Object.fromEntries(names.map((name) => [name, projectChannel(caller.orgId, name)])) },
  };
}
