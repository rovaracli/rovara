// The admin pages' read layer (Hybrid 1, DEC 223): what the Spending, Settings, sign-in factor and Sign-in clients pages read from Cloud's `/v1/app/*` routes.
// Every reader is total over untrusted data: a field that is not the shape is absent, never half drawn, and a body that is not an object is "unreadable".
// Nothing is invented: when Cloud does not serve a route (404 or 501), the page says "not connected yet" and never shows a number it did not read.
import { ApiError } from "./errors.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const money = (value: unknown): number | undefined => { const n = num(value); return n !== undefined && n >= 0 ? n : undefined; };
const count = (value: unknown): number | undefined => { const n = num(value); return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined; };
const opt = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]?: V }));

/** Cloud's route is not there yet, or Code does not serve what it needs: the page says "not connected yet". */
export function isNotConnected(error: unknown): boolean { return error instanceof ApiError && (error.status === 404 || error.status === 501); }
/** A sensitive change needs a fresh sign-in (Code's step-up page) before it can be made. */
export function needsStepUp(error: unknown): boolean { return error instanceof ApiError && (error.code === "STEP_UP_REQUIRED" || error.code === "REAUTH_REQUIRED"); }

// ---- Spending ----
export const ORG_SPEND_PATH = "/v1/app/org/spend";
export interface ProjectSpend { name: string; spentUsd: number; heldUsd?: number; limitUsd?: number; taskStopUsd?: number; mergedCount?: number; paidFrom?: string; locked?: boolean }
export interface PersonSpend { name: string; role?: string; spentUsd: number; allowanceUsd?: number; allowanceSource?: "own" | "company_default"; tasks?: number; mergedCount?: number }
/**
 * Cloud's `GET /v1/app/org/spend`. Contract v0 (`OrgSpendSummaryAddition`) has `spentThisMonthUsd` and `remainingUsd`; the page also reads these optional
 * additions when Cloud sends them: `heldUsd`, `limitUsd`, `runsOutOn`, `costPerMergedChangeUsd`, `mergedCount`, `month`, `byProject[]` and `byPerson[]`.
 */
export interface OrgSpendRead {
  spentUsd?: number; remainingUsd?: number; heldUsd?: number; limitUsd?: number; runsOutOn?: string; costPerMergedChangeUsd?: number; mergedCount?: number; month?: string;
  projects?: ProjectSpend[]; people?: PersonSpend[];
}
function readProject(raw: unknown): ProjectSpend | undefined {
  if (!isRecord(raw)) return undefined;
  const name = str(raw["name"]), spent = money(raw["spentUsd"]);
  if (name === undefined || spent === undefined) return undefined;
  return { name, spentUsd: spent, ...opt("heldUsd", money(raw["heldUsd"])), ...opt("limitUsd", money(raw["limitUsd"])), ...opt("taskStopUsd", money(raw["taskStopUsd"])), ...opt("mergedCount", count(raw["mergedCount"])), ...opt("paidFrom", str(raw["paidFrom"])), ...opt("locked", raw["locked"] === true ? true : undefined) };
}
function readPerson(raw: unknown): PersonSpend | undefined {
  if (!isRecord(raw)) return undefined;
  const name = str(raw["name"]), spent = money(raw["spentUsd"]), source = raw["allowanceSource"] === "own" ? "own" as const : raw["allowanceSource"] === "company_default" ? "company_default" as const : undefined;
  if (name === undefined || spent === undefined) return undefined;
  return { name, spentUsd: spent, ...opt("role", str(raw["role"])), ...opt("allowanceUsd", money(raw["allowanceUsd"])), ...opt("allowanceSource", source), ...opt("tasks", count(raw["tasks"])), ...opt("mergedCount", count(raw["mergedCount"])) };
}
export function readOrgSpend(body: unknown): OrgSpendRead {
  if (!isRecord(body)) throw new Error("not a spending summary");
  const projects = Array.isArray(body["byProject"]) ? body["byProject"].flatMap(raw => { const line = readProject(raw); return line === undefined ? [] : [line]; }) : undefined;
  const people = Array.isArray(body["byPerson"]) ? body["byPerson"].flatMap(raw => { const line = readPerson(raw); return line === undefined ? [] : [line]; }) : undefined;
  const remaining = num(body["remainingUsd"]), runsOutOn = str(body["runsOutOn"]);
  return {
    ...opt("spentUsd", money(body["spentThisMonthUsd"] ?? body["spentUsd"])), ...opt("remainingUsd", remaining), ...opt("heldUsd", money(body["heldUsd"])), ...opt("limitUsd", money(body["limitUsd"])),
    ...opt("runsOutOn", runsOutOn !== undefined && !Number.isNaN(Date.parse(runsOutOn)) ? runsOutOn : undefined), ...opt("costPerMergedChangeUsd", money(body["costPerMergedChangeUsd"])), ...opt("mergedCount", count(body["mergedCount"])), ...opt("month", str(body["month"])),
    ...opt("projects", projects), ...opt("people", people),
  };
}

