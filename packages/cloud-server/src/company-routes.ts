// The app's company routes that Cloud answers from its own data (migration plan v3.2, 2.2 and 2.4, decision 17): the company's settings and
// rules (with a second admin for a loosening change), its budgets as the app's Budgets screen reads them, its profile, and invites. Members,
// roles and removal stay on Code: those routes are not here, so they answer 501 NOT_ON_CODE_YET until Code serves them.
//
// Who and which company: every route asks Code's access check afresh (company-caller.ts) and takes the company and the person's company role
// from that answer (DEC 253z). A Code that names no company is refused ("You're not in a company yet."), never a fallback. A company admin is
// a company owner or admin; Code's install `administrator` flag plays no part. Nothing a request carries ever names the company.
//
// Fresh step-up: changing settings, approving a change, and inviting an admin need the admin's step-up (step-up.ts) inside the company's
// window. An invite tells Code first ("this email is pre-approved"), as the inviting admin; withdrawing one tells Code before it is marked.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CodeError } from "./code-client.js";
import { COMPANY_NAME_FALLBACK, companyCaller, isCompanyAdmin, refused, type CompanyRole } from "./company-caller.js";
import { canonical, COMPANY_SETTINGS_LIMITS, loosens, plainObject, settingsDecision, validateCompanySettings } from "./company-settings.js";
import {
  CompanyStoreConflict, INVITE_DAYS, OPEN_INVITES_MAX, PENDING_CHANGE_DAYS, companySettings,
  type CompanyStore, type InviteRecord, type PendingSettingsChange,
} from "./company-store.js";
import type { Route, RouteAnswer, RouteContext } from "./routes.js";
import { freshStepUp } from "./step-up.js";
import { recordCloudAction, type CloudAuditAction } from "./audit-log.js";
import { withdrawForMember } from "./product-ai-routes.js";

export interface CompanyBackend {
  store: CompanyStore;
  log?: (event: Record<string, unknown>) => void;
}

/** Code's route that takes the company's pre-approved emails (contract v0 `company.preApproved.put`). */
export const PRE_APPROVED_EMAILS_PATH = "/v1/dev/client/company/pre-approved-emails";
/** An unconfirmed invite this young is still being told to Code by its own request, so another admin's update keeps it in the list. */
const IN_FLIGHT_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const refusal = (status: number, code: string, message: string): RouteAnswer => ({ status, body: { error: { code, message } } });
const WORDS = Object.freeze({
  notAdmin: refusal(403, "FORBIDDEN", "Only a company admin can do this."),
  stepUp: refusal(403, "STEP_UP_REQUIRED", "Confirm it's you again, then try once more."),
  ruled: refusal(403, "FORBIDDEN", "Your company's rules don't allow this change."),
  secondPerson: refusal(403, "SECOND_PERSON_REQUIRED", "A different admin must approve this change."),
  conflict: refusal(409, "CONFLICT", "This changed since you opened it. Refresh and try again."),
  pendingExists: refusal(409, "CONFLICT", "Another settings change is waiting for approval. Approve or withdraw it first."),
  unreadable: refusal(503, "RUNTIME_UNAVAILABLE", "The company settings couldn't be read. Ask an installation administrator to check them."),
  noChange: refusal(404, "NOT_FOUND", "That change isn't waiting any more."),
  noInvite: refusal(404, "NOT_FOUND", "That invite doesn't exist."),
  unusable: refusal(404, "NOT_FOUND", "This invite can't be used. Ask your company admin for a new one."),
  tooMany: refusal(409, "CONFLICT", "Your company has too many open invites. Withdraw some first."),
  notOnCode: refusal(501, "NOT_ON_CODE_YET", "Company invites aren't connected to Rovara Code yet."),
  tooLarge: refusal(413, "CONFIG_INVALID", "The request is too large."),
  partial: refusal(503, "RUNTIME_UNAVAILABLE", "Your company has too many invite records to update Rovara Code safely. Ask an installation administrator."),
});
const bad = (message: string) => refusal(400, "CONFIG_INVALID", message);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const newChangeId = () => `chg_${Array.from(randomBytes(20), (byte) => ALPHABET[byte % 36]).join("")}`;
const keysAre = (value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = allowed) =>
  Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));

