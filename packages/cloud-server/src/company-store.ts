// Cloud's company data (migration plan v3.2, 2.2 and 2.4, decision 17): per company, its settings and rules, a settings change waiting
// for a second admin, its profile (name, plan) and its invites; and the policy hook's install allow-list (which Code installs may ask
// about which companies). Members, company roles and pre-approved emails live in Code; Cloud never keeps a member list.
//
// Every record carries its company, every read checks it, and nothing is ever addressed by an id alone across companies: an invite's
// bearer token finds the invite, and the route then checks the invite's company against the person's. `LocalCompanyStore` (memory) and
// `DynamoCompanyStore` (company-dynamo.ts) meet the same tests (tests/unit/company-store.test.ts).
import { POLICY_HOOK_PATTERNS, type CompanyRules, type CompanyRulesReader, type PolicyHookInstalls, type PublicJwk } from "./policy-hook.js";
import { defaultCompanySettings, hookRulesOf, plainObject, validateCompanySettings, type CompanyBudgets, type CompanySettings } from "./company-settings.js";

export const COMPANY_ID = POLICY_HOOK_PATTERNS.OrgId;

/** A write that lost to another (a version, a revision or a state changed since it was read; a request id already used). */
export class CompanyStoreConflict extends Error {
  constructor(readonly what: string) {
    super(`${what} changed since it was read`);
  }
}

export interface StoredSettings { companyId: string; settings: unknown; version: number; updatedAt?: string; updatedBy?: string }
export interface PendingSettingsChange {
  companyId: string;
  changeId: string;
  /** The whole document the change would write. */
  settings: CompanySettings;
  /** The settings version it was proposed on: it applies only on that version. */
  baseVersion: number;
  proposedBy: string;
  proposedAt: string;
  expiresAt: string;
}
export interface CompanyProfile { companyId: string; name: string; plan: string; version: number; updatedAt?: string; updatedBy?: string }
/** `unconfirmed`: stored, Code not yet told. `revoking`: Code is being told to drop it. Only `pending` invites can be accepted. */
export type InviteState = "unconfirmed" | "pending" | "revoking" | "accepted" | "revoked";
export interface InviteRecord {
  companyId: string;
  inviteId: string;
  requestId: string;
  role: "admin" | "member";
  /** Lower case. Code is told it is pre-approved; the app only ever sees it masked. */
  email: string;
  /** sha256 (hex) of the bearer token in the invite link; the token itself is never stored. */
  tokenHash: string;
  /**
   * True when the link's token is Code's single-use invite secret (DEC 254h; `tokenHash` is its SHA-256): the join sends it to Code's sign-in.
   * Absent: Cloud's own token, from a Code that mints no secret (the join sends only the company, and Code checks the email).
   */
  codeSecret?: true;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  state: InviteState;
  revision: number;
  revokedAt?: string;
  acceptedAt?: string;
  acceptedBy?: string;
  /** The company's name when the invite was made, for the join page ("Join <company> on Rovara"). An older invite has none. */
  companyName?: string;
}
/** A Code install the policy hook answers: its pinned public keys (at most two, for rotation) and the companies it may ask about. */
/**
 * DEC 240: which AI the company's agents use ("AI for your agents"). The model gateway reads the same item (model-gateway agent-ai.ts):
 * "rovara" is Rovara's AI (charged per use), "anthropic_key" the company's own Anthropic key, "bedrock_byo" its own Bedrock (reserved:
 * the routes refuse it until DEC 238 is built). No saved choice: the gateway's company-key mode as before.
 */
export const AGENT_AI_SOURCES = ["rovara", "anthropic_key", "bedrock_byo"] as const;
export type AgentAiSource = (typeof AGENT_AI_SOURCES)[number];
export interface AgentAiChoice { companyId: string; source: AgentAiSource; version: number; updatedAt: string; updatedBy: string }
export const validAgentAiSource = (value: unknown): value is AgentAiSource => typeof value === "string" && (AGENT_AI_SOURCES as readonly string[]).includes(value);