export type SpendState = "unknown" | "no_limit" | "ok" | "near" | "over";
export interface SpendSummary {
  state: SpendState; spentUsd: number | undefined; heldUsd: number | undefined; limitUsd: number | undefined; remainingUsd: number | undefined;
  /** 0 to 1, spent plus held against the limit; undefined without a limit. */
  usedFraction: number | undefined; heldFraction: number | undefined; overUsd: number;
}
/** The share of the limit at which a line is called "near". */
export const NEAR_LIMIT = 0.9;
/**
 * What the page says about the company's month. The limit is, in order: the one Cloud sent, spent plus remaining, the monthly base the budget settings
 * show. `remainingUsd` from Cloud wins over a worked-out one (it is Cloud's own read; a negative one means over).
 */
export function spendSummary(read: OrgSpendRead, monthlyBaseUsd?: number): SpendSummary {
  const spent = read.spentUsd, held = read.heldUsd;
  const limit = read.limitUsd ?? (spent !== undefined && read.remainingUsd !== undefined ? spent + read.remainingUsd : undefined) ?? monthlyBaseUsd;
  const remaining = read.remainingUsd ?? (limit !== undefined && spent !== undefined ? limit - spent : undefined);
  if (spent === undefined && remaining === undefined) return { state: "unknown", spentUsd: undefined, heldUsd: held, limitUsd: limit, remainingUsd: undefined, usedFraction: undefined, heldFraction: undefined, overUsd: 0 };
  if (limit === undefined || limit <= 0) {
    const over = remaining !== undefined && remaining <= 0 && read.remainingUsd !== undefined;
    return { state: over ? "over" : "no_limit", spentUsd: spent, heldUsd: held, limitUsd: limit, remainingUsd: remaining, usedFraction: undefined, heldFraction: undefined, overUsd: over ? Math.max(0, -(remaining ?? 0)) : 0 };
  }
  const used = ((spent ?? limit - (remaining ?? limit)) + (held ?? 0)) / limit;
  const left = remaining ?? limit - (spent ?? 0);
  const state: SpendState = left <= 0 ? "over" : used >= NEAR_LIMIT ? "near" : "ok";
  return { state, spentUsd: spent, heldUsd: held, limitUsd: limit, remainingUsd: remaining, usedFraction: Math.min(1, Math.max(0, used)), heldFraction: held === undefined ? undefined : Math.min(1, Math.max(0, held / limit)), overUsd: left < 0 ? -left : 0 };
}
/** One project's or person's line against its own limit: the same words as the company's. */
export function lineState(spentUsd: number, limitUsd: number | undefined, heldUsd = 0): { state: "none" | "ok" | "near" | "over"; leftUsd: number | undefined; fraction: number | undefined } {
  if (limitUsd === undefined || limitUsd <= 0) return { state: "none", leftUsd: undefined, fraction: undefined };
  const left = limitUsd - spentUsd, fraction = Math.min(1, Math.max(0, (spentUsd + heldUsd) / limitUsd));
  return { state: left <= 0 ? "over" : fraction >= NEAR_LIMIT ? "near" : "ok", leftUsd: left, fraction };
}

