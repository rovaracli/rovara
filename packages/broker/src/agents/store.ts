// packages/broker/src/agents/store.ts
// The agent store: an agent's META, its DRAFT, immutable numbered versions, the org's name and directory
// items and one EVENT# item per notable write. Every multi-item write is one transaction, so a refused
// write leaves nothing behind. An agent builds on another by a pinned version (`BaseRef`): the base moving
// on changes nothing until the agent's owner takes the update. `resolveAgent` follows those pins down to a
// built-in version or the empty recipe and applies each layer's overlay on the way back up.
import { randomBytes } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  AGENT_DESCRIPTION_MAX,
  AGENT_NAME_MAX,
  INDEX_EXPIRY_ATTRIBUTE,
  BUILTIN_AGENTS,
  EMPTY_RECIPE,
  RecipeOverlaySchema,
  agentDirectoryKey,
  agentGuardrailsKey,
  agentKey,
  agentNameKey,
  agentRequestKey,
  agentVersionSk,
  ownerBudgetKey,
  orgSettingsKey,
  applyOverlay,
  builtinRecipe,
  builtinSettingsKey,
  currentBuiltinVersion,
  formatRecipeProblem,
  isBuiltinAgentId,
  newPrefixedId,
  orgScoped,
  overlayProblems,
  principalKey,
  principalSharesKey,
  recipeProblems,
  type AgentGuardrails,
  type AgentId,
  type AgentOwner,
  type AgentPrincipal,
  type AgentXError,
  type AuditEventInput,
  type BaseRef,
  type OrgId,
  type OrgKey,
  type RecipeLayer,
  type RecipeOverlay,
  type ResolvedRecipe,
  type ResolvedSkill,
  type SkillRef,
} from "@agentx/contracts";
import {
  Aliases, EXISTS, NOT_EXISTS, REQUEST_MEMORY_DAYS, coded, commit as commitTransaction, errorName, putNew, strip, transact as sendTransaction, updateItem, withoutUndefined,
  type Item, type RequestMark, type TransactItem,
} from "./table-writes.js";
import { SkillStore } from "./skills.js";
import { budgetOwnerOf, ownerShare, ownerTotalItems, withBudgetFields, type BudgetSubject, type OwnerShare } from "../spend/owner-total.js";
import { cleanUsd } from "../spend/top-ups.js";
import { auditBuiltinAdopted, auditGuardrailsChanged, auditOccurrence, auditPublished, auditRolledBack } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditRuntime } from "../audit/outbox.js";
import { accountableChangedEvent, agentBudgetEvents, auditActorOf, ownerMovedEvent } from "../audit/plan3-hooks.js";