/**
 * Lead 3 B1 (DEC 254t b): a monthly limit of its own for one project or one person, over the company default (`settings.budgets`). One item
 * per override in the Companies table (`SPEND_LIMIT#PROJECT#<project>` / `SPEND_LIMIT#PERSON#<developer id>` under the company); the model
 * gateway reads the same item on every call (model-gateway company-caps.ts; deploy.ts GATEWAY_COMPANY_SPEND_LIMITS; a contract test holds the
 * two together). Amounts are whole micro-dollars, never null (no override is how a company default applies).
 */

/**
 * What a limit can be about (`scope`): the id's format, which the routes check against Code (a project Code knows, a person it lists in the company)
 * and the gateway checks against its token's own formats. `idSource` is the pattern without anchors (the route paths are built from it).
 */
export const SPEND_LIMIT_SCOPES = {
  project: { idSource: "[a-z][a-z0-9-]{0,62}", id: /^[a-z][a-z0-9-]{0,62}$/u },
  person: { idSource: "[a-f0-9]{64}", id: /^[a-f0-9]{64}$/u },
} as const;
export type SpendLimitScope = keyof typeof SPEND_LIMIT_SCOPES;

/** One kind of limit. Everything a kind needs on Cloud's side is here; the gateway's own table (deploy.ts GATEWAY_COMPANY_SPEND_LIMITS) repeats `kind`, `scope` and `sortPrefix`. */
export interface SpendLimitKindDef {
  /** The name stored in the item's `kind` and used in audit subjects. */
  kind: string;
  scope: SpendLimitScope;
  /** The item's sort key is this followed by the id. No kind's prefix may begin with another's (a test walks the table). */
  sortPrefix: string;
  /** The members of `GET /org/spend-limits` that list this kind's items and give its bound, and the path segment `PUT /org/spend-limits/<segment>/<id>` takes. */
  listKey: string;
  segment: string;
  /** The most overrides of this kind a company may keep. */
  max: number;
  /** What applies when there is no override: the company default for this kind (null: no limit). */
  defaultOf(budgets: CompanyBudgets): number | null;
}
/**
 * THE table of limit kinds. The key builder, the validation, the store, the routes and the page's rows all come from it. To add a kind: one entry here, one in the
 * gateway's table (deploy.ts), and the point that enforces it (see docs/model-gateway-spend-limits.md, "Adding a kind"). tests/unit/spend-limits-routes.test.ts and
 * tests/contract/model-gateway-spend-limits.test.ts walk every entry.
 */