// ---- Company settings (Cloud's company backend: GET and PUT /v1/app/org/settings) ----
export const ORG_SETTINGS_PATH = "/v1/app/org/settings";
export interface CompanyRule { text: string; priority: "required" | "preferred" }
export interface PendingChange { changeId: string; proposedBy: string; proposedAt: string; expiresAt: string; instructions: CompanyRule[]; freshSignInSeconds: number | undefined }
/** Cloud's company backend says whether the model gateway will serve the company: it refuses a company with no monthly cap, and Cloud sets no default amount. */
export type GatewayReadiness = { ready: true } | { ready: false; reason: string; message: string };
export function readGatewayReadiness(value: unknown): GatewayReadiness | undefined {
  if (!isRecord(value)) return undefined;
  if (value["ready"] === true) return { ready: true };
  if (value["ready"] === false) { const reason = str(value["reason"]); return reason === undefined ? undefined : { ready: false, reason, message: str(value["message"]) ?? "" }; }
  return undefined;
}
/** The words the page uses for a reason it knows; an unknown reason shows Cloud's own message. */
export const GATEWAY_CAP_UNSET = "company_monthly_cap_unset";
export const GATEWAY_CAP_WORDS = "Set a monthly cap to use the model gateway.";
/** `GET /v1/app/org/settings` read only for its readiness; undefined when Cloud has no company settings or does not say. */
export function readSettingsReadiness(body: unknown): GatewayReadiness | undefined { return isRecord(body) ? readGatewayReadiness(body["modelGateway"]) : undefined; }
/** A company cap typed as dollars: "" is no cap, up to two decimals, at most $1,000,000. undefined is "not an amount". */
export function capToMicros(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d{1,7}(?:\.\d{1,2})?$/u.test(t)) return undefined;
  const micros = Math.round(Number(t) * 1_000_000);
  return micros <= 1_000_000_000_000 ? micros : undefined;
}
export interface CompanySettingsRead {
  /** Whether the model gateway will serve the company (absent when Cloud does not say). */
  modelGateway: GatewayReadiness | undefined;
  /** The company's monthly cap in dollars; null when none is set, undefined when Cloud did not send budgets. */
  monthlyCapUsd: number | null | undefined;
  version: number; instructions: CompanyRule[]; freshSignInSeconds: number | undefined; websites: { mode: "any" } | { mode: "listed"; hosts: string[] } | undefined;
  start: { allow: boolean; maxEstimateUsd: number | undefined } | undefined; pending: PendingChange | undefined;
  /** The whole settings document as read, so an edit sends back everything it did not change. */
  raw: Record<string, unknown>;
}
const MICROS = 1_000_000;
function readRules(value: unknown): CompanyRule[] {
  return Array.isArray(value) ? value.flatMap(raw => (isRecord(raw) && typeof raw["text"] === "string" && (raw["priority"] === "required" || raw["priority"] === "preferred") ? [{ text: raw["text"], priority: raw["priority"] }] : [])) : [];
}
export function readCompanySettings(body: unknown): CompanySettingsRead {
  if (!isRecord(body) || !isRecord(body["settings"])) throw new Error("not company settings");
  const version = count(body["version"]), settings = body["settings"];
  if (version === undefined) throw new Error("not company settings");
  const ceiling = settings["websiteCeiling"], start = settings["start"], pending = body["pending"];
  const hosts = isRecord(ceiling) && Array.isArray(ceiling["hosts"]) ? ceiling["hosts"].filter((host): host is string => typeof host === "string") : [];
  const maxEstimate = isRecord(start) ? num(start["maxEstimateUsdMicros"]) : undefined;
  const pendingSettings = isRecord(pending) && isRecord(pending["settings"]) ? pending["settings"] : undefined;
  const budgets = settings["budgets"], capMicros = isRecord(budgets) ? budgets["companyMonthlyUsdMicros"] : undefined;
  return {
    modelGateway: readGatewayReadiness(body["modelGateway"]),
    monthlyCapUsd: capMicros === null ? null : typeof capMicros === "number" && Number.isFinite(capMicros) && capMicros >= 0 ? capMicros / MICROS : undefined,
    version, instructions: readRules(settings["instructions"]), freshSignInSeconds: count(settings["freshSignInSeconds"]),
    websites: isRecord(ceiling) ? (ceiling["mode"] === "listed" ? { mode: "listed", hosts } : ceiling["mode"] === "any" ? { mode: "any" } : undefined) : undefined,
    start: isRecord(start) && typeof start["allow"] === "boolean" ? { allow: start["allow"], maxEstimateUsd: maxEstimate === undefined ? undefined : maxEstimate / MICROS } : undefined,
    pending: isRecord(pending) && pendingSettings !== undefined && str(pending["changeId"]) !== undefined && str(pending["proposedBy"]) !== undefined
      ? { changeId: str(pending["changeId"])!, proposedBy: str(pending["proposedBy"])!, proposedAt: str(pending["proposedAt"]) ?? "", expiresAt: str(pending["expiresAt"]) ?? "", instructions: readRules(pendingSettings["instructions"]), freshSignInSeconds: count(pendingSettings["freshSignInSeconds"]) }
      : undefined,
    raw: settings,
  };
}
/** The approval window in words: an admin must have confirmed it is them within this long to change the company's rules. */
export function windowWords(seconds: number | undefined): string {
  if (seconds === undefined) return "Not set";
  if (seconds % 60 === 0) return seconds / 60 === 1 ? "1 minute" : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}
