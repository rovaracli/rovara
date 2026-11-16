// Cloud's company data (migration plan v3.2, 2.2 and 2.4, decision 17): per company, its settings and rules, a settings change waiting
// for a second admin, its profile (name, plan) and its invites; and the policy hook's install allow-list (which Code installs may ask
// about which companies). Members, company roles and pre-approved emails live in Code; Cloud never keeps a member list.
//
// Every record carries its company, every read checks it, and nothing is ever addressed by an id alone across companies: an invite's
// bearer token finds the invite, and the route then checks the invite's company against the person's. `LocalCompanyStore` (memory) and
// `DynamoCompanyStore` (company-dynamo.ts) meet the same tests (tests/unit/company-store.test.ts).
import { POLICY_HOOK_PATTERNS, type CompanyRules, type CompanyRulesReader, type PolicyHookInstalls, type PublicJwk } from "./policy-hook.js";
import { defaultCompanySettings, hookRulesOf, plainObject, validateCompanySettings, type CompanySettings } from "./company-settings.js";

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
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  state: InviteState;
  revision: number;
  revokedAt?: string;
  acceptedAt?: string;
  acceptedBy?: string;
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

export interface HookInstall { issuer: string; keys: PublicJwk[]; companyIds: string[]; updatedAt: string }

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
  /** Removes an unconfirmed invite (Code never took it), with its request id and token. */
  removeInvite(invite: InviteRecord): Promise<void>;
  /** The company's agent AI choice (DEC 240), or undefined when none was saved or the row does not read as this company's. */
  agentAi(companyId: string): Promise<AgentAiChoice | undefined>;
  /** Saves the choice at `expectedVersion + 1` (0: none saved yet). Throws CompanyStoreConflict. */
  putAgentAi(choice: Omit<AgentAiChoice, "version">, expectedVersion: number): Promise<number>;
  hookInstall(issuer: string): Promise<HookInstall | undefined>;
  /** An install operator's change (no app route writes this). Throws on an install that does not read. */
  putHookInstall(install: HookInstall): Promise<void>;
  removeHookInstall(issuer: string): Promise<void>;
}

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