export const SPEND_LIMIT_KINDS = [
  { kind: "project_month", scope: "project", sortPrefix: "SPEND_LIMIT#PROJECT#", listKey: "projects", segment: "projects", max: 200, defaultOf: (budgets) => budgets.projectMonthlyUsdMicros },
  { kind: "person_month", scope: "person", sortPrefix: "SPEND_LIMIT#PERSON#", listKey: "people", segment: "people", max: 200, defaultOf: (budgets) => budgets.memberMonthlyUsdMicros },
] as const satisfies readonly SpendLimitKindDef[];
export type SpendLimitKind = (typeof SPEND_LIMIT_KINDS)[number]["kind"];
const KIND_DEFS: readonly SpendLimitKindDef[] = SPEND_LIMIT_KINDS;
/** The table's entry for a kind. */
export const spendLimitDef = (kind: SpendLimitKind): SpendLimitKindDef => KIND_DEFS.find((def) => def.kind === kind)!;
export interface SpendLimit { companyId: string; kind: SpendLimitKind; id: string; monthlyUsdMicros: number; version: number; updatedAt: string; updatedBy: string }
/** The sort-key prefix and the id format of each kind (from the table). */
export const SPEND_LIMIT_SORT_PREFIX = Object.freeze(Object.fromEntries(KIND_DEFS.map((def) => [def.kind, def.sortPrefix]))) as Readonly<Record<SpendLimitKind, string>>;
export const SPEND_LIMIT_ID = Object.freeze(Object.fromEntries(KIND_DEFS.map((def) => [def.kind, SPEND_LIMIT_SCOPES[def.scope].id]))) as Readonly<Record<SpendLimitKind, RegExp>>;
/** Overrides a company may keep of each kind; a read lists at most this many (and says when there were more). */
export const SPEND_LIMITS_MAX = Object.freeze(Object.fromEntries(KIND_DEFS.map((def) => [def.kind, def.max]))) as Readonly<Record<SpendLimitKind, number>>;
/** The company's overrides by kind, and whether any kind had more than its bound. */
export interface SpendLimitList { limits: Record<SpendLimitKind, SpendLimit[]>; partial: boolean }
/** The most one override may be: the backend's own ceiling for a budget ($1,000,000), as the gateway reads it. */
export const SPEND_LIMIT_MICROS_MAX = 1_000_000_000_000;
/** What a write was decided against: the override as read (its version and amount; none = absent) and the settings version the default came from. */
export interface SpendLimitBasis { override: { version: number; monthlyUsdMicros: number } | undefined; settingsVersion: number }
export const validSpendLimit = (value: unknown, companyId: string, kind: SpendLimitKind, id: string): value is SpendLimit => {
  const v = value as Partial<SpendLimit> | null | undefined;
  return v !== null && typeof v === "object" && v.companyId === companyId && v.kind === kind && v.id === id
    && typeof v.monthlyUsdMicros === "number" && Number.isSafeInteger(v.monthlyUsdMicros) && v.monthlyUsdMicros >= 0 && v.monthlyUsdMicros <= SPEND_LIMIT_MICROS_MAX
    && typeof v.version === "number" && Number.isSafeInteger(v.version) && v.version >= 1 && typeof v.updatedAt === "string" && typeof v.updatedBy === "string";
};

export interface HookInstall { issuer: string; keys: PublicJwk[]; companyIds: string[]; updatedAt: string }

/** confirmInvite's arguments: one unconfirmed invite and itself, pending, under its new token hash (nothing else may move). */
export function sameInvite(unconfirmed: InviteRecord, confirmed: InviteRecord): void {
  if (unconfirmed.state !== "unconfirmed" || confirmed.state !== "pending" || confirmed.companyId !== unconfirmed.companyId || confirmed.inviteId !== unconfirmed.inviteId
    || confirmed.requestId !== unconfirmed.requestId || !/^[a-f0-9]{64}$/u.test(confirmed.tokenHash)) throw new Error("confirmInvite takes one unconfirmed invite and itself, pending");
}

export const PENDING_CHANGE_DAYS = 7;
export const INVITE_DAYS = 7;
/** Invites a company may have open (unconfirmed, pending or revoking, not expired) at once. */
export const OPEN_INVITES_MAX = 100;
/** Invite records read per company list; more and the list says it is partial. */
export const INVITES_READ_MAX = 2_000;
export const HOOK_INSTALL_COMPANIES_MAX = 500;