export const WINDOW_CHOICES: ReadonlyArray<{ seconds: number; label: string }> = [60, 120, 300, 600].map(seconds => ({ seconds, label: windowWords(seconds) }));

// ---- Sign-in factors (Code's step-up factor: a confirmation email and passkeys) ----
// Proposed Cloud routes, passed through to Code's sign-in service once it serves them (it answers 501 until then, and the page says "not connected yet"):
//   GET    /v1/app/me/sign-in-factors                      -> { factorEmail?: string (masked), passkeys: [{ credentialId, createdAt, lastUsedAt? }] }
//   DELETE /v1/app/me/passkeys/{credentialId}              (fresh step-up)
//   PUT    /v1/app/org/members/{developerId}/factor-email  { requestId, email }  (an admin's own fresh step-up; the old address is told first)
//   DELETE /v1/app/org/members/{developerId}/passkeys      (an admin's own fresh step-up; the person is told)
export const MY_FACTORS_PATH = "/v1/app/me/sign-in-factors";
export interface Passkey { credentialId: string; createdAt: string; lastUsedAt?: string }
export interface MyFactors { factorEmail: string | undefined; passkeys: Passkey[] }
export function readMyFactors(body: unknown): MyFactors {
  if (!isRecord(body) || !Array.isArray(body["passkeys"])) throw new Error("not sign-in factors");
  const passkeys = body["passkeys"].flatMap(raw => {
    if (!isRecord(raw)) return [];
    const credentialId = str(raw["credentialId"]), createdAt = str(raw["createdAt"]);
    return credentialId === undefined || createdAt === undefined || Number.isNaN(Date.parse(createdAt)) ? [] : [{ credentialId, createdAt, ...opt("lastUsedAt", str(raw["lastUsedAt"])) }];
  });
  return { factorEmail: str(body["factorEmail"]), passkeys };
}
export const passkeyPath = (credentialId: string) => "/v1/app/me/passkeys/" + encodeURIComponent(credentialId);
export const memberFactorEmailPath = (developerId: string) => "/v1/app/org/members/" + encodeURIComponent(developerId) + "/factor-email";
export const memberPasskeysPath = (developerId: string) => "/v1/app/org/members/" + encodeURIComponent(developerId) + "/passkeys";

// ---- Sign-in clients (Code's per-company sign-in clients, DEC 136) ----
// Proposed: GET /v1/app/org/sign-in-clients -> { clients: [{ clientId, name, kind, createdAt, lastUsedAt? }] }. Read only here; changing a client is Code's.
export const SIGN_IN_CLIENTS_PATH = "/v1/app/org/sign-in-clients";
export interface SignInClient { clientId: string; name: string; kind: string; createdAt?: string; lastUsedAt?: string }
export function readSignInClients(body: unknown): SignInClient[] {
  if (!isRecord(body) || !Array.isArray(body["clients"])) throw new Error("not sign-in clients");
  return body["clients"].flatMap(raw => {
    if (!isRecord(raw)) return [];
    const clientId = str(raw["clientId"]), name = str(raw["name"]);
    return clientId === undefined || name === undefined ? [] : [{ clientId, name, kind: str(raw["kind"]) ?? "other", ...opt("createdAt", str(raw["createdAt"])), ...opt("lastUsedAt", str(raw["lastUsedAt"])) }];
  });
}