interface Caller { backend: CompanyBackend; companyId: string; companyRole: CompanyRole; companyName?: string; developerId: string; name: string }

/** The person and their company, from Code's access check made now. A RouteAnswer when Cloud has no company data or Code names no company. */
async function caller(context: RouteContext): Promise<Caller | RouteAnswer> {
  const backend = context.company;
  if (backend === undefined) return refusal(501, "NOT_ON_CODE_YET", "Company settings aren't set up on this Cloud.");
  const who = await companyCaller(context);
  if (refused(who)) return who;
  return { backend, companyId: who.companyId, companyRole: who.companyRole, ...(who.companyName === undefined ? {} : { companyName: who.companyName }), developerId: who.developerId, name: who.name };
}

/** A company owner or admin (Code's company role, never its install administrator flag). */
async function admin(context: RouteContext): Promise<Caller | RouteAnswer> {
  const who = await caller(context);
  if ("status" in who) return who;
  return isCompanyAdmin(who.companyRole) ? who : WORDS.notAdmin;
}

/** The admin's step-up is inside `windowSeconds`. */
const steppedUp = (context: RouteContext, windowSeconds: number) => freshStepUp(context.session.accessToken, context.now().getTime(), windowSeconds) !== undefined;

const tooLarge = (body: unknown) => Buffer.byteLength(JSON.stringify(body) ?? "", "utf8") > COMPANY_SETTINGS_LIMITS.bodyBytesMax;
const log = (who: Caller, event: Record<string, unknown>) => (who.backend.log ?? ((entry) => { console.log(JSON.stringify(entry)); }))({ ...event, companyId: who.companyId, developerId: who.developerId });
/**
 * Writes Cloud's audit record of a change already saved (plan v3.2 7.5; audit-log.ts), when this Cloud keeps audit records. Recorded after the
 * change, so a failed write can't undo it: the failure is logged (fixed words) and the answer stands.
 */
async function audited(context: RouteContext, who: Caller, action: CloudAuditAction, subject?: string): Promise<void> {
  if (context.audit === undefined) return;
  try {
    await recordCloudAction(context.audit, { companyId: who.companyId, actor: { developerId: who.developerId, name: who.name, type: "person" }, action, via: "web", ...(subject === undefined ? {} : { subject }) }, context.now);
  } catch {
    log(who, { event: "cloud.audit_failed", action });
  }
}

function pendingView(change: PendingSettingsChange) {
  return { changeId: change.changeId, settings: change.settings, baseVersion: change.baseVersion, proposedBy: change.proposedBy, proposedAt: change.proposedAt, expiresAt: change.expiresAt };
}

async function readSettings(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  if ("status" in who) return who;
  const current = await companySettings(who.backend.store, who.companyId);
  if (current === undefined) return WORDS.unreadable;
  const pending = await who.backend.store.pendingChange(who.companyId, context.now().getTime());
  return ok({ companyId: who.companyId, ...current, modelGateway: modelGatewayReadiness(current.settings), ...(pending === undefined ? {} : { pending: pendingView(pending) }) });
}