export interface CompanyStore {
  /** The company's saved settings as stored (the caller validates), or undefined when none were saved. */
  settings(companyId: string): Promise<StoredSettings | undefined>;
  /** Saves settings at `expectedVersion + 1`; `expectedVersion` 0 means none saved yet. Throws CompanyStoreConflict. */
  putSettings(companyId: string, settings: CompanySettings, expectedVersion: number, by: string, at: string): Promise<number>;
  /** The change waiting for a second admin, unless it expired. */
  pendingChange(companyId: string, nowMs: number): Promise<PendingSettingsChange | undefined>;
  /** Throws CompanyStoreConflict when a live change is already waiting. */
  proposeChange(change: PendingSettingsChange, nowMs: number): Promise<void>;
  /** Drops the waiting change if it is still `changeId`. False when it isn't. */
  dropChange(companyId: string, changeId: string): Promise<boolean>;
  /** In one write: drops the waiting change (still `change.changeId`) and saves its settings at `baseVersion + 1`. Throws CompanyStoreConflict. */
  applyChange(change: PendingSettingsChange, by: string, at: string): Promise<number>;
  profile(companyId: string): Promise<CompanyProfile | undefined>;
  /** Saves at `expectedVersion + 1` (0: none saved yet). Throws CompanyStoreConflict. */
  putProfile(profile: Omit<CompanyProfile, "version">, expectedVersion: number): Promise<number>;
  /** Stores a new invite with its request id and token. Throws CompanyStoreConflict when the request id (or invite id) was used. */
  createInvite(invite: InviteRecord): Promise<void>;
  invite(companyId: string, inviteId: string): Promise<InviteRecord | undefined>;
  inviteByRequest(companyId: string, requestId: string): Promise<InviteRecord | undefined>;
  /** The invite a token's hash names, with its company: the caller checks that company. */
  inviteByToken(tokenHash: string): Promise<InviteRecord | undefined>;
  /** The company's invites, newest first; `partial` when there were more than INVITES_READ_MAX. */
  invites(companyId: string): Promise<{ invites: InviteRecord[]; partial: boolean }>;
  /** Writes `next` if the stored invite still has `expected` revision and state. Throws CompanyStoreConflict. */
  updateInvite(next: InviteRecord, expected: { revision: number; state: InviteState }): Promise<void>;
  /**
   * Makes an unconfirmed invite usable under the link token Code minted (DEC 254h), in one write: `confirmed` (the same invite, now pending, its
   * `tokenHash` the new token's) replaces `unconfirmed` and the token row moves to the new hash. Throws CompanyStoreConflict when the stored
   * invite isn't `unconfirmed` at its revision, or another invite holds the new hash.
   */
  confirmInvite(unconfirmed: InviteRecord, confirmed: InviteRecord): Promise<void>;
  /** Removes an unconfirmed invite (Code never took it), with its request id and token. */
  removeInvite(invite: InviteRecord): Promise<void>;
  /** The company's agent AI choice (DEC 240), or undefined when none was saved or the row does not read as this company's. */
  agentAi(companyId: string): Promise<AgentAiChoice | undefined>;
  /** Saves the choice at `expectedVersion + 1` (0: none saved yet). Throws CompanyStoreConflict. */
  putAgentAi(choice: Omit<AgentAiChoice, "version">, expectedVersion: number): Promise<number>;
  /** One override, or undefined when none is saved. An item that does not read as exactly this company's, kind's and id's THROWS (an outage, never "none saved"). */
  spendLimit(companyId: string, kind: SpendLimitKind, id: string): Promise<SpendLimit | undefined>;
  /** The company's overrides, each kind at most SPEND_LIMITS_MAX (`partial` when there were more). Throws when any item does not read. */
  spendLimits(companyId: string): Promise<SpendLimitList>;
  /**
   * Saves the override at `basis.override.version + 1` (version 1 when there is none), only while it is still exactly `basis.override` AND the
   * company settings are still at `basis.settingsVersion` (the default the change was judged against). Throws CompanyStoreConflict.
   */
  putSpendLimit(limit: Omit<SpendLimit, "version">, basis: SpendLimitBasis): Promise<number>;
  /** Removes the override, under the same two conditions. `basis.override` must be present. Throws CompanyStoreConflict. */
  removeSpendLimit(companyId: string, kind: SpendLimitKind, id: string, basis: SpendLimitBasis): Promise<void>;
  hookInstall(issuer: string): Promise<HookInstall | undefined>;
  /** An install operator's change (no app route writes this). Throws on an install that does not read. */
  putHookInstall(install: HookInstall): Promise<void>;
  removeHookInstall(issuer: string): Promise<void>;
  /**
   * The one-trial-per-GitHub-account rule (`github=trial_used`; guided onboarding PR 2): the first company a GitHub account connects GitHub for
   * holds that account's trial, written once and never overwritten. "claimed" (now), "held" (this company already held it), "other" (another
   * company holds it). The GitHub user id is Code's checked answer (the claim's `githubUser.id`), never anything the browser sent.
   */
  claimGithubTrial(githubUserId: number, companyId: string, at: string): Promise<GithubTrialClaim>;
}

