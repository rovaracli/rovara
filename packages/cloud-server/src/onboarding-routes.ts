// Onboarding (DEC 253z, 254a; designs-2026-10-30/cloud-per-person-company-onboarding.md, journeys A and B): a person with no company creates
// one with an operator's invite code, or joins one from an invite link.
//
// Create: `POST /v1/app/companies` { name, inviteCode } goes to Code's `POST /v1/dev/company` as the person (their own token). Code checks the
// invite code (single use, expiring) and makes the person the company's owner; Cloud answers Code's outcome in fixed words and the app
// signs the person in again, so the new sign-in carries the company. Until Code serves the route, it answers "not available yet".
//
// Join: the invite link carries only an opaque token, in its fragment. The join page posts it to `POST /v1/auth/browser/join` (same origin
// only, no sign-in needed): Cloud looks the invite up server-side, answers the company's name and keeps a single-use join ticket in a
// short-lived HttpOnly cookie. "Sign in to join" then opens `/v1/auth/browser/authorize?join=1`, where Cloud takes the ticket, checks the
// invite again and sends `company=<the invite's company>` to Code's sign-in itself. Code still checks the verified email against its
// pre-approval. Nothing the browser sends names a company. Any failure is the one sentence JOIN_UNUSABLE.
//
// Code's invite secret (DEC 254h): when the link carries Code's single-use secret (the invite's `codeSecret`), the lookup seals the secret
// into the join ticket under a key only the ticket's cookie holds (`<ticket>.<key>`), so the pending-sign-in store never keeps it readable.
// "Sign in to join" opens it and sends `company=<id>&invite=<secret>` to Code's authorize: the only URL after the link that carries it. Cloud
// marks the invite accepted only when Code's access answer puts the person in the invite's company AND says `joinedByInvite: true`.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isCodeOutcomeUnknown, CodeError } from "./code-client.js";
import { companyOf } from "./company-caller.js";
import { COMPANY_ID, type CompanyStore, type InviteRecord } from "./company-store.js";
import type { Route, RouteAnswer } from "./routes.js";

export const JOIN_UNUSABLE = "This invite can't be used. Ask your company admin for a new one.";
export const COMPANY_CREATE_PATH = "/v1/dev/company";
const refusal = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
export const CREATE_WORDS = Object.freeze({
  invalid: refusal(400, "CONFIG_INVALID", "Give a company name of 1 to 80 characters and the invite code you were given."),
  badCode: refusal(403, "FORBIDDEN", "This invite code can't be used. Ask the Rovara team for a new one."),
  already: refusal(409, "CONFLICT", "You're already in a company."),
  tooMany: refusal(429, "RATE_LIMITED", "Too many tries. Wait an hour and try again."),
  notYet: refusal(501, "NOT_ON_CODE_YET", "Creating a company isn't available yet."),
  failed: refusal(503, "RUNTIME_UNAVAILABLE", "Your company couldn't be created right now. Try again in a moment."),
});

/**
 * The token an invite link carries: Code's invite secret (URL-safe, at least 128 bits, Code's fixed prefix) or Cloud's own 43-character token
 * from a Code that mints none. The same pattern as @agentx/contracts INVITE_LINK_TOKEN (a test keeps them equal).
 */
export const LINK_TOKEN = /^[A-Za-z0-9_-]{22,128}$/u;
const INVITE_CODE = /^[A-Za-z0-9_-]{8,128}$/u;
const NAME_UNSAFE = /[\p{Cc}\p{Cf}]/u;
export const inviteTokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

/** The invite a link's token names, when it can still be used: pending, not expired, for a company id that reads. */
export async function usableInvite(store: CompanyStore | undefined, tokenHashHex: string, nowMs: number): Promise<InviteRecord | undefined> {
  if (store === undefined || !/^[a-f0-9]{64}$/u.test(tokenHashHex)) return undefined;
  const invite = await store.inviteByToken(tokenHashHex);
  if (invite === undefined || invite.tokenHash !== tokenHashHex || invite.state !== "pending" || !COMPANY_ID.test(invite.companyId)) return undefined;
  return Date.parse(invite.expiresAt) > nowMs ? invite : undefined;
}