async function changeSettings(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  if ("status" in who) return who;
  const body = context.body;
  if (tooLarge(body)) return WORDS.tooLarge;
  if (!plainObject(body) || !keysAre(body, ["expectedVersion", "settings"]) || typeof body["expectedVersion"] !== "number" || !Number.isSafeInteger(body["expectedVersion"]) || body["expectedVersion"] < 0) {
    return bad("Send { expectedVersion, settings }.");
  }
  const read = validateCompanySettings(body["settings"]);
  if (!read.ok) return bad(read.problem);
  const next = read.settings;
  const current = await companySettings(who.backend.store, who.companyId);
  if (current === undefined) return WORDS.unreadable;
  const loosening = loosens(current.settings, next);
  // The company's current rules decide: a second admin approves (the proposer need not be a decider) or this admin decides now.
  const required = settingsDecision(current.settings, loosening, "requirement", who.developerId);
  if (!required.allow) return WORDS.ruled;
  const decision = required.secondPerson ? required : settingsDecision(current.settings, loosening, "verdict", who.developerId);
  if (!decision.allow) return WORDS.ruled;
  if (!steppedUp(context, decision.signInMaxAgeSeconds)) return WORDS.stepUp;
  if (current.version !== body["expectedVersion"]) return WORDS.conflict;
  if (canonical(next) === canonical(current.settings)) return ok({ companyId: who.companyId, version: current.version, settings: current.settings });
  const at = context.now().toISOString();
  if (decision.secondPerson) {
    const change: PendingSettingsChange = {
      companyId: who.companyId, changeId: newChangeId(), settings: next, baseVersion: current.version, proposedBy: who.developerId, proposedAt: at,
      expiresAt: new Date(context.now().getTime() + PENDING_CHANGE_DAYS * DAY_MS).toISOString(),
    };
    try {
      await who.backend.store.proposeChange(change, context.now().getTime());
    } catch (error) {
      if (error instanceof CompanyStoreConflict) return WORDS.pendingExists;
      throw error;
    }
    log(who, { event: "cloud.company_settings_proposed", changeId: change.changeId, loosening });
    return { status: 202, body: { companyId: who.companyId, version: current.version, pending: pendingView(change) } };
  }
  let version: number;
  try {
    version = await who.backend.store.putSettings(who.companyId, next, current.version, who.developerId, at);
  } catch (error) {
    if (error instanceof CompanyStoreConflict) return WORDS.conflict;
    throw error;
  }
  log(who, { event: "cloud.company_settings_changed", version, loosening });
  await audited(context, who, canonical(next.budgets) === canonical(current.settings.budgets) ? "company.rules.changed" : "company.budget.changed");
  return ok({ companyId: who.companyId, version, settings: next });
}

async function approveChange(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  if ("status" in who) return who;
  const changeId = context.params[0]!;
  const store = who.backend.store;
  const change = await store.pendingChange(who.companyId, context.now().getTime());
  if (change === undefined || change.changeId !== changeId || change.companyId !== who.companyId) return WORDS.noChange;
  if (change.proposedBy === who.developerId) return WORDS.secondPerson;
  const current = await companySettings(store, who.companyId);
  if (current === undefined) return WORDS.unreadable;
  const read = validateCompanySettings(change.settings);
  if (current.version !== change.baseVersion || !read.ok) {
    // The settings moved on since it was proposed (or the stored change does not read): it can never apply.
    await store.dropChange(who.companyId, changeId);
    return WORDS.conflict;
  }
  const decision = settingsDecision(current.settings, loosens(current.settings, read.settings), "verdict", who.developerId);
  if (!decision.allow) return WORDS.ruled;
  if (!steppedUp(context, decision.signInMaxAgeSeconds)) return WORDS.stepUp;
  let version: number;
  try {
    version = await store.applyChange({ ...change, settings: read.settings }, who.developerId, context.now().toISOString());
  } catch (error) {
    if (error instanceof CompanyStoreConflict) return WORDS.conflict;
    throw error;
  }
  log(who, { event: "cloud.company_settings_approved", changeId, version, proposedBy: change.proposedBy });
  await audited(context, who, canonical(read.settings.budgets) === canonical(current.settings.budgets) ? "company.rules.changed" : "company.budget.changed", `change:${changeId}`);
  return ok({ companyId: who.companyId, version, settings: read.settings });
}

async function withdrawChange(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  if ("status" in who) return who;
  // Withdrawing loosens nothing, so any admin may, without a step-up.
  if (!(await who.backend.store.dropChange(who.companyId, context.params[0]!))) return WORDS.noChange;
  log(who, { event: "cloud.company_settings_withdrawn", changeId: context.params[0] });
  return ok({ withdrawn: true });
}

/**
 * Whether the model gateway will serve this company: it refuses a company with no company monthly cap (fail closed), and Cloud sets no
 * default amount, so the admin screen can say what to do.
 */
export function modelGatewayReadiness(settings: { budgets: { companyMonthlyUsdMicros: number | null } }): { ready: true } | { ready: false; reason: "company_monthly_cap_unset"; message: string } {
  return settings.budgets.companyMonthlyUsdMicros === null
    ? { ready: false, reason: "company_monthly_cap_unset", message: "Set a monthly cap to use the model gateway." }
    : { ready: true };
}