export type GithubTrialClaim = "claimed" | "held" | "other";
/** A GitHub user id as GitHub numbers them. */
export const validGithubUserId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isoTime = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) && Number.isFinite(Date.parse(value));
const B64URL = /^[A-Za-z0-9_-]+$/u;

/** Whether a stored or given install reads: an https issuer, one or two RSA keys of 2048 bits or more, and its companies. */
export function validHookInstall(value: unknown): value is HookInstall {
  if (!plainObject(value) || Object.keys(value).sort().join(",") !== "companyIds,issuer,keys,updatedAt") return false;
  const { issuer, keys, companyIds, updatedAt } = value;
  if (typeof issuer !== "string" || !POLICY_HOOK_PATTERNS.Issuer.test(issuer) || !isoTime(updatedAt)) return false;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 2) return false;
  const kids = new Set<string>();
  for (const key of keys) {
    if (!plainObject(key) || !Object.keys(key).every((name) => ["kty", "n", "e", "kid", "alg", "use"].includes(name))) return false;
    if (key["kty"] !== "RSA" || typeof key["kid"] !== "string" || !POLICY_HOOK_PATTERNS.Kid.test(key["kid"]) || kids.has(key["kid"])) return false;
    // 2048 bits is 256 bytes, 342 base64url characters.
    if (typeof key["n"] !== "string" || !B64URL.test(key["n"]) || key["n"].length < 342 || key["n"].length > 1366 || typeof key["e"] !== "string" || !B64URL.test(key["e"]) || key["e"].length > 8) return false;
    if ((key["alg"] !== undefined && key["alg"] !== "RS256") || (key["use"] !== undefined && key["use"] !== "sig")) return false;
    kids.add(key["kid"]);
  }
  if (!Array.isArray(companyIds) || companyIds.length < 1 || companyIds.length > HOOK_INSTALL_COMPANIES_MAX) return false;
  return companyIds.every((id) => typeof id === "string" && COMPANY_ID.test(id)) && new Set(companyIds).size === companyIds.length;
}

/** The settings a company works under: saved and readable, the defaults when none were saved, undefined when the saved row does not read. */
export async function companySettings(store: CompanyStore, companyId: string): Promise<{ settings: CompanySettings; version: number; updatedAt?: string; updatedBy?: string } | undefined> {
  const stored = await store.settings(companyId);
  if (stored === undefined) return { settings: defaultCompanySettings(), version: 0 };
  if (stored.companyId !== companyId) return undefined;
  const read = validateCompanySettings(stored.settings);
  if (!read.ok) return undefined;
  return { settings: read.settings, version: stored.version, ...(stored.updatedAt === undefined ? {} : { updatedAt: stored.updatedAt }), ...(stored.updatedBy === undefined ? {} : { updatedBy: stored.updatedBy }) };
}

/**
 * The policy hook's rules reader over the store. The hook asks only about a company on the asking install's allow-list, so a company
 * with no saved settings answers the defaults; a saved row that does not read answers undefined, which the hook turns into a refusal.
 */
export class StoreCompanyRules implements CompanyRulesReader {
  constructor(private readonly store: CompanyStore) {}
  async read(companyId: string): Promise<CompanyRules | undefined> {
    if (!COMPANY_ID.test(companyId)) return undefined;
    const current = await companySettings(this.store, companyId);
    return current === undefined ? undefined : hookRulesOf(current.settings);
  }
}

