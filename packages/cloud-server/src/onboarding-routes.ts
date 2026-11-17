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
import { createHash } from "node:crypto";
import { CodeError } from "./code-client.js";
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

const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
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
export const linkToken = (value: unknown): string | undefined => (typeof value === "string" && TOKEN.test(value) ? value : undefined);

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
