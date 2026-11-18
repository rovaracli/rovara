// L4-MF4: "Your account" confirmation email and passkeys, Cloud's half. A signed-in person reads their OWN sign-in factors; Rovara Code owns the rule and the data
// (the sign-in table), Cloud passes the read through as the person and shows Code's answer in its own fixed shape.
//
//   GET /v1/app/me/sign-in-factors   (the browser's GET /v1/web/me/sign-in-factors)   Code's GET /v1/dev/me/sign-in-factors as the person: { factorEmail?: "m***@example.com", passkeys: [{ credentialId, createdAt, lastUsedAt? }] }
//
// Rules: the path, the query and the body of the browser's request are never forwarded and name no person (Code reads the caller from the token Cloud holds for THIS
// sign-in); Code's answer is rebuilt field by field (a masked email of the one allowed form, at most 10 passkeys of an opaque id and times), so a full address or key
// material Code might one day send never reaches the browser; and Code's own words never pass through (a refusal is Cloud's fixed words). Code answers 404 while it does
// not serve the route: that is "not connected yet" (501 NOT_ON_CODE_YET), which the account page reads as "hide these two sections".
import { CodeError, type CodeClient } from "./code-client.js";
import { connectRefusal, isObject, type ConnectAnswer } from "./connect-flow.js";
import type { CodeSession } from "./sessions.js";

const CODE_SIGN_IN_FACTORS = "/v1/dev/me/sign-in-factors";

/** Cloud's fixed words for this read. */
export const SIGN_IN_FACTOR_WORDS = Object.freeze({
  notOnCode: "Your sign-in factors aren't connected to Rovara Code yet.",
  unavailable: "Your sign-in factors could not be reached just now. Try again in a moment.",
  signedOut: "Sign in to continue.",
});

/** Passkeys Code lets one person register (DEVELOPER_PASSKEYS_MAX). */
const PASSKEYS_MAX = 10;
const MASKED_EMAIL = /^[^\s@]\*\*\*@[^\s@]+$/u;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,512}$/u;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

const isTime = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && ISO_TIME.test(value) && Number.isFinite(Date.parse(value));

/** Code's answer, rebuilt field by field. Undefined when anything does not read (including an email that is not a masked one). */
function factorsOf(body: unknown): { factorEmail?: string; passkeys: Array<{ credentialId: string; createdAt: string; lastUsedAt?: string }> } | undefined {
  if (!isObject(body) || !Array.isArray(body.passkeys) || body.passkeys.length > PASSKEYS_MAX) return undefined;
  const email = body.factorEmail;
  if (email !== undefined && (typeof email !== "string" || email.length > 254 || !MASKED_EMAIL.test(email))) return undefined;
  const passkeys: Array<{ credentialId: string; createdAt: string; lastUsedAt?: string }> = [];
  for (const row of body.passkeys as unknown[]) {
    if (!isObject(row) || typeof row.credentialId !== "string" || !CREDENTIAL_ID.test(row.credentialId) || !isTime(row.createdAt)) return undefined;
    if (row.lastUsedAt !== undefined && !isTime(row.lastUsedAt)) return undefined;
    passkeys.push({ credentialId: row.credentialId, createdAt: row.createdAt, ...(row.lastUsedAt === undefined ? {} : { lastUsedAt: row.lastUsedAt }) });
  }
  return { ...(email === undefined ? {} : { factorEmail: email }), passkeys };
}

export interface SignInFactorsDeps {
  client: CodeClient;
  log: (event: Record<string, unknown>) => void;
}

export function createSignInFactors(deps: SignInFactorsDeps) {
  return {
    /** GET /v1/app/me/sign-in-factors */
    async read(session: CodeSession): Promise<ConnectAnswer> {
      let answer: unknown;
      try {
        answer = await deps.client.json<unknown>(session, CODE_SIGN_IN_FACTORS, { method: "GET" });
      } catch (error) {
        if (!(error instanceof CodeError)) throw error;
        // A refusal is logged by status only (never Code's words), so a broken deployment does not look like "not on Code yet" without a trace.
        deps.log({ event: "cloud.sign_in_factors_refused", status: error.status, developerId: session.access.developerId });
        if (error.status === 401) return connectRefusal(401, "AUTH_REQUIRED", SIGN_IN_FACTOR_WORDS.signedOut);
        if (error.status === 404 || error.status === 405 || error.status === 501) return connectRefusal(501, "NOT_ON_CODE_YET", SIGN_IN_FACTOR_WORDS.notOnCode);
        return connectRefusal(503, "RUNTIME_UNAVAILABLE", SIGN_IN_FACTOR_WORDS.unavailable);
      }
      const factors = factorsOf(answer);
      if (factors === undefined) {
        deps.log({ event: "cloud.sign_in_factors_unreadable", developerId: session.access.developerId });
        return connectRefusal(503, "RUNTIME_UNAVAILABLE", SIGN_IN_FACTOR_WORDS.unavailable);
      }
      return { status: 200, body: factors };
    },

    /** The app route this module answers (the path after /v1/web, which the app calls as /v1/app), or undefined. Only GET, only this exact path: nothing of the request is forwarded. */
    route(method: string, apiPath: string): ((session: CodeSession) => Promise<ConnectAnswer>) | undefined {
      if (method === "GET" && apiPath === "/me/sign-in-factors") return (session) => this.read(session);
      return undefined;
    },
  };
}

export type SignInFactors = ReturnType<typeof createSignInFactors>;