/** The policy hook's install allow-list over the store. An install that does not read is unknown, so every question from it is refused. */
export class StoreHookInstalls implements PolicyHookInstalls {
  constructor(private readonly store: CompanyStore) {}
  async keysFor(issuer: string): Promise<{ keys: readonly PublicJwk[]; companyIds: readonly string[] } | undefined> {
    const install = await this.store.hookInstall(issuer);
    if (install === undefined || !validHookInstall(install) || install.issuer !== issuer) return undefined;
    return { keys: install.keys, companyIds: install.companyIds };
  }
}

const copy = <T>(value: T): T => structuredClone(value);
const liveChange = (change: PendingSettingsChange | undefined, nowMs: number) => (change !== undefined && Date.parse(change.expiresAt) > nowMs ? change : undefined);

/** Company data in this server's memory (tests, `cloud:local`). */
export class LocalCompanyStore implements CompanyStore {
  private readonly settingsOf = new Map<string, StoredSettings>();
  private readonly pendingOf = new Map<string, PendingSettingsChange>();
  private readonly profiles = new Map<string, CompanyProfile>();
  private readonly invitesOf = new Map<string, Map<string, InviteRecord>>();
  private readonly requests = new Map<string, string>();
  private readonly tokens = new Map<string, { companyId: string; inviteId: string }>();
  private readonly installs = new Map<string, HookInstall>();
  private readonly agentAiOf = new Map<string, AgentAiChoice>();
  private readonly githubTrials = new Map<number, string>();

  async claimGithubTrial(githubUserId: number, companyId: string): Promise<GithubTrialClaim> {
    if (!validGithubUserId(githubUserId) || !COMPANY_ID.test(companyId)) throw new Error("the GitHub trial claim does not read");
    const holder = this.githubTrials.get(githubUserId);
    if (holder === undefined) { this.githubTrials.set(githubUserId, companyId); return "claimed"; }
    return holder === companyId ? "held" : "other";
  }

  private readonly spendLimitsOf = new Map<string, SpendLimit>();
  /** Rows a test or operator damaged by hand (see `corruptSpendLimit`): they read as an outage, as a damaged item does in DynamoDB. */
  private readonly spendLimitDamaged = new Set<string>();

  private static limitKey(companyId: string, kind: SpendLimitKind, id: string) { return `${companyId}\u0000${kind}\u0000${id}`; }

  /** Tests only: makes one stored override unreadable. */
  corruptSpendLimit(companyId: string, kind: SpendLimitKind, id: string) { this.spendLimitDamaged.add(LocalCompanyStore.limitKey(companyId, kind, id)); }

  async spendLimit(companyId: string, kind: SpendLimitKind, id: string) {
    const key = LocalCompanyStore.limitKey(companyId, kind, id);
    const stored = this.spendLimitsOf.get(key);
    if (stored === undefined) return undefined;
    if (this.spendLimitDamaged.has(key) || !validSpendLimit(stored, companyId, kind, id)) throw new Error("spend limit unreadable");
    return copy(stored);
  }

  async spendLimits(companyId: string): Promise<SpendLimitList> {
    const found: SpendLimit[] = [];
    for (const [key, stored] of this.spendLimitsOf) {
      const [owner, kind, id] = key.split("\u0000") as [string, SpendLimitKind, string];
      if (owner !== companyId) continue;
      if (this.spendLimitDamaged.has(key) || !validSpendLimit(stored, companyId, kind, id)) throw new Error("spend limit unreadable");
      found.push(copy(stored));
    }
    const limits = {} as Record<SpendLimitKind, SpendLimit[]>;
    let partial = false;
    for (const def of KIND_DEFS) {
      const of = found.filter((l) => l.kind === def.kind).sort((a, b) => a.id.localeCompare(b.id));
      limits[def.kind as SpendLimitKind] = of.slice(0, def.max);
      if (of.length > def.max) partial = true;
    }
    return { limits, partial };
  }