const monthly = (micros: number | null) => (micros === null ? { kind: "unlimited", source: "unset" } : { kind: "limited", microdollars: micros, source: "configured" });

async function budgetSettings(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  if ("status" in who) return who;
  const current = await companySettings(who.backend.store, who.companyId);
  if (current === undefined) return WORDS.unreadable;
  const budgets = current.settings.budgets;
  // The app's AdminBudgetSettingsSchema: configured monthly base settings only; usage and enforcement are the gateway's.
  return ok({
    orgId: who.companyId, checkedAt: context.now().toISOString(), coverage: "monthly_base_settings_only",
    orgMonthly: monthly(budgets.companyMonthlyUsdMicros), memberDefaultMonthly: monthly(budgets.memberMonthlyUsdMicros),
    memberOverrideCount: 0, memberOverrideCoverage: "configured_only_membership_not_checked", topUps: "not_checked", usage: "not_checked", enforcement: "not_checked",
  });
}

async function profileOf(context: RouteContext, who: Caller) {
  const stored = await who.backend.store.profile(who.companyId);
  return stored ?? { companyId: who.companyId, name: who.companyName ?? COMPANY_NAME_FALLBACK, plan: context.org.plan, version: 0 };
}

async function readProfile(context: RouteContext): Promise<RouteAnswer> {
  const who = await caller(context);
  if ("status" in who) return who;
  const profile = await profileOf(context, who);
  return ok({ orgId: who.companyId, name: profile.name, plan: profile.plan, version: profile.version });
}

const NAME_UNSAFE = /(?![‌‍])[\p{Cc}\p{Cf}]/u;

async function renameCompany(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  if ("status" in who) return who;
  const body = context.body;
  if (!plainObject(body) || !keysAre(body, ["requestId", "name"]) || typeof body["requestId"] !== "string" || !UUID.test(body["requestId"]) || typeof body["name"] !== "string") {
    return bad("Send { requestId, name }.");
  }
  // White space folds to one space (a tab is a control character too); any other control or format character is refused.
  const name = body["name"].length > 400 ? "" : body["name"].replace(/\s+/gu, " ").trim();
  if (NAME_UNSAFE.test(name)) return bad("name: must have 1 to 80 printable characters");
  if (name.length === 0 || Array.from(name).length > 80) return bad("name: must have 1 to 80 printable characters");
  const current = await profileOf(context, who);
  try {
    await who.backend.store.putProfile({ companyId: who.companyId, name, plan: current.plan, updatedAt: context.now().toISOString(), updatedBy: who.developerId }, current.version);
  } catch (error) {
    if (error instanceof CompanyStoreConflict) return WORDS.conflict;
    throw error;
  }
  log(who, { event: "cloud.company_renamed" });
  // The app's RenameOrganizationResponseSchema names the role "owner" only: only a company owner or admin gets here.
  return ok({ org: { orgId: who.companyId, name, plan: current.plan }, role: "owner" });
}

// ---- Invites ----

const tokenHash = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const expired = (invite: InviteRecord, nowMs: number) => Date.parse(invite.expiresAt) <= nowMs;
/** An address as the app may show it: the first character and the domain. */
const masked = (email: string) => { const at = email.lastIndexOf("@"); return `${email.slice(0, 1)}***${email.slice(at)}`.slice(0, 260); };
const receipt = (invite: InviteRecord) => ({ orgId: invite.companyId, requestId: invite.requestId, inviteId: invite.inviteId, role: invite.role, createdAt: invite.createdAt, expiresAt: invite.expiresAt });

/**
 * Tells Code the company's pre-approved emails, as the admin: every pending invite's address that has not expired, the invites this
 * request is adding, and others still being told by their own request. An invite being withdrawn is `revoking`, so it is left out.
 * "notOnCode" when Code does not serve the route yet.
 */