/** A link token as the join page sends it, or undefined. */
export const linkToken = (value: unknown): string | undefined => (typeof value === "string" && LINK_TOKEN.test(value) ? value : undefined);

/** A fresh key for sealing an invite secret into a join ticket (32 bytes, base64url: the cookie's second half). */
export const ticketKey = () => randomBytes(32).toString("base64url");
const TICKET_KEY = /^[A-Za-z0-9_-]{43}$/u;

/** The invite secret sealed under the ticket's cookie key, bound to the ticket: base64url(iv | tag | ciphertext). */
export function sealSecret(secret: string, key: string, ticket: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv);
  cipher.setAAD(Buffer.from(`rovara-join-ticket:${ticket}`, "utf8"));
  const sealed = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64url");
}

/** The secret sealSecret kept, or undefined when the key, the ticket or the sealed value don't match (never a throw). */
export function openSecret(sealed: unknown, key: string, ticket: string): string | undefined {
  if (typeof sealed !== "string" || sealed.length > 400 || !TICKET_KEY.test(key)) return undefined;
  try {
    const raw = Buffer.from(sealed, "base64url");
    if (raw.length < 29) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64url"), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`rovara-join-ticket:${ticket}`, "utf8"));
    decipher.setAuthTag(raw.subarray(12, 28));
    return linkToken(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
  } catch {
    return undefined;
  }
}

async function createCompany(context: Parameters<Route["answer"]>[0]): Promise<RouteAnswer> {
  const body = context.body as Record<string, unknown> | undefined;
  if (body === null || typeof body !== "object" || Array.isArray(body) || !Object.keys(body).every((key) => key === "name" || key === "inviteCode")) return CREATE_WORDS.invalid;
  const rawName = body["name"], inviteCode = body["inviteCode"];
  if (typeof rawName !== "string" || rawName.length > 400 || typeof inviteCode !== "string" || !INVITE_CODE.test(inviteCode)) return CREATE_WORDS.invalid;
  const name = rawName.replace(/\s+/gu, " ").trim();
  if (name.length === 0 || Array.from(name).length > 80 || NAME_UNSAFE.test(name)) return CREATE_WORDS.invalid;
  // One company per person (DEC 253z): Code refuses too; this spares it the call.
  const access = await context.client.access(context.session);
  if (companyOf(access) !== undefined) return CREATE_WORDS.already;
  let answer: unknown;
  try {
    answer = await context.client.json<unknown>(context.session, COMPANY_CREATE_PATH, { method: "POST", body: { name, inviteCode } });
  } catch (error) {
    if (isCodeOutcomeUnknown(error)) return { status: error.status, body: error.body };
    if (!(error instanceof CodeError)) throw error;
    // Code's own words never pass through: each outcome has Cloud's fixed answer.
    if (error.status === 403) return CREATE_WORDS.badCode;
    if (error.status === 409) return CREATE_WORDS.already;
    if (error.status === 429) return CREATE_WORDS.tooMany;
    if (error.status === 404 || error.status === 405 || error.status === 501) return CREATE_WORDS.notYet;
    return CREATE_WORDS.failed;
  }
  const made = companyOf({ ...access, ...(answer !== null && typeof answer === "object" ? answer as Record<string, unknown> : {}) });
  if (made === undefined || made.companyRole !== "owner") return CREATE_WORDS.failed;
  console.log(JSON.stringify({ event: "cloud.company_created", companyId: made.companyId, developerId: access.developerId }));
  // The sign-in Cloud holds names no company: the app signs the person in again, and the new sign-in carries the company.
  return { status: 201, body: { companyId: made.companyId, signInAgain: true } };
}

export const ONBOARDING_ROUTES: Route[] = [
  { method: "POST", path: /^\/companies$/u, answer: createCompany },
];