  private spendBasisHolds(companyId: string, key: string, basis: SpendLimitBasis) {
    const stored = this.spendLimitsOf.get(key);
    const same = basis.override === undefined ? stored === undefined : stored !== undefined && stored.version === basis.override.version && stored.monthlyUsdMicros === basis.override.monthlyUsdMicros;
    return same && (this.settingsOf.get(companyId)?.version ?? 0) === basis.settingsVersion;
  }

  async putSpendLimit(limit: Omit<SpendLimit, "version">, basis: SpendLimitBasis) {
    const key = LocalCompanyStore.limitKey(limit.companyId, limit.kind, limit.id);
    if (!this.spendBasisHolds(limit.companyId, key, basis)) throw new CompanyStoreConflict("spend limit");
    const version = (basis.override?.version ?? 0) + 1;
    this.spendLimitsOf.set(key, { ...copy(limit), version });
    this.spendLimitDamaged.delete(key);
    return version;
  }

  async removeSpendLimit(companyId: string, kind: SpendLimitKind, id: string, basis: SpendLimitBasis) {
    const key = LocalCompanyStore.limitKey(companyId, kind, id);
    if (basis.override === undefined || !this.spendBasisHolds(companyId, key, basis)) throw new CompanyStoreConflict("spend limit");
    this.spendLimitsOf.delete(key);
    this.spendLimitDamaged.delete(key);
  }

  async agentAi(companyId: string) { const choice = this.agentAiOf.get(companyId); return choice === undefined ? undefined : copy(choice); }

  async putAgentAi(choice: Omit<AgentAiChoice, "version">, expectedVersion: number) {
    if ((this.agentAiOf.get(choice.companyId)?.version ?? 0) !== expectedVersion) throw new CompanyStoreConflict("agent ai");
    this.agentAiOf.set(choice.companyId, { ...copy(choice), version: expectedVersion + 1 });
    return expectedVersion + 1;
  }

  async settings(companyId: string) { const stored = this.settingsOf.get(companyId); return stored === undefined ? undefined : copy(stored); }

  async putSettings(companyId: string, settings: CompanySettings, expectedVersion: number, by: string, at: string) {
    if ((this.settingsOf.get(companyId)?.version ?? 0) !== expectedVersion) throw new CompanyStoreConflict("settings");
    this.settingsOf.set(companyId, { companyId, settings: copy(settings), version: expectedVersion + 1, updatedAt: at, updatedBy: by });
    return expectedVersion + 1;
  }

  async pendingChange(companyId: string, nowMs: number) { const change = liveChange(this.pendingOf.get(companyId), nowMs); return change === undefined ? undefined : copy(change); }

  async proposeChange(change: PendingSettingsChange, nowMs: number) {
    if (liveChange(this.pendingOf.get(change.companyId), nowMs) !== undefined) throw new CompanyStoreConflict("pending change");
    this.pendingOf.set(change.companyId, copy(change));
  }

  async dropChange(companyId: string, changeId: string) {
    if (this.pendingOf.get(companyId)?.changeId !== changeId) return false;
    this.pendingOf.delete(companyId);
    return true;
  }

  async applyChange(change: PendingSettingsChange, by: string, at: string) {
    if (this.pendingOf.get(change.companyId)?.changeId !== change.changeId || (this.settingsOf.get(change.companyId)?.version ?? 0) !== change.baseVersion) throw new CompanyStoreConflict("settings");
    this.pendingOf.delete(change.companyId);
    this.settingsOf.set(change.companyId, { companyId: change.companyId, settings: copy(change.settings), version: change.baseVersion + 1, updatedAt: at, updatedBy: by });
    return change.baseVersion + 1;
  }

  async profile(companyId: string) { const profile = this.profiles.get(companyId); return profile === undefined ? undefined : copy(profile); }

  async putProfile(profile: Omit<CompanyProfile, "version">, expectedVersion: number) {
    if ((this.profiles.get(profile.companyId)?.version ?? 0) !== expectedVersion) throw new CompanyStoreConflict("profile");
    this.profiles.set(profile.companyId, { ...copy(profile), version: expectedVersion + 1 });
    return expectedVersion + 1;
  }