async function tellCode(context: RouteContext, who: Caller, adding: readonly InviteRecord[]): Promise<"told" | "notOnCode" | "partial"> {
  const nowMs = context.now().getTime();
  const { invites, partial } = await who.backend.store.invites(who.companyId);
  // Code's list is replaced whole: never send one built from part of the invites, which would drop people still invited.
  if (partial) return "partial";
  const kept = invites.filter((invite) => !expired(invite, nowMs)
    && (invite.state === "pending" || (invite.state === "unconfirmed" && nowMs - Date.parse(invite.createdAt) < IN_FLIGHT_MS)));
  const emails = [...new Set([...kept, ...adding].map((invite) => invite.email))].sort();
  try {
    await context.client.json(context.session, PRE_APPROVED_EMAILS_PATH, { method: "PUT", body: { requestId: randomUUID(), emails } });
    return "told";
  } catch (error) {
    if (error instanceof CodeError && (error.status === 404 || error.status === 405 || error.status === 501)) return "notOnCode";
    throw error;
  }
}

function readInviteBody(body: unknown): { requestId: string; role: "admin" | "member"; email: string } | RouteAnswer {
  if (!plainObject(body) || !keysAre(body, ["requestId", "role", "email"], ["requestId", "role"]) || typeof body["requestId"] !== "string" || !UUID.test(body["requestId"])
    || (body["role"] !== "admin" && body["role"] !== "member")) return bad("Send { requestId, role: admin or member, email }.");
  // Code admits a person by a pre-approved email (decision 17), so an invite without one could let nobody in.
  if (body["email"] === undefined) return bad("An invite needs the person's email address.");
  if (typeof body["email"] !== "string" || body["email"].length > 254) return bad("email: must be one email address");
  const email = body["email"].trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return bad("email: must be one email address");
  return { requestId: body["requestId"], role: body["role"], email };
}

async function createInvite(context: RouteContext, withReceipt: boolean): Promise<RouteAnswer> {
  const who = await admin(context);
  if ("status" in who) return who;
  const input = readInviteBody(context.body);
  if ("status" in input) return input;
  const store = who.backend.store;
  const current = await companySettings(store, who.companyId);
  if (current === undefined) return WORDS.unreadable;
  // Giving the admin role needs a fresh step-up (plan 2.4, step 2).
  if (input.role === "admin" && !steppedUp(context, current.settings.freshSignInSeconds)) return WORDS.stepUp;
  if ((await store.inviteByRequest(who.companyId, input.requestId)) !== undefined) return WORDS.conflict;
  const nowMs = context.now().getTime();
  const { invites } = await store.invites(who.companyId);
  if (invites.filter((invite) => (invite.state === "pending" || invite.state === "unconfirmed" || invite.state === "revoking") && !expired(invite, nowMs)).length >= OPEN_INVITES_MAX) return WORDS.tooMany;
  const token = randomBytes(32).toString("base64url");
  const invite: InviteRecord = {
    companyId: who.companyId, inviteId: randomUUID(), requestId: input.requestId, role: input.role, email: input.email, tokenHash: tokenHash(token),
    createdBy: who.developerId, createdAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + INVITE_DAYS * DAY_MS).toISOString(), state: "unconfirmed", revision: 0,
  };
  try {
    await store.createInvite(invite);
  } catch (error) {
    if (error instanceof CompanyStoreConflict) return WORDS.conflict;
    throw error;
  }
  let confirmed = false;
  try {
    const told = await tellCode(context, who, [invite]);
    if (told !== "told") return told === "notOnCode" ? WORDS.notOnCode : WORDS.partial;
    await store.updateInvite({ ...invite, state: "pending" }, { revision: 0, state: "unconfirmed" });
    confirmed = true;
  } finally {
    // Code never took it (or it could not be marked): take it back, so it is never shown, accepted or sent again.
    if (!confirmed) await store.removeInvite(invite).catch(() => undefined);
  }
  log(who, { event: "cloud.invite_created", inviteId: invite.inviteId, role: invite.role });
  await audited(context, who, "company.invite.created", `invite:${invite.inviteId}`);
  const inviteUrl = `${context.origin}/app/join#invite=${token}`;
  return ok(withReceipt ? { receipt: receipt(invite), inviteUrl } : { inviteUrl });
}