/** PF28: the most custom layers a recipe can be built from; a built-in base underneath is not counted. */
export const MAX_CUSTOM_LAYERS = 3;
export { REQUEST_MEMORY_DAYS, type RequestMark };
const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface AgentRecord {
  orgId: OrgId;
  agentId: AgentId;
  name: string;
  description: string;
  owner: AgentOwner;
  accountable?: { developerId: string };
  currentVersion?: number;
  latestVersion: number;
  draftRevision: number;
  /** Counts the writes of the agent's share set (Task 6b); a share save applies only to the count it read. Absent until the first share. */
  sharesRevision?: number;
  status: "active" | "archived";
  monthlyBudgetUsd?: number;
  maxPerRunUsd?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDraft {
  overlay: RecipeOverlay;
  extends?: BaseRef;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

export interface AgentVersion {
  version: number;
  overlay: RecipeOverlay;
  extends?: BaseRef;
  name: string;
  description: string;
  digest: string;
  publishedBy: string;
  publishedAt: string;
  note?: string;
}

/** What a share gives: `view` sees the agent, `use` runs it, `edit` changes its draft. Owning it (`manage`) is not something a share gives. */
export type AgentShareLevel = "view" | "use" | "edit";

/** One principal's share of one agent, as stored at `SHARE#<principal>`; the share-index item beside it carries the same level. */
export interface AgentShareRecord {
  principal: AgentPrincipal;
  level: AgentShareLevel;
  grantedBy: string;
  grantedAt: string;
}

/**
 * A transaction holds at most 100 items. A save of shares writes two per share it adds, changes or drops (the share and its index
 * item) plus the agent's revision and one event, and, when the request is marked, its request item, so it can change at most 48.
 */
export const MAX_SHARE_CHANGES_PER_SAVE = 48;

export interface BuiltinSettings {
  pinnedVersion: number;
  monthlyBudgetUsd?: number;
  maxPerRunUsd?: number;
  accountable?: { developerId: string };
  updatedBy: string;
  updatedAt: string;
}

export type AgentEventKind =
  | "created"
  | "published"
  | "rolled_back"
  | "archived"
  | "unarchived"
  | "shared"
  | "owner_changed"
  | "budget_changed"
  | "base_updated";

/** The built-in agents as the store sees them; tests replace it to add a release without editing the shipped list. */
export interface BuiltinSource {
  currentVersion(id: AgentId): number;
  recipe(id: AgentId, version: number): ResolvedRecipe;
  name(id: AgentId): string;
}

export interface AgentStoreInput {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  newId?: () => AgentId;
  builtins?: BuiltinSource;
  /** The org's skills; by default a `SkillStore` on the same table. */
  skills?: SkillStore;
  /**
   * Reads a developer id as the person it was merged into (Plan 2 Task 3), so a merged duplicate's agents count in the survivor's total
   * of agent budgets (Task 28). Without it an id is its own person.
   */
  resolveOwner?: (orgId: OrgId, developerId: string) => Promise<string>;
  /**
   * The Audit Ledger's outbox. With it, a publish, rollback, adoption, owner or accountable change, budget change and guardrails write adds its
   * pending audit item to the transaction that commits it. Absent on a legacy install: nothing is added.
   */
  audit?: AuditRuntime;
}

const SHIPPED_BUILTINS: BuiltinSource = {
  currentVersion: (id) => currentBuiltinVersion(id as Parameters<typeof currentBuiltinVersion>[0]),
  recipe: (id, version) => builtinRecipe(id as Parameters<typeof builtinRecipe>[0], version),
  name: (id) => BUILTIN_AGENTS[id as keyof typeof BUILTIN_AGENTS].name,
};

const notFound = () => coded("NOT_FOUND", "no agent has that ID");
const conflict = () => coded("AGENT_REVISION_CONFLICT", "Someone else changed this agent's draft. Reload it and make your change again.");
const sharesConflict = () => coded("AGENT_REVISION_CONFLICT", "Someone else changed who this agent is shared with. Reload it and make your change again.");
/** What a write to the guardrails answers when their revision has moved since the writer read them. */
export const GUARDRAILS_CONFLICT_TEXT = "Someone else changed the company's agent guardrails. Reload them and make your change again.";
const guardrailsConflict = () => coded("AGENT_REVISION_CONFLICT", GUARDRAILS_CONFLICT_TEXT);
const nameTaken = (name: string) => coded("CONFIG_INVALID", `name: another agent in your company is called ${name}`);

function parseOverlay(overlay: unknown): RecipeOverlay {
  const parsed = RecipeOverlaySchema.safeParse(overlay);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  throw coded("CONFIG_INVALID", `overlay${first && first.path.length > 0 ? `.${first.path.join(".")}` : ""}: ${first?.message ?? "is not valid"}`);
}

function checkProfile(name: string, description: string): void {
  if (name.length === 0 || name.length > AGENT_NAME_MAX) throw coded("CONFIG_INVALID", `name: must be 1 to ${String(AGENT_NAME_MAX)} characters`);
  if (description.length > AGENT_DESCRIPTION_MAX) throw coded("CONFIG_INVALID", `description: must be at most ${String(AGENT_DESCRIPTION_MAX)} characters`);
}

/** The cap a write is held to, with the revision of the spend policy it was read from (the write checks the policy is still at it). */
export interface OwnerCap {
  usd: number;
  policyRevision: number;
}

/** Why Rovara moved something of a member's to someone else: the person was removed from the org, or merged into another member. */
export interface MoveCause {
  kind: "member_removed" | "member_merged";
  developerId: string;
}

/** What a write that changes whose total a budget is in can ask of the store (Task 28). */
export interface BudgetWriteOptions {
  /** Why Rovara itself moved this (Task 11): a member removed or merged. The agent's `owner_changed` event names it. */
  cause?: MoveCause;
  /**
   * The most one person's agent budgets may total in a month. When given, a write that raises someone's total applies only while the total
   * with it is at most this, tested inside the transaction, so two raises that together pass the cap can't both apply, and only while the
   * spend policy it was read from is unchanged. An admin who lowers the cap after the read but before the write is therefore not raced past.
   * Left out for a change that is not held to the cap (Rovara's own moves, Task 11).
   */
  ownerCap?: OwnerCap;
  /**
   * Task 32: the approved `owner_cap` request this write applies. The approval is the override, so no cap is held; the event names the request, and
   * `items` (the request's own end: its record, its index items, the audit of the decision) commit in the same transaction. `closed` is the error when
   * one of them is refused (the request was decided meanwhile).
   */
  overrideCap?: { spendRequestId: string; items: TransactItem[]; closed: () => Error };
}

/** The write's items with an approved request's own appended, and the refusal that names a refused one of those; the rest are `refuse`'s. */
function withOverride(items: TransactItem[], refuse: (failed: Set<number>) => Error | undefined, options: BudgetWriteOptions): [TransactItem[], (failed: Set<number>) => Error | undefined] {
  const override = options.overrideCap;
  if (override === undefined) return [items, refuse];
  const start = items.length;
  return [[...items, ...override.items], (failed) => ([...failed].some((index) => index >= start && index < start + override.items.length) ? override.closed() : refuse(failed))];
}

/** What an approved request adds to a change's event: the request that overrode the cap. */
const overrideDetail = (options: BudgetWriteOptions): Item => (options.overrideCap === undefined ? {} : { overrideCap: options.overrideCap.spendRequestId });

/** What a refusal by the cap carries, so the route can answer in words with the figures as they are now (`isOwnerCapRefusal`). */
export const isOwnerCapRefusal = (error: unknown): string | undefined => (error instanceof Error ? (error as { overOwnerCap?: string }).overOwnerCap : undefined);

const ownerOverCap = (owner: string) => Object.assign(
  coded("CONFIG_INVALID", "That would take this person's agent budgets past the limit for one person. An org admin can raise the limit in the spend policy."),
  { overOwnerCap: owner },
);
const totalsMoved = () => coded("AGENT_REVISION_CONFLICT", "Someone else changed this person's agent budgets just now. Reload and make your change again.");
const policyMoved = () => coded("AGENT_REVISION_CONFLICT", "Your company's spend policy changed just now. Reload and make your change again.");
const budgetConflict = () => coded("AGENT_REVISION_CONFLICT", "Someone else changed this agent's owner, status or budget just now. Reload it and make your change again.");

/** The counter items of one agent write, and what each refusal of them means. */
interface OwnerTotals {
  items: TransactItem[];
  /** Maps the indexes that failed (counting the agent's own item as 0) to the refusal they mean. */
  refuse: (failed: Set<number>) => Error;
}

/**
 * Pins the fields that decide whose total an agent's budget is in (its status, owner, accountable maintainer and monthly budget) to what
 * the writer read, so a change worked out from a stale read is refused whole instead of leaving the total wrong.
 */
function budgetGuard(subject: BudgetSubject): (aliases: Aliases) => string {
  return (a) => {
    const same = (attribute: string, value: unknown) => (value === undefined ? `attribute_not_exists(${a.name(attribute)})` : `${a.name(attribute)} = ${a.value(value)}`);
    return [
      ...(subject.status === undefined ? [] : [same("status", subject.status)]),
      ...(subject.owner === undefined ? [] : [same("owner", subject.owner)]),
      same("monthlyBudgetUsd", subject.monthlyBudgetUsd),
      same("accountable", subject.accountable),
    ].join(" AND ");
  };
}

function checkAmount(label: string, value: number | null | undefined): void {
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) throw coded("CONFIG_INVALID", `${label}: must be a number of dollars, zero or more`);
}

export class AgentStore {
  private readonly newId: () => AgentId;
  private readonly builtins: BuiltinSource;
  private eventSequence = 0;
  /** The org's skills: a draft may only name ones the org has, publishing pins them, and a recipe resolves them from here. */
  readonly skills: SkillStore;

  constructor(private readonly input: AgentStoreInput) {
    this.newId = input.newId ?? (() => newPrefixedId("agt"));
    this.builtins = input.builtins ?? SHIPPED_BUILTINS;
    this.skills = input.skills ?? new SkillStore({ documentClient: input.documentClient, tableName: input.tableName, now: input.now });
  }

  private iso(): string {
    return new Date(this.input.now()).toISOString();
  }

  private async read(key: OrgKey): Promise<Item | undefined> {
    const response = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
    return response.Item;
  }

  private async queryAll(pk: string, skPrefix?: string): Promise<Item[]> {
    const found: Item[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.input.documentClient.send(new QueryCommand({
        TableName: this.input.tableName,
        KeyConditionExpression: skPrefix === undefined ? "pk = :pk" : "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: skPrefix === undefined ? { ":pk": pk } : { ":pk": pk, ":prefix": skPrefix },
        ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
      found.push(...(page.Items ?? []));
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
    return found;
  }

  private put(key: OrgKey, entityType: string, fields: Item): TransactItem {
    return putNew(this.input, key, entityType, fields);
  }

  /** An Update of one item: `set` values (undefined skipped), `remove` attributes and a condition built from the same aliases. */
  private update(key: OrgKey, change: { set?: Item; remove?: string[]; when?: (aliases: Aliases) => string }): TransactItem {
    return updateItem(this.input, key, change);
  }

  /**
   * The one EVENT# item a write leaves, with its sort key and time, which are also the occurrence and the time of the audit events about the
   * same change. The sequence keeps one process's events in order; the random tail keeps two processes' apart.
   */
  private newEvent(orgId: OrgId, agentId: AgentId, kind: AgentEventKind, by: string, detail: Item = {}): { item: TransactItem; sk: string; at: string } {
    const at = this.iso();
    const tail = `${String(++this.eventSequence).padStart(6, "0")}-${randomBytes(3).toString("hex")}`;
    const sk = `EVENT#${at}#${tail}`;
    return { item: this.put(agentKey(orgId, agentId, sk as `EVENT#${string}`), "AGENT_EVENT", { orgId, agentId, kind, at, by, ...detail }), sk, at };
  }

  private event(orgId: OrgId, agentId: AgentId, kind: AgentEventKind, by: string, detail: Item = {}): TransactItem {
    return this.newEvent(orgId, agentId, kind, by, detail).item;
  }

  /**
   * The audit events of a write and their pending items, to add to the write's transaction (after every item whose refusal is mapped by position).
   * `build` runs only on an install with a ledger; if it throws, or an event is not valid, the write goes on without that event (logged, no value).
   * After the commit, `flushAuditEvents(this.input, events)` sends them.
   */
  private async audited(build: () => AuditEventInput[]): Promise<{ items: TransactItem[]; events: AuditEventInput[] }> {
    const events = await tryAuditEvents(this.input, build);
    return { items: events.flatMap((event) => auditPending(this.input, event)), events };
  }

  private transact(items: TransactItem[], refuse: (failed: Set<number>) => Error | undefined): Promise<void> {
    return sendTransaction(this.input, items, refuse);
  }

  /** `transact` with the request's own item added: the mark is written with the change or not at all. */
  private commit(items: TransactItem[], refuse: (failed: Set<number>) => Error | undefined, request?: RequestMark, result?: unknown): Promise<void> {
    return commitTransaction(this.input, items, refuse, request, result);
  }

  // ---- reads

  /** What an earlier request of this developer's did, if it did anything. */
  async getRequest(orgId: OrgId, developerId: string, requestId: string): Promise<{ fingerprint: string; result: unknown } | undefined> {
    const item = await this.read(agentRequestKey(orgId, developerId, requestId));
    const expires = item?.[INDEX_EXPIRY_ATTRIBUTE];
    if (item === undefined || (typeof expires === "number" && expires <= Math.floor(this.input.now() / 1000))) return undefined;
    return { fingerprint: String(item["fingerprint"]), result: item["result"] };
  }

  async get(orgId: OrgId, agentId: AgentId): Promise<AgentRecord | undefined> {
    const item = await this.read(agentKey(orgId, agentId, "META"));
    return item === undefined ? undefined : (strip(item) as unknown as AgentRecord);
  }

  private async require(orgId: OrgId, agentId: AgentId): Promise<AgentRecord> {
    const agent = await this.get(orgId, agentId);
    if (agent === undefined) throw notFound();
    return agent;
  }

  async getDraft(orgId: OrgId, agentId: AgentId): Promise<AgentDraft | undefined> {
    const item = await this.read(agentKey(orgId, agentId, "DRAFT"));
    return item === undefined ? undefined : (strip(item) as unknown as AgentDraft);
  }

  async getVersion(orgId: OrgId, agentId: AgentId, version: number): Promise<AgentVersion | undefined> {
    if (!Number.isInteger(version) || version < 1) return undefined;
    const item = await this.read(agentKey(orgId, agentId, agentVersionSk(version)));
    return item === undefined ? undefined : (strip(item) as unknown as AgentVersion);
  }

  /** Every published version, oldest first. */
  async listVersions(orgId: OrgId, agentId: AgentId): Promise<AgentVersion[]> {
    const items = await this.queryAll(agentKey(orgId, agentId, "META").pk, "VERSION#");
    return items.map((item) => strip(item) as unknown as AgentVersion);
  }

  /** The org's custom agents, in the order of the directory (by id). */
  async list(orgId: OrgId): Promise<AgentRecord[]> {
    const directory = await this.queryAll(orgScoped(orgId, "AGENT_DIRECTORY"));
    const agents = await Promise.all(directory.map((entry) => this.get(orgId, entry.sk as AgentId)));
    return agents.filter((agent): agent is AgentRecord => agent !== undefined);
  }

  /** Who the agent is shared with, in the order of their keys. */
  async listShares(orgId: OrgId, agentId: AgentId): Promise<AgentShareRecord[]> {
    const items = await this.queryAll(agentKey(orgId, agentId, "META").pk, "SHARE#");
    return items.map((item) => strip(item) as unknown as AgentShareRecord);
  }

  /** Every event of one agent (a built-in's included), oldest first. */
  async listEvents(orgId: OrgId, agentId: AgentId): Promise<Item[]> {
    return (await this.queryAll(agentKey(orgId, agentId, "META").pk, "EVENT#")).map(strip);
  }

  // ---- built-ins

  builtinName(agentId: AgentId): string {
    return this.builtins.name(agentId);
  }

  builtinLatestVersion(agentId: AgentId): number {
    return this.builtins.currentVersion(agentId);
  }

  builtinRecipe(agentId: AgentId, version: number): ResolvedRecipe {
    return this.builtins.recipe(agentId, version);
  }

  /** The org's settings for one built-in, or undefined while it has never changed any. */
  async getBuiltinSettings(orgId: OrgId, agentId: AgentId): Promise<BuiltinSettings | undefined> {
    const item = await this.read(builtinSettingsKey(orgId, agentId));
    return item === undefined ? undefined : (strip(item) as unknown as BuiltinSettings);
  }

  /** The version the org's own use of a built-in runs: its pin, or the newest release while it has no settings yet. */
  async pinnedBuiltinVersion(orgId: OrgId, agentId: AgentId): Promise<number> {
    return (await this.getBuiltinSettings(orgId, agentId))?.pinnedVersion ?? this.builtins.currentVersion(agentId);
  }

  /** Creates the org's settings for a built-in, pinned to the newest release, if it has none; returns them either way. */
  async ensureBuiltinSettings(orgId: OrgId, agentId: AgentId, by = "system"): Promise<BuiltinSettings> {
    this.requireBuiltin(agentId);
    const existing = await this.getBuiltinSettings(orgId, agentId);
    if (existing !== undefined) return existing;
    const settings: BuiltinSettings = { pinnedVersion: this.builtins.currentVersion(agentId), updatedBy: by, updatedAt: this.iso() };
    try {
      await this.input.documentClient.send(new PutCommand({
        TableName: this.input.tableName,
        Item: { ...builtinSettingsKey(orgId, agentId), entityType: "BUILTIN_AGENT_SETTINGS", ...settings },
        ConditionExpression: NOT_EXISTS,
      }));
      return settings;
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      const raced = await this.getBuiltinSettings(orgId, agentId);
      if (raced === undefined) throw error;
      return raced;
    }
  }

  private requireBuiltin(agentId: AgentId): void {
    if (!isBuiltinAgentId(agentId)) throw coded("CONFIG_INVALID", "that agent is not a built-in agent");
  }

  /**
   * Moves the org's pin of a built-in to a released version (the route limits this to org owners and admins). It applies
   * only while the pin is still `expectedPinnedVersion`, so an approval given against an older pin can't overwrite a newer one.
   */
  async adoptBuiltinVersion(input: { orgId: OrgId; agentId: AgentId; version: number; expectedPinnedVersion: number; by: string; request?: RequestMark }): Promise<BuiltinSettings> {
    this.requireBuiltin(input.agentId);
    if (!Number.isInteger(input.version) || input.version < 1 || input.version > this.builtins.currentVersion(input.agentId)) {
      throw coded("NOT_FOUND", `${this.builtins.name(input.agentId)} has no version ${String(input.version)}`);
    }
    const before = await this.ensureBuiltinSettings(input.orgId, input.agentId, input.by);
    const updatedAt = this.iso();
    const adopted: BuiltinSettings = { ...before, pinnedVersion: input.version, updatedBy: input.by, updatedAt };
    const event = this.newEvent(input.orgId, input.agentId, "base_updated", input.by, { from: input.expectedPinnedVersion, to: input.version });
    const audit = await this.audited(() => [auditBuiltinAdopted({
      orgId: input.orgId, actor: auditActorOf(input.by), occurredAt: event.at, occurrence: event.sk, agentId: input.agentId, version: input.version,
    })]);
    await this.commit([
      this.update(builtinSettingsKey(input.orgId, input.agentId), {
        set: { pinnedVersion: input.version, updatedBy: input.by, updatedAt },
        when: (a) => `${a.name("pinnedVersion")} = ${a.value(input.expectedPinnedVersion)}`,
      }),
      event.item,
      ...audit.items,
    ], () => conflict(), input.request, { settings: adopted, previous: input.expectedPinnedVersion });
    await flushAuditEvents(this.input, audit.events);
    return adopted;
  }

  // ---- bases

  /**
   * The version a new pin of `baseId` takes: a built-in's pin for the org, or a custom agent's current version.
   * `child` names the agent that builds on it, for the message when the base is archived.
   */
  private async pinTarget(orgId: OrgId, baseId: AgentId, child?: string): Promise<BaseRef> {
    if (isBuiltinAgentId(baseId)) return { agentId: baseId, version: (await this.ensureBuiltinSettings(orgId, baseId)).pinnedVersion };
    const base = await this.require(orgId, baseId);
    if (base.status === "archived") {
      throw coded("AGENT_UNAVAILABLE", child === undefined ? `${base.name} is archived, so it can't start new work.` : `${child} builds on ${base.name}, which is archived. Ask ${child}'s owner to pick another base.`);
    }
    if (base.currentVersion === undefined) throw coded("CONFIG_INVALID", `extends: ${base.name} has no published version to build on`);
    return { agentId: baseId, version: base.currentVersion };
  }

  private reservedName(name: string): boolean {
    return Object.values(BUILTIN_AGENTS).some((builtin) => builtin.name.trim().toLowerCase() === name.trim().toLowerCase());
  }

  // ---- writes

  async create(input: {
    orgId: OrgId;
    name: string;
    description?: string;
    owner: AgentOwner;
    accountable?: { developerId: string };
    extends?: AgentId;
    overlay?: RecipeOverlay;
    createdBy: string;
    request?: RequestMark;
  }): Promise<AgentRecord> {
    const name = input.name.trim();
    const description = input.description ?? "";
    checkProfile(name, description);
    if (this.reservedName(name)) throw nameTaken(name);
    if (input.owner.kind === "project" && input.accountable === undefined) throw coded("CONFIG_INVALID", "accountable: a project's agent needs an accountable maintainer");
    if (input.owner.kind === "member" && input.accountable !== undefined) throw coded("CONFIG_INVALID", "accountable: only a project's agent has an accountable maintainer");
    const overlay = parseOverlay(input.overlay ?? {});
    await this.skills.requireRefs(input.orgId, overlay.skills?.add);
    const base = input.extends === undefined ? undefined : await this.pinTarget(input.orgId, input.extends);

    const agentId = this.newId();
    const now = this.iso();
    const agent: AgentRecord = {
      orgId: input.orgId,
      agentId,
      name,
      description,
      owner: input.owner,
      ...(input.accountable === undefined ? {} : { accountable: input.accountable }),
      latestVersion: 0,
      draftRevision: 1,
      status: "active",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    const draft: AgentDraft = { overlay, ...(base === undefined ? {} : { extends: base }), revision: 1, updatedBy: input.createdBy, updatedAt: now };
    await this.commit([
      this.put(agentKey(input.orgId, agentId, "META"), "AGENT", agent as unknown as Item),
      this.put(agentKey(input.orgId, agentId, "DRAFT"), "AGENT_DRAFT", draft as unknown as Item),
      this.put(agentDirectoryKey(input.orgId, agentId), "AGENT_DIRECTORY", { agentId, createdAt: now }),
      this.put(agentNameKey(input.orgId, name), "AGENT_NAME", { agentId, createdAt: now }),
      this.event(input.orgId, agentId, "created", input.createdBy, { name, ...(base === undefined ? {} : { extends: base }) }),
    ], (failed) => (failed.has(3) ? nameTaken(name) : undefined), input.request, agent);
    return agent;
  }

  /**
   * Saves the draft's overlay when `expectedRevision` is still its revision. `extends` picks another base (pinned to
   * its current version; the same base keeps its pin) or, as `null`, none; left out, the base stays as it is.
   */
  async saveDraft(input: { orgId: OrgId; agentId: AgentId; overlay: RecipeOverlay; extends?: AgentId | null; expectedRevision: number; by: string; request?: RequestMark }): Promise<AgentDraft> {
    const overlay = parseOverlay(input.overlay);
    const agent = await this.require(input.orgId, input.agentId);
    const draft = await this.getDraft(input.orgId, input.agentId);
    if (draft === undefined) throw notFound();
    if (draft.revision !== input.expectedRevision) throw conflict();
    await this.skills.requireRefs(input.orgId, overlay.skills?.add);
    let base: BaseRef | undefined = draft.extends;
    if (input.extends === null) base = undefined;
    else if (input.extends !== undefined && input.extends !== draft.extends?.agentId) {
      if (input.extends === input.agentId) throw coded("CONFIG_INVALID", "extends: an agent can't build on itself");
      base = await this.pinTarget(input.orgId, input.extends, agent.name);
    }
    const revision = draft.revision + 1;
    const updatedAt = this.iso();
    const saved: AgentDraft = { overlay, ...(base === undefined ? {} : { extends: base }), revision, updatedBy: input.by, updatedAt };
    await this.commit([
      this.update(agentKey(input.orgId, input.agentId, "DRAFT"), {
        set: { overlay, revision, updatedBy: input.by, updatedAt, extends: base },
        ...(base === undefined ? { remove: ["extends"] } : {}),
        when: (a) => `${a.name("revision")} = ${a.value(input.expectedRevision)}`,
      }),
      this.update(agentKey(input.orgId, input.agentId, "META"), {
        set: { draftRevision: revision, updatedAt },
        when: (a) => `${a.name("draftRevision")} = ${a.value(input.expectedRevision)}`,
      }),
    ], () => conflict(), input.request, saved);
    return saved;
  }

  /** Changes the name or description. A rename swaps the name item, so the new name is checked and the old one freed together. */
  async updateProfile(input: { orgId: OrgId; agentId: AgentId; name?: string; description?: string; by: string; request?: RequestMark }): Promise<AgentRecord> {
    const agent = await this.require(input.orgId, input.agentId);
    const name = input.name === undefined ? agent.name : input.name.trim();
    const description = input.description ?? agent.description;
    checkProfile(name, description);
    const renamed = name.toLowerCase() !== agent.name.trim().toLowerCase();
    if (renamed && this.reservedName(name)) throw nameTaken(name);
    const updatedAt = this.iso();
    const items: TransactItem[] = [
      this.update(agentKey(input.orgId, input.agentId, "META"), {
        set: { name, description, updatedAt },
        when: (a) => `${a.name("name")} = ${a.value(agent.name)} AND ${a.name("description")} = ${a.value(agent.description)}`,
      }),
    ];
    if (renamed) {
      items.push(
        this.put(agentNameKey(input.orgId, name), "AGENT_NAME", { agentId: input.agentId, createdAt: updatedAt }),
        {
          Delete: {
            TableName: this.input.tableName,
            Key: agentNameKey(input.orgId, agent.name),
            ConditionExpression: "agentId = :agentId",
            ExpressionAttributeValues: { ":agentId": input.agentId },
          },
        },
      );
    }
    const updated: AgentRecord = { ...agent, name, description, updatedAt };
    await this.commit(items, (failed) => (failed.has(1) ? nameTaken(name) : conflict()), input.request, updated);
    return updated;
  }

  /**
   * Publishes the draft as version `latestVersion + 1`. The version item must not exist and the agent must still be at
   * the `latestVersion` and draft revision read here, so of two concurrent publishes one wins and the other conflicts. With
   * `expectedCurrentVersion` (`null` for none) it also applies only while that is the current version: what a caller compared the
   * draft against before deciding it was safe to publish.
   *
   * Every skill the draft adds without a digest is pinned to one in the version: `skillDigests[skillId]` (the digest the caller's recipe
   * was resolved with, so the version is the recipe that was compared) or else the skill's current digest. The write applies only while
   * the skill still has that content, so a skill edited in between refuses the publish instead of publishing something else.
   */
  async publish(input: {
    orgId: OrgId; agentId: AgentId; expectedDraftRevision: number; digest: string; note?: string; by: string; expectedCurrentVersion?: number | null; skillDigests?: Readonly<Record<string, string>>; request?: RequestMark;
    /** Whether the publish made anything less safe than what ran before, which a person confirmed (`less_safe`), or nothing (`safe`, the default); the audit event says which. */
    safety?: "safe" | "less_safe";
  }): Promise<AgentVersion> {
    if (!SHA256_HEX.test(input.digest)) throw coded("CONFIG_INVALID", "digest: must be the recipe's SHA-256 digest");
    const agent = await this.require(input.orgId, input.agentId);
    const draft = await this.getDraft(input.orgId, input.agentId);
    if (draft === undefined) throw notFound();
    if (agent.draftRevision !== input.expectedDraftRevision || draft.revision !== input.expectedDraftRevision) throw conflict();
    const n = agent.latestVersion;
    const version = n + 1;
    const publishedAt = this.iso();
    const added = draft.overlay.skills?.add;
    const pinned = added === undefined ? undefined : await this.skills.pin(input.orgId, added, input.skillDigests);
    const overlay: RecipeOverlay = pinned === undefined ? draft.overlay : { ...draft.overlay, skills: { ...draft.overlay.skills, add: pinned.refs } };
    const published: AgentVersion = {
      version,
      overlay,
      ...(draft.extends === undefined ? {} : { extends: draft.extends }),
      name: agent.name,
      description: agent.description,
      digest: input.digest,
      publishedBy: input.by,
      publishedAt,
      ...(input.note === undefined ? {} : { note: input.note }),
    };
    const event = this.newEvent(input.orgId, input.agentId, "published", input.by, { version, digest: input.digest, ...(input.note === undefined ? {} : { note: input.note }) });
    const audit = await this.audited(() => [auditPublished({
      orgId: input.orgId, actor: auditActorOf(input.by), occurredAt: event.at, occurrence: event.sk, scope: "agent", targetId: input.agentId, version, safety: input.safety ?? "safe",
    })]);
    const written: TransactItem[] = [
      this.put(agentKey(input.orgId, input.agentId, agentVersionSk(version)), "AGENT_VERSION", published as unknown as Item),
      this.update(agentKey(input.orgId, input.agentId, "META"), {
        set: { currentVersion: version, latestVersion: version, updatedAt: publishedAt },
        when: (a) => [
          `${a.name("latestVersion")} = ${a.value(n)}`,
          `${a.name("draftRevision")} = ${a.value(input.expectedDraftRevision)}`,
          `${a.name("name")} = ${a.value(agent.name)}`,
          `${a.name("description")} = ${a.value(agent.description)}`,
          ...(input.expectedCurrentVersion === undefined ? [] : [input.expectedCurrentVersion === null ? `attribute_not_exists(${a.name("currentVersion")})` : `${a.name("currentVersion")} = ${a.value(input.expectedCurrentVersion)}`]),
        ].join(" AND "),
      }),
      event.item,
    ];
    // The skills' checks follow what is written; one of them failing is a skill that moved, not a draft that did. The audit item is last of all.
    await this.commit([...written, ...(pinned?.checks ?? []), ...audit.items], (failed) => ([...failed].some((index) => index < written.length) ? conflict() : coded("AGENT_REVISION_CONFLICT", "A skill this agent uses changed while it was being published. Publish again.")), input.request, published);
    await flushAuditEvents(this.input, audit.events);
    return published;
  }

  /**
   * Makes an earlier published version the current one. Later versions stay, and the next publish still numbers after them.
   * It applies only while the current version is still `expectedCurrentVersion`, so a publish that landed since can't be undone unseen.
   */
  async rollback(input: { orgId: OrgId; agentId: AgentId; version: number; expectedCurrentVersion: number; by: string; request?: RequestMark }): Promise<AgentRecord> {
    const agent = await this.require(input.orgId, input.agentId);
    if (await this.getVersion(input.orgId, input.agentId, input.version) === undefined) throw coded("NOT_FOUND", `${agent.name} has no version ${String(input.version)}`);
    const updatedAt = this.iso();
    const rolled: AgentRecord = { ...agent, currentVersion: input.version, updatedAt };
    const event = this.newEvent(input.orgId, input.agentId, "rolled_back", input.by, { from: input.expectedCurrentVersion, to: input.version });
    const audit = await this.audited(() => [auditRolledBack({
      orgId: input.orgId, actor: auditActorOf(input.by), occurredAt: event.at, occurrence: event.sk, scope: "agent", targetId: input.agentId,
      fromVersion: input.expectedCurrentVersion, toVersion: input.version,
    })]);
    await this.commit([
      this.update(agentKey(input.orgId, input.agentId, "META"), {
        set: { currentVersion: input.version, updatedAt },
        when: (a) => `${a.name("currentVersion")} = ${a.value(input.expectedCurrentVersion)}`,
      }),
      event.item,
      ...audit.items,
    ], () => conflict(), input.request, rolled);
    await flushAuditEvents(this.input, audit.events);
    return rolled;
  }

  // ---- the owner totals (Task 28)

  private async survivorOf(orgId: OrgId, developerId: string): Promise<string> {
    return this.input.resolveOwner === undefined ? developerId : this.input.resolveOwner(orgId, developerId);
  }

  /** The sum of the monthly budgets of the active agents (custom ones, and built-ins with an accountable person) that count for `owner`. */
  private async sumOwnerBudgets(orgId: OrgId, owner: string): Promise<number> {
    const survivors = new Map<string, Promise<string>>();
    const counts = async (subject: BudgetSubject): Promise<boolean> => {
      const raw = budgetOwnerOf(subject);
      if (raw === undefined) return false;
      let found = survivors.get(raw);
      if (found === undefined) { found = this.survivorOf(orgId, raw); survivors.set(raw, found); }
      return (await found) === owner;
    };
    let total = 0;
    for (const agent of await this.list(orgId)) {
      if (ownerShare(agent) !== undefined && await counts(agent)) total += agent.monthlyBudgetUsd ?? 0;
    }
    for (const id of Object.keys(BUILTIN_AGENTS)) {
      const settings = await this.getBuiltinSettings(orgId, id);
      if (settings !== undefined && ownerShare(settings) !== undefined && await counts(settings)) total += settings.monthlyBudgetUsd ?? 0;
    }
    return cleanUsd(total);
  }

  /**
   * Makes sure `owner` has a total to add to, built from the agents when there is none yet. A write that changes a total never creates
   * one (`addToCounter` needs it there), and a total is only created while no write has touched it, so the figure it starts at is exact.
   */
  async ensureOwnerTotal(orgId: OrgId, owner: string): Promise<void> {
    if (await this.read(ownerBudgetKey(orgId, owner)) !== undefined) return;
    const totalUsd = await this.sumOwnerBudgets(orgId, owner);
    try {
      await this.input.documentClient.send(new PutCommand({
        TableName: this.input.tableName,
        Item: { ...ownerBudgetKey(orgId, owner), entityType: "OWNER_AGENT_BUDGET", totalUsd, builtAt: this.iso() },
        ConditionExpression: NOT_EXISTS,
      }));
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error; // another writer built it first, from the same agents
    }
  }

  /**
   * Replaces `owner`'s total with the sum of their agents' budgets and answers it. The total is replaced only while it is still the figure
   * that was read, and every write to an agent's budget changes the total in the same transaction, so the figure written is exact; a
   * write that raced it makes it read again. A merge calls this for the survivor, because a duplicate's agents were counted under the
   * duplicate until now.
   */
  async rebuildOwnerTotal(orgId: OrgId, owner: string): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const seen = (await this.read(ownerBudgetKey(orgId, owner)))?.["totalUsd"];
      const total = await this.sumOwnerBudgets(orgId, owner);
      if (typeof seen === "number" && Math.abs(seen - total) < 0.000001) return total;
      try {
        await this.input.documentClient.send(new UpdateCommand({
          TableName: this.input.tableName,
          Key: ownerBudgetKey(orgId, owner),
          UpdateExpression: "SET #total = :total, #type = :type, #built = :built",
          ConditionExpression: typeof seen === "number" ? "#total = :seen" : "attribute_not_exists(#total)",
          ExpressionAttributeNames: { "#total": "totalUsd", "#type": "entityType", "#built": "builtAt" },
          ExpressionAttributeValues: { ":total": total, ":type": "OWNER_AGENT_BUDGET", ":built": this.iso(), ...(typeof seen === "number" ? { ":seen": seen } : {}) },
        }));
        return total;
      } catch (error) {
        if (errorName(error) !== "ConditionalCheckFailedException") throw error;
      }
    }
    throw totalsMoved();
  }

  /**
   * The counter items that take an agent from `before` to `after`, in each owner's survivor's total, and what their refusals mean. An
   * owner with no total yet has one built from the agents first; a record that names a merged duplicate has the survivor's total rebuilt,
   * because the duplicate's agents may be counted under the duplicate. A raise held to `cap` also checks the spend policy is still at the
   * revision the cap was read from.
   */
  private async totalsFor(orgId: OrgId, before: BudgetSubject, after: BudgetSubject, cap?: OwnerCap): Promise<OwnerTotals> {
    const resolve = async (subject: BudgetSubject): Promise<{ share?: OwnerShare; stale: boolean }> => {
      const share = ownerShare(subject);
      if (share === undefined) return { stale: false };
      const owner = await this.survivorOf(orgId, share.owner);
      return { share: { owner, usd: share.usd }, stale: owner !== share.owner };
    };
    const [was, now] = await Promise.all([resolve(before), resolve(after)]);
    const owners = new Map<string, boolean>();
    for (const side of [was, now]) if (side.share !== undefined) owners.set(side.share.owner, (owners.get(side.share.owner) ?? false) || side.stale);
    for (const [owner, stale] of owners) {
      if (stale) await this.rebuildOwnerTotal(orgId, owner);
      else await this.ensureOwnerTotal(orgId, owner);
    }
    const counters = ownerTotalItems(this.input, orgId, was.share, now.share, cap?.usd);
    const items = [...counters.items];
    let policyAt: number | undefined;
    if (cap !== undefined && counters.capped.length > 0) {
      policyAt = items.length;
      items.push({
        ConditionCheck: {
          TableName: this.input.tableName,
          Key: orgSettingsKey(orgId, "SPEND_POLICY"),
          ...(cap.policyRevision === 0
            ? { ConditionExpression: NOT_EXISTS }
            : { ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": cap.policyRevision } }),
        },
      });
    }
    return {
      items,
      // The agent's own item is first in the transaction, so the counters start at 1.
      refuse: (failed) => {
        // The agent changed since it was read: that is the answer, whatever the counters make of the old figures.
        if (failed.has(0)) return budgetConflict();
        if (policyAt !== undefined && failed.has(policyAt + 1)) return policyMoved();
        const capped = counters.capped.find((index) => failed.has(index + 1));
        if (capped !== undefined) return ownerOverCap(counters.owners[capped]!);
        if (counters.items.some((_item, index) => failed.has(index + 1))) return totalsMoved();
        return budgetConflict();
      },
    };
  }

  private async setStatus(orgId: OrgId, agentId: AgentId, status: "active" | "archived", by: string, request?: RequestMark, options: BudgetWriteOptions = {}): Promise<AgentRecord> {
    if (isBuiltinAgentId(agentId)) throw coded("CONFIG_INVALID", `${this.builtins.name(agentId)} is built in and can't be archived`);
    const agent = await this.require(orgId, agentId);
    if (agent.status === status) return agent;
    const updatedAt = this.iso();
    const changed: AgentRecord = { ...agent, status, updatedAt };
    // An archived agent counts for no one; unarchiving puts its budget back in its owner's total, held to the cap when one is given.
    const totals = await this.totalsFor(orgId, agent, changed, options.ownerCap);
    await this.commit(...withOverride([
      this.update(agentKey(orgId, agentId, "META"), { set: { status, updatedAt }, when: budgetGuard(agent) }),
      ...totals.items,
      this.event(orgId, agentId, status === "archived" ? "archived" : "unarchived", by, overrideDetail(options)),
    ], totals.refuse, options), request, changed);
    return changed;
  }

  archive(orgId: OrgId, agentId: AgentId, by: string, request?: RequestMark, options?: BudgetWriteOptions): Promise<AgentRecord> {
    return this.setStatus(orgId, agentId, "archived", by, request, options);
  }

  unarchive(orgId: OrgId, agentId: AgentId, by: string, request?: RequestMark, options?: BudgetWriteOptions): Promise<AgentRecord> {
    return this.setStatus(orgId, agentId, "active", by, request, options);
  }

  /**
   * Sets the budget limits; a number sets, `null` clears and a limit left out stays. A built-in's go on the org's settings for it. The
   * monthly budget is counted in its owner's total (see `spend/owner-total.ts`) in the same transaction, and only while the agent still
   * has the status, owner and budget that were read. Returns the agent's record, or the built-in's settings, as written.
   */
  async setBudget(orgId: OrgId, agentId: AgentId, budget: { monthlyUsd?: number | null; maxPerRunUsd?: number | null }, by: string, request?: RequestMark, options: BudgetWriteOptions = {}): Promise<AgentRecord | BuiltinSettings> {
    checkAmount("monthlyUsd", budget.monthlyUsd);
    checkAmount("maxPerRunUsd", budget.maxPerRunUsd);
    const updatedAt = this.iso();
    const set: Item = {
      ...(typeof budget.monthlyUsd === "number" ? { monthlyBudgetUsd: budget.monthlyUsd } : {}),
      ...(typeof budget.maxPerRunUsd === "number" ? { maxPerRunUsd: budget.maxPerRunUsd } : {}),
      updatedAt,
    };
    const remove = [...(budget.monthlyUsd === null ? ["monthlyBudgetUsd"] : []), ...(budget.maxPerRunUsd === null ? ["maxPerRunUsd"] : [])];
    const detail = { monthlyUsd: budget.monthlyUsd ?? undefined, maxPerRunUsd: budget.maxPerRunUsd ?? undefined, cleared: remove };
    let key: OrgKey;
    let current: AgentRecord | BuiltinSettings;
    if (isBuiltinAgentId(agentId)) {
      current = await this.ensureBuiltinSettings(orgId, agentId, by);
      key = builtinSettingsKey(orgId, agentId);
      set["updatedBy"] = by;
    } else {
      current = await this.require(orgId, agentId);
      key = agentKey(orgId, agentId, "META");
    }
    const monthlyBudgetUsd = typeof budget.monthlyUsd === "number" ? budget.monthlyUsd : budget.monthlyUsd === null ? undefined : current.monthlyBudgetUsd;
    const maxPerRunUsd = typeof budget.maxPerRunUsd === "number" ? budget.maxPerRunUsd : budget.maxPerRunUsd === null ? undefined : current.maxPerRunUsd;
    const { monthlyBudgetUsd: _monthly, maxPerRunUsd: _perRun, ...others } = current; // eslint-disable-line @typescript-eslint/no-unused-vars -- replaced below
    const written = { ...others, ...(monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd }), ...(maxPerRunUsd === undefined ? {} : { maxPerRunUsd }), updatedAt, ...(isBuiltinAgentId(agentId) ? { updatedBy: by } : {}) };
    const totals = await this.totalsFor(orgId, current, written, options.ownerCap);
    const event = this.newEvent(orgId, agentId, "budget_changed", by, { ...withoutUndefined(detail), ...overrideDetail(options) });
    const audit = await this.audited(() => agentBudgetEvents({
      orgId, actor: auditActorOf(by), occurredAt: event.at, occurrence: event.sk, agentId,
      before: { monthlyBudgetUsd: current.monthlyBudgetUsd, maxPerRunUsd: current.maxPerRunUsd }, after: { monthlyBudgetUsd, maxPerRunUsd },
    }));
    await this.commit(...withOverride([
      this.update(key, { set, ...(remove.length > 0 ? { remove } : {}), when: budgetGuard(current) }),
      ...totals.items,
      event.item,
      ...audit.items,
    ], totals.refuse, options), request, written);
    await flushAuditEvents(this.input, audit.events);
    return written;
  }

  /**
   * Moves a custom agent to another owner. A project's agent needs `accountable`; a member's has none. Who may do this,
   * and whether the new owner's budget total allows it, is the route's check.
   */
  async setOwner(orgId: OrgId, agentId: AgentId, owner: AgentOwner, by: string, accountable?: { developerId: string }, request?: RequestMark, options: BudgetWriteOptions = {}): Promise<AgentRecord> {
    if (isBuiltinAgentId(agentId)) throw coded("CONFIG_INVALID", `${this.builtins.name(agentId)} is built in and belongs to the whole company`);
    if (owner.kind === "project" && accountable === undefined) throw coded("CONFIG_INVALID", "accountable: a project's agent needs an accountable maintainer");
    if (owner.kind === "member" && accountable !== undefined) throw coded("CONFIG_INVALID", "accountable: only a project's agent has an accountable maintainer");
    const agent = await this.require(orgId, agentId);
    const updatedAt = this.iso();
    const { accountable: _before, ...rest } = agent; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped when the new owner has none
    const moved: AgentRecord = { ...rest, owner, ...(accountable === undefined ? {} : { accountable }), updatedAt };
    // The agent's budget leaves the old owner's total and joins the new one's, which the cap holds when one is given.
    const totals = await this.totalsFor(orgId, agent, moved, options.ownerCap);
    const guard = budgetGuard(agent);
    const event = this.newEvent(orgId, agentId, "owner_changed", by, { from: agent.owner, to: owner, ...(accountable === undefined ? {} : { accountable }), ...(options.cause === undefined ? {} : { cause: options.cause }), ...overrideDetail(options) });
    const audit = await this.audited(() => [ownerMovedEvent({
      orgId, actor: auditActorOf(by), occurredAt: event.at, occurrence: event.sk, agentId, from: agent.owner, to: owner,
      ...(accountable === undefined ? {} : { accountable: accountable.developerId }),
    })]);
    await this.commit(...withOverride([
      this.update(agentKey(orgId, agentId, "META"), {
        set: { owner, accountable, updatedAt },
        ...(accountable === undefined ? { remove: ["accountable"] } : {}),
        when: (a) => `${a.name("updatedAt")} = ${a.value(agent.updatedAt)} AND ${guard(a)}`,
      }),
      ...totals.items,
      event.item,
      ...audit.items,
    ], totals.refuse, options), request, moved);
    await flushAuditEvents(this.input, audit.events);
    return moved;
  }

  /**
   * Changes the maintainer answerable for a project's agent (or the org's one for a built-in). That the new person holds
   * `manage_agents` on the project is the route's check.
   */
  async setAccountable(orgId: OrgId, agentId: AgentId, accountable: { developerId: string }, by: string, request?: RequestMark, options: BudgetWriteOptions = {}): Promise<void> {
    const updatedAt = this.iso();
    if (isBuiltinAgentId(agentId)) {
      const before = await this.ensureBuiltinSettings(orgId, agentId, by);
      const totals = await this.totalsFor(orgId, before, withBudgetFields(before, { accountable }), options.ownerCap);
      const event = this.newEvent(orgId, agentId, "owner_changed", by, { accountable, ...(before.accountable === undefined ? {} : { from: before.accountable }), ...(options.cause === undefined ? {} : { cause: options.cause }), ...overrideDetail(options) });
      const audit = await this.audited(() => [accountableChangedEvent({
        orgId, actor: auditActorOf(by), occurredAt: event.at, occurrence: event.sk, agentId, accountable: accountable.developerId,
        ...(before.accountable === undefined ? {} : { previous: before.accountable.developerId }),
      })]);
      await this.commit(...withOverride([
        this.update(builtinSettingsKey(orgId, agentId), { set: { accountable, updatedBy: by, updatedAt }, when: budgetGuard(before) }),
        ...totals.items,
        event.item,
        ...audit.items,
      ], totals.refuse, options), request, { accountable });
      await flushAuditEvents(this.input, audit.events);
      return;
    }
    const agent = await this.require(orgId, agentId);
    if (agent.owner.kind !== "project") throw coded("CONFIG_INVALID", "accountable: only a project's agent has an accountable maintainer");
    const totals = await this.totalsFor(orgId, agent, withBudgetFields(agent, { accountable }), options.ownerCap);
    const guard = budgetGuard(agent);
    const event = this.newEvent(orgId, agentId, "owner_changed", by, { accountable, ...(agent.accountable === undefined ? {} : { from: agent.accountable }), ...(options.cause === undefined ? {} : { cause: options.cause }), ...overrideDetail(options) });
    const audit = await this.audited(() => [accountableChangedEvent({
      orgId, actor: auditActorOf(by), occurredAt: event.at, occurrence: event.sk, agentId, accountable: accountable.developerId,
      ...(agent.accountable === undefined ? {} : { previous: agent.accountable.developerId }),
    })]);
    await this.commit(...withOverride([
      this.update(agentKey(orgId, agentId, "META"), { set: { accountable, updatedAt }, when: (a) => `${a.name("updatedAt")} = ${a.value(agent.updatedAt)} AND ${guard(a)}` }),
      ...totals.items,
      event.item,
      ...audit.items,
    ], totals.refuse, options), request, { accountable });
    await flushAuditEvents(this.input, audit.events);
  }

  /**
   * Moves the draft's base to the version it would be pinned to today: a custom base's current version, or the org's pin
   * of a built-in. The draft changes (and its revision with it); nothing is published.
   */
  async updateBase(input: { orgId: OrgId; agentId: AgentId; expectedRevision: number; by: string; request?: RequestMark }): Promise<AgentDraft> {
    const agent = await this.require(input.orgId, input.agentId);
    const draft = await this.getDraft(input.orgId, input.agentId);
    if (draft === undefined) throw notFound();
    if (draft.revision !== input.expectedRevision) throw conflict();
    if (draft.extends === undefined) throw coded("CONFIG_INVALID", `${agent.name} is built from scratch, so it has no base to update`);
    const target = await this.pinTarget(input.orgId, draft.extends.agentId, agent.name);
    if (target.version === draft.extends.version) return draft;
    const revision = draft.revision + 1;
    const updatedAt = this.iso();
    const moved: AgentDraft = { ...draft, extends: target, revision, updatedBy: input.by, updatedAt };
    await this.commit([
      this.update(agentKey(input.orgId, input.agentId, "DRAFT"), {
        set: { extends: target, revision, updatedBy: input.by, updatedAt },
        when: (a) => `${a.name("revision")} = ${a.value(input.expectedRevision)}`,
      }),
      this.update(agentKey(input.orgId, input.agentId, "META"), {
        set: { draftRevision: revision, updatedAt },
        when: (a) => `${a.name("draftRevision")} = ${a.value(input.expectedRevision)}`,
      }),
      this.event(input.orgId, input.agentId, "base_updated", input.by, { base: target.agentId, from: draft.extends.version, to: target.version }),
    ], () => conflict(), input.request, { draft: moved, previous: draft.extends });
    return moved;
  }

  /**
   * Changes the agent's share set in one transaction: each `upsert` writes the share and its index item, each `remove` deletes
   * both, and one `shared` event records it. It applies only while the agent's `sharesRevision` is still `expectedSharesRevision`
   * (0 before the first share), so of two concurrent saves one wins and the other conflicts. Who may share, and that the principals
   * exist, are the caller's checks (access.ts).
   */
  async replaceShares(input: {
    orgId: OrgId;
    agentId: AgentId;
    upsert: Array<{ principal: AgentPrincipal; level: AgentShareLevel }>;
    remove: AgentPrincipal[];
    expectedSharesRevision: number;
    by: string;
    request?: RequestMark;
  }): Promise<void> {
    if (input.upsert.length + input.remove.length > MAX_SHARE_CHANGES_PER_SAVE) {
      throw coded("CONFIG_INVALID", `shares: change at most ${String(MAX_SHARE_CHANGES_PER_SAVE)} people or groups in one save`);
    }
    const at = this.iso();
    const expected = input.expectedSharesRevision;
    const items: TransactItem[] = [
      this.update(agentKey(input.orgId, input.agentId, "META"), {
        set: { sharesRevision: expected + 1 },
        when: (a) => (expected === 0 ? `${EXISTS} AND attribute_not_exists(${a.name("sharesRevision")})` : `${a.name("sharesRevision")} = ${a.value(expected)}`),
      }),
    ];
    const write = (key: OrgKey, entityType: string, fields: Item): TransactItem => ({ Put: { TableName: this.input.tableName, Item: { ...key, entityType, ...fields } } });
    const drop = (key: OrgKey): TransactItem => ({ Delete: { TableName: this.input.tableName, Key: key } });
    for (const { principal, level } of input.upsert) {
      items.push(
        write(agentKey(input.orgId, input.agentId, `SHARE#${principalKey(principal)}`), "AGENT_SHARE", { orgId: input.orgId, agentId: input.agentId, principal, level, grantedBy: input.by, grantedAt: at }),
        write(principalSharesKey(input.orgId, principal, input.agentId), "AGENT_SHARE_INDEX", { agentId: input.agentId, principal, level, grantedAt: at }),
      );
    }
    for (const principal of input.remove) {
      items.push(drop(agentKey(input.orgId, input.agentId, `SHARE#${principalKey(principal)}`)), drop(principalSharesKey(input.orgId, principal, input.agentId)));
    }
    items.push(this.event(input.orgId, input.agentId, "shared", input.by, {
      shared: input.upsert.map(({ principal, level }) => ({ principal: principalKey(principal), level })),
      unshared: input.remove.map((principal) => principalKey(principal)),
    }));
    await this.commit(items, () => sharesConflict(), input.request, input.upsert);
  }

  /** The agents shared with one principal, in the order of their ids (from the share index). */
  async listSharedWith(orgId: OrgId, principal: AgentPrincipal): Promise<AgentId[]> {
    return (await this.queryAll(principalSharesKey(orgId, principal, "").pk)).map((item) => item["sk"] as AgentId);
  }

  /**
   * Takes `from`'s share of one agent away and, when `to` is given, gives `to` the share instead (the higher level when `to` already has
   * one; `to` keeps its own item then). Rovara's own move after a member merge or removal (Task 11): one transaction holds the agent's
   * share revision, the share and index items and one `shared` event naming the cause, so a save that raced it conflicts and is read again.
   * Nothing is written when `from` holds no share, so the move can be repeated.
   */
  async reassignShare(input: { orgId: OrgId; agentId: AgentId; from: AgentPrincipal; to?: AgentPrincipal; by: string; cause: MoveCause }): Promise<void> {
    const { orgId, agentId, from, to } = input;
    if (to !== undefined && principalKey(to) === principalKey(from)) return;
    const rank = (level: unknown) => ["view", "use", "edit"].indexOf(String(level));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [meta, own, index] = await Promise.all([
        this.read(agentKey(orgId, agentId, "META")), this.read(agentKey(orgId, agentId, `SHARE#${principalKey(from)}`)), this.read(principalSharesKey(orgId, from, agentId)),
      ]);
      if (own === undefined && index === undefined) return;
      const drop = (key: OrgKey): TransactItem => ({ Delete: { TableName: this.input.tableName, Key: key } });
      const dropped = [...(own === undefined ? [] : [drop(agentKey(orgId, agentId, `SHARE#${principalKey(from)}`))]), ...(index === undefined ? [] : [drop(principalSharesKey(orgId, from, agentId))])];
      if (meta === undefined || own === undefined) {
        // Nothing to guard or to give: an agent that is gone, or an index item left without its share.
        await this.transact(dropped, () => undefined);
        return;
      }
      const revision = typeof meta["sharesRevision"] === "number" ? meta["sharesRevision"] : 0;
      const theirs = to === undefined ? undefined : await this.read(agentKey(orgId, agentId, `SHARE#${principalKey(to)}`));
      const giveTo = to !== undefined && (theirs === undefined || rank(own["level"]) > rank(theirs["level"])) ? to : undefined;
      const level = own["level"];
      const items: TransactItem[] = [
        this.update(agentKey(orgId, agentId, "META"), {
          set: { sharesRevision: revision + 1 },
          when: (a) => (revision === 0 ? `${EXISTS} AND attribute_not_exists(${a.name("sharesRevision")})` : `${a.name("sharesRevision")} = ${a.value(revision)}`),
        }),
        ...(giveTo === undefined ? [] : [
          { Put: { TableName: this.input.tableName, Item: { ...agentKey(orgId, agentId, `SHARE#${principalKey(giveTo)}`), entityType: "AGENT_SHARE", orgId, agentId, principal: giveTo, level, grantedBy: own["grantedBy"], grantedAt: own["grantedAt"] } } },
          { Put: { TableName: this.input.tableName, Item: { ...principalSharesKey(orgId, giveTo, agentId), entityType: "AGENT_SHARE_INDEX", agentId, principal: giveTo, level, grantedAt: own["grantedAt"] } } },
        ] satisfies TransactItem[]),
        ...dropped,
        this.event(orgId, agentId, "shared", input.by, {
          shared: giveTo === undefined ? [] : [{ principal: principalKey(giveTo), level }], unshared: [principalKey(from)], cause: input.cause,
        }),
      ];
      try {
        await this.transact(items, (failed) => (failed.has(0) ? sharesConflict() : undefined));
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== "AGENT_REVISION_CONFLICT" || attempt === 2) throw error;
      }
    }
  }

  /**
   * Makes `guardrails` the org's agent guardrails (the caller has checked who may, and what is less safe). It applies only while the
   * document is still at `expectedRevision` (0 before the first write), so of two concurrent writes one wins and the other conflicts.
   * Returns the document as stored, with its new revision; that is also what a repeat of the request is answered with.
   */
  async putGuardrails(input: {
    orgId: OrgId; guardrails: AgentGuardrails; expectedRevision: number; by: string; request?: RequestMark;
    /** Whether this write makes anything less safe, which a person confirmed; the audit event says so. Default: no. */
    widened?: boolean;
  }): Promise<{ guardrails: AgentGuardrails; revision: number }> {
    const expected = input.expectedRevision;
    const stored = { guardrails: input.guardrails, revision: expected + 1 };
    const aliases = new Aliases();
    const updatedAt = this.iso();
    // One document per org, committed once per revision: the revision is the occurrence.
    const audit = await this.audited(() => [auditGuardrailsChanged({
      orgId: input.orgId, actor: auditActorOf(input.by), occurredAt: updatedAt, occurrence: auditOccurrence(String(stored.revision)),
      guardrailsId: input.orgId, revision: stored.revision, widened: input.widened === true,
    })]);
    const item: TransactItem = {
      Put: {
        TableName: this.input.tableName,
        Item: { ...agentGuardrailsKey(input.orgId), entityType: "AGENT_GUARDRAILS", revision: stored.revision, guardrails: withoutUndefined(input.guardrails as unknown as Item), updatedBy: input.by, updatedAt },
        ConditionExpression: expected === 0 ? NOT_EXISTS : `${aliases.name("revision")} = ${aliases.value(expected)}`,
        ...(expected === 0 ? {} : { ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values }),
      },
    };
    await this.commit([item, ...audit.items], () => guardrailsConflict(), input.request, stored);
    await flushAuditEvents(this.input, audit.events);
    return stored;
  }
}

export interface ResolveOptions {
  /** Looks up an added skill's name and digest. Without it, the org's skill registry (`store.skills`) does. */
  resolveSkill?: (ref: SkillRef) => ResolvedSkill | Promise<ResolvedSkill>;
  /** The draft of the agent being resolved, already read: used for `"draft"` in place of reading it again (a base layer's draft is never used). */
  draft?: AgentDraft;
}

/** A recipe that can't run: `CONFIG_INVALID` with every problem in the message, and the problems themselves on `problems` (the publish route reports the first). */
export type RecipeProblemsError = AgentXError & { problems: Array<{ path: string; message: string }> };

function problemsError(problems: Array<{ path: string; message: string }>): RecipeProblemsError {
  return Object.assign(coded("CONFIG_INVALID", problems.map(formatRecipeProblem).join("; ")), { problems });
}

/**
 * The recipe an agent runs at a version: its own layer on the layers it builds on, each at the version it pinned, down to
 * a built-in's release or the empty recipe. A built-in resolves at the org's pin.
 */
export async function resolveAgent(
  store: AgentStore,
  orgId: OrgId,
  agentId: AgentId,
  version: number | "current" | "draft",
  options: ResolveOptions = {},
): Promise<ResolvedRecipe> {
  const resolveSkill = options.resolveSkill ?? ((ref: SkillRef) => store.skills.resolve(orgId, ref));

  async function layer(id: AgentId, wanted: number | "current" | "draft", trail: Array<{ agentId: AgentId; name: string }>): Promise<ResolvedRecipe> {
    if (isBuiltinAgentId(id)) {
      // First use pins the org to the release of the day, so a later release needs adoptBuiltinVersion.
      return store.builtinRecipe(id, typeof wanted === "number" ? wanted : (await store.ensureBuiltinSettings(orgId, id)).pinnedVersion);
    }
    if (trail.some((above) => above.agentId === id)) throw coded("CONFIG_INVALID", "agents can't build on each other in a loop");
    if (trail.length >= MAX_CUSTOM_LAYERS) throw coded("CONFIG_INVALID", "agents can build on at most 3 layers");
    const agent = await store.get(orgId, id);
    if (agent === undefined) throw notFound();
    const child = trail.at(-1);
    if (child !== undefined && agent.status === "archived") {
      throw coded("AGENT_UNAVAILABLE", `${child.name} builds on ${agent.name}, which is archived. Ask ${child.name}'s owner to pick another base.`);
    }

    let content: { overlay: RecipeOverlay; extends?: BaseRef; name: string; version: number | "draft" };
    if (wanted === "draft") {
      const draft = trail.length === 0 && options.draft !== undefined ? options.draft : await store.getDraft(orgId, id);
      if (draft === undefined) throw notFound();
      content = { overlay: draft.overlay, ...(draft.extends === undefined ? {} : { extends: draft.extends }), name: agent.name, version: "draft" };
    } else {
      const number = wanted === "current" ? agent.currentVersion : wanted;
      if (number === undefined) throw coded("NOT_FOUND", `${agent.name} has no published version`);
      const published = await store.getVersion(orgId, id, number);
      if (published === undefined) throw coded("NOT_FOUND", `${agent.name} has no version ${String(number)}`);
      content = { overlay: published.overlay, ...(published.extends === undefined ? {} : { extends: published.extends }), name: published.name, version: number };
    }

    const base = content.extends === undefined ? EMPTY_RECIPE : await layer(content.extends.agentId, content.extends.version, [...trail, { agentId: id, name: agent.name }]);
    const problems = overlayProblems(base, content.overlay);
    if (problems.length > 0) throw problemsError(problems);
    const recipeLayer: RecipeLayer = { agentId: id, name: content.name, version: content.version, builtin: false };
    // The registry is read here, not inside applyOverlay, which is synchronous: the layer's added skills are looked up first.
    const added = new Map<string, ResolvedSkill>();
    for (const ref of content.overlay.skills?.add ?? []) added.set(ref.skillId, await resolveSkill(ref));
    return applyOverlay(base, content.overlay, recipeLayer, (ref) => added.get(ref.skillId)!);
  }

  const recipe = await layer(agentId, version, []);
  const problems = recipeProblems(recipe);
  if (problems.length > 0) throw problemsError(problems);
  return recipe;
}

/** Whether the base the agent's draft builds on has moved past the version it pinned: a custom base's current version, or the org's pin of a built-in (what `updateBase` would move to). */
export async function updateAvailable(store: AgentStore, orgId: OrgId, agentId: AgentId): Promise<{ from: number; to: number } | undefined> {
  if (isBuiltinAgentId(agentId)) return undefined;
  const agent = await store.get(orgId, agentId);
  if (agent === undefined) throw notFound();
  const base = (await store.getDraft(orgId, agentId))?.extends;
  if (base === undefined) return undefined;
  let latest: number | undefined;
  if (isBuiltinAgentId(base.agentId)) {
    latest = await store.pinnedBuiltinVersion(orgId, base.agentId);
  } else {
    const record = await store.get(orgId, base.agentId);
    latest = record?.status === "active" ? record.currentVersion : undefined;
  }
  return latest !== undefined && latest > base.version ? { from: base.version, to: latest } : undefined;
}