  async createInvite(invite: InviteRecord) {
    const requestKey = `${invite.companyId}\u0000${invite.requestId}`;
    const company = this.invitesOf.get(invite.companyId) ?? new Map<string, InviteRecord>();
    if (this.requests.has(requestKey) || company.has(invite.inviteId) || this.tokens.has(invite.tokenHash)) throw new CompanyStoreConflict("invite request");
    company.set(invite.inviteId, copy(invite));
    this.invitesOf.set(invite.companyId, company);
    this.requests.set(requestKey, invite.inviteId);
    this.tokens.set(invite.tokenHash, { companyId: invite.companyId, inviteId: invite.inviteId });
  }

  async invite(companyId: string, inviteId: string) { const invite = this.invitesOf.get(companyId)?.get(inviteId); return invite === undefined ? undefined : copy(invite); }

  async inviteByRequest(companyId: string, requestId: string) {
    const inviteId = this.requests.get(`${companyId}\u0000${requestId}`);
    return inviteId === undefined ? undefined : this.invite(companyId, inviteId);
  }

  async inviteByToken(tokenHash: string) {
    const found = this.tokens.get(tokenHash);
    return found === undefined ? undefined : this.invite(found.companyId, found.inviteId);
  }

  async invites(companyId: string) {
    const all = [...(this.invitesOf.get(companyId)?.values() ?? [])].sort((a, b) => (a.createdAt === b.createdAt ? b.inviteId.localeCompare(a.inviteId) : b.createdAt.localeCompare(a.createdAt)));
    return { invites: all.slice(0, INVITES_READ_MAX).map(copy), partial: all.length > INVITES_READ_MAX };
  }

  async updateInvite(next: InviteRecord, expected: { revision: number; state: InviteState }) {
    const company = this.invitesOf.get(next.companyId);
    const stored = company?.get(next.inviteId);
    if (company === undefined || stored === undefined || stored.revision !== expected.revision || stored.state !== expected.state) throw new CompanyStoreConflict("invite");
    company.set(next.inviteId, copy(next));
  }

  async confirmInvite(unconfirmed: InviteRecord, confirmed: InviteRecord) {
    sameInvite(unconfirmed, confirmed);
    const company = this.invitesOf.get(unconfirmed.companyId);
    const stored = company?.get(unconfirmed.inviteId);
    if (company === undefined || stored === undefined || stored.revision !== unconfirmed.revision || stored.state !== "unconfirmed" || stored.tokenHash !== unconfirmed.tokenHash) throw new CompanyStoreConflict("invite");
    if (confirmed.tokenHash !== unconfirmed.tokenHash && this.tokens.has(confirmed.tokenHash)) throw new CompanyStoreConflict("invite token");
    company.set(confirmed.inviteId, copy(confirmed));
    this.tokens.delete(unconfirmed.tokenHash);
    this.tokens.set(confirmed.tokenHash, { companyId: confirmed.companyId, inviteId: confirmed.inviteId });
  }

  async removeInvite(invite: InviteRecord) {
    const stored = this.invitesOf.get(invite.companyId)?.get(invite.inviteId);
    if (stored === undefined || stored.state !== "unconfirmed") return;
    this.invitesOf.get(invite.companyId)!.delete(invite.inviteId);
    this.requests.delete(`${invite.companyId}\u0000${invite.requestId}`);
    this.tokens.delete(invite.tokenHash);
  }

  async hookInstall(issuer: string) { const install = this.installs.get(issuer); return install === undefined ? undefined : copy(install); }

  async putHookInstall(install: HookInstall) {
    if (!validHookInstall(install)) throw new Error("the install does not read");
    this.installs.set(install.issuer, copy(install));
  }

  async removeHookInstall(issuer: string) { this.installs.delete(issuer); }
}