function statusOf(invite: InviteRecord, nowMs: number): "pending" | "accepted" | "revoked" | "expired" {
  if (invite.state === "accepted" || invite.state === "revoked") return invite.state;
  return expired(invite, nowMs) ? "expired" : "pending";
}

async function listInvites(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  if ("status" in who) return who;
  const nowMs = context.now().getTime();
  const limit = Math.min(50, Math.max(1, Number.parseInt(context.query.get("limit") ?? "25", 10) || 25));
  const cursor = context.query.get("cursor");
  const offset = cursor !== null && /^o[0-9]{1,6}$/u.test(cursor) ? Number(cursor.slice(1)) : 0;
  const { invites, partial } = await who.backend.store.invites(who.companyId);
  const open = invites.filter((invite) => (invite.state === "pending" || invite.state === "revoking") && !expired(invite, nowMs));
  const page = open.slice(offset, offset + limit);
  return ok({
    invites: page.map((invite) => ({
      inviteId: invite.inviteId, revision: invite.revision, role: invite.role, createdAt: invite.createdAt, expiresAt: invite.expiresAt, createdBy: invite.createdBy,
      destination: { kind: "email", label: masked(invite.email) },
    })),
    coverage: partial ? "indexed_only_partial" : "indexed_only", checkedAt: new Date(nowMs).toISOString(),
    ...(offset + limit < open.length ? { nextCursor: `o${String(offset + limit)}` } : {}),
  });
}

async function inviteStatus(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  if ("status" in who) return who;
  const invite = await who.backend.store.invite(who.companyId, context.params[0]!);
  if (invite === undefined || invite.companyId !== who.companyId || invite.state === "unconfirmed") return WORDS.noInvite;
  const nowMs = context.now().getTime();
  return ok({
    orgId: invite.companyId, inviteId: invite.inviteId, revision: invite.revision, role: invite.role, status: statusOf(invite, nowMs), expiresAt: invite.expiresAt,
    checkedAt: new Date(nowMs).toISOString(), ...(invite.state === "revoked" && invite.revokedAt !== undefined ? { revokedAt: invite.revokedAt } : {}),
  });
}

async function creationReceipt(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  if ("status" in who) return who;
  const requestId = context.params[0]!;
  if (!UUID.test(requestId)) return WORDS.noInvite;
  const invite = await who.backend.store.inviteByRequest(who.companyId, requestId);
  if (invite === undefined || invite.companyId !== who.companyId || invite.state === "unconfirmed") return WORDS.noInvite;
  return ok({ receipt: receipt(invite) });
}

async function revokeInvite(context: RouteContext): Promise<RouteAnswer> {
  const who = await admin(context);
  if ("status" in who) return who;
  const body = context.body;
  if (!plainObject(body) || !keysAre(body, ["requestId", "expectedRevision"]) || typeof body["requestId"] !== "string" || !UUID.test(body["requestId"])
    || typeof body["expectedRevision"] !== "number" || !Number.isSafeInteger(body["expectedRevision"]) || body["expectedRevision"] < 0) return bad("Send { requestId, expectedRevision }.");
  const store = who.backend.store;
  const invite = await store.invite(who.companyId, context.params[0]!);
  if (invite === undefined || invite.companyId !== who.companyId || invite.state === "unconfirmed") return WORDS.noInvite;
  if ((invite.state !== "pending" && invite.state !== "revoking") || invite.revision !== body["expectedRevision"]) return WORDS.conflict;
  // Marked first, so no other admin's update sends it to Code again; Code is told; only then is it withdrawn (plan 2.4, step 4).
  const revoking: InviteRecord = { ...invite, state: "revoking" };
  try {
    if (invite.state === "pending") await store.updateInvite(revoking, { revision: invite.revision, state: "pending" });
  } catch (error) {
    if (error instanceof CompanyStoreConflict) return WORDS.conflict;
    throw error;
  }
  let told: "told" | "notOnCode" | "partial";
  try {
    told = await tellCode(context, who, []);
  } catch (error) {
    // Code's answer is unknown: an invite that was pending goes back to pending (a retry tells Code again); one already stuck stays withdrawn from the list.
    if (invite.state === "pending") await store.updateInvite(invite, { revision: invite.revision, state: "revoking" }).catch(() => undefined);
    throw error;
  }
  if (told !== "told") {
    if (invite.state === "pending") await store.updateInvite(invite, { revision: invite.revision, state: "revoking" }).catch(() => undefined);
    return told === "notOnCode" ? WORDS.notOnCode : WORDS.partial;
  }
  const revokedAt = context.now().toISOString();
  const revision = invite.revision + 1;
  try {
    await store.updateInvite({ ...invite, state: "revoked", revision, revokedAt }, { revision: invite.revision, state: "revoking" });
  } catch (error) {
    if (error instanceof CompanyStoreConflict) return WORDS.conflict;
    throw error;
  }
  log(who, { event: "cloud.invite_revoked", inviteId: invite.inviteId });
  await audited(context, who, "company.invite.revoked", `invite:${invite.inviteId}`);
  return ok({ inviteId: invite.inviteId, revokedAt, revision });
}

/**
 * The invited person, signed in through Code (which admitted them on the pre-approved email), records that they took the invite. The
 * invite must belong to the company Code put them in; a used, withdrawn, expired, unknown or other company's invite answers the same.
 */
async function acceptInvite(context: RouteContext): Promise<RouteAnswer> {
  const who = await caller(context);
  if ("status" in who) return who;
  const body = context.body;
  if (!plainObject(body) || !keysAre(body, ["invite"]) || typeof body["invite"] !== "string" || !TOKEN.test(body["invite"])) return bad("Send { invite } from the invite link.");
  const store = who.backend.store;
  const invite = await store.inviteByToken(tokenHash(body["invite"]));
  const nowMs = context.now().getTime();
  if (invite === undefined || invite.companyId !== who.companyId || invite.state !== "pending" || expired(invite, nowMs)) return WORDS.unusable;
  // PRODUCT-EVAL-APPROVER-REREAD: accepting an invite sets the person's company role, so any eval approval they made stops counting first.
  const withdrawal = await withdrawForMember(context, who.developerId, { companyId: who.companyId });
  if ("status" in withdrawal) return withdrawal;
  try {
    await store.updateInvite({ ...invite, state: "accepted", revision: invite.revision + 1, acceptedAt: new Date(nowMs).toISOString(), acceptedBy: who.developerId }, { revision: invite.revision, state: "pending" });
  } catch (error) {
    if (error instanceof CompanyStoreConflict) return WORDS.unusable;
    throw error;
  }
  await withdrawal.after();
  log(who, { event: "cloud.invite_accepted", inviteId: invite.inviteId });
  return ok({ accepted: true, inviteId: invite.inviteId, orgId: invite.companyId });
}

/** The company routes, added to the route table when the handler has a company backend. */
export const COMPANY_ROUTES: Route[] = [
  { method: "GET", path: /^\/org\/settings$/u, answer: readSettings },
  { method: "PUT", path: /^\/org\/settings$/u, answer: changeSettings },
  { method: "POST", path: /^\/org\/settings\/pending\/(chg_[0-9a-z]{20})\/approve$/u, answer: approveChange },
  { method: "POST", path: /^\/org\/settings\/pending\/(chg_[0-9a-z]{20})\/withdraw$/u, answer: withdrawChange },
  { method: "GET", path: /^\/org\/budget-settings$/u, answer: budgetSettings },
  { method: "GET", path: /^\/org\/profile$/u, answer: readProfile },
  { method: "PATCH", path: /^\/org$/u, answer: renameCompany },
  { method: "GET", path: /^\/org\/invites$/u, answer: listInvites },
  { method: "POST", path: /^\/org\/invites$/u, answer: (context) => createInvite(context, false) },
  { method: "POST", path: /^\/org\/invites\/reviewed$/u, answer: (context) => createInvite(context, true) },
  { method: "POST", path: /^\/org\/invites\/accept$/u, answer: acceptInvite },
  { method: "GET", path: /^\/org\/invites\/requests\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u, answer: creationReceipt },
  { method: "GET", path: /^\/org\/invites\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u, answer: inviteStatus },
  { method: "POST", path: /^\/org\/invites\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/revoke$/u, answer: revokeInvite },
];
