// packages/broker/src/agents/store.ts
// The agent store: an agent's META, its DRAFT, immutable numbered versions, the org's name and directory
// items and one EVENT# item per notable write. Every multi-item write is one transaction, so a refused
// write leaves nothing behind. An agent builds on another by a pinned version (`BaseRef`): the base moving
// on changes nothing until the agent's owner takes the update. `resolveAgent` follows those pins down to a
// built-in version or the empty recipe and applies each layer's overlay on the way back up.
import { randomBytes } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
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

  /** The one EVENT# item a write leaves. The sequence keeps one process's events in order; the random tail keeps two processes' apart. */
  private event(orgId: OrgId, agentId: AgentId, kind: AgentEventKind, by: string, detail: Item = {}): TransactItem {
    const at = this.iso();
    const tail = `${String(++this.eventSequence).padStart(6, "0")}-${randomBytes(3).toString("hex")}`;
    return this.put(agentKey(orgId, agentId, `EVENT#${at}#${tail}`), "AGENT_EVENT", { orgId, agentId, kind, at, by, ...detail });
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
    await this.commit([
      this.update(builtinSettingsKey(input.orgId, input.agentId), {
        set: { pinnedVersion: input.version, updatedBy: input.by, updatedAt },
        when: (a) => `${a.name("pinnedVersion")} = ${a.value(input.expectedPinnedVersion)}`,
      }),
      this.event(input.orgId, input.agentId, "base_updated", input.by, { from: input.expectedPinnedVersion, to: input.version }),
    ], () => conflict(), input.request, { settings: adopted, previous: input.expectedPinnedVersion });
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
  async publish(input: { orgId: OrgId; agentId: AgentId; expectedDraftRevision: number; digest: string; note?: string; by: string; expectedCurrentVersion?: number | null; skillDigests?: Readonly<Record<string, string>>; request?: RequestMark }): Promise<AgentVersion> {
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
    await this.commit([
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
      this.event(input.orgId, input.agentId, "published", input.by, { version, digest: input.digest, ...(input.note === undefined ? {} : { note: input.note }) }),
      ...(pinned?.checks ?? []),
    ], () => conflict(), input.request, published);
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
    await this.commit([
      this.update(agentKey(input.orgId, input.agentId, "META"), {
        set: { currentVersion: input.version, updatedAt },
        when: (a) => `${a.name("currentVersion")} = ${a.value(input.expectedCurrentVersion)}`,
      }),
      this.event(input.orgId, input.agentId, "rolled_back", input.by, { from: input.expectedCurrentVersion, to: input.version }),
    ], () => conflict(), input.request, rolled);
    return rolled;
  }

  private async setStatus(orgId: OrgId, agentId: AgentId, status: "active" | "archived", by: string, request?: RequestMark): Promise<AgentRecord> {
    if (isBuiltinAgentId(agentId)) throw coded("CONFIG_INVALID", `${this.builtins.name(agentId)} is built in and can't be archived`);
    const agent = await this.require(orgId, agentId);
    if (agent.status === status) return agent;
    const updatedAt = this.iso();
    const changed: AgentRecord = { ...agent, status, updatedAt };
    await this.commit([
      this.update(agentKey(orgId, agentId, "META"), { set: { status, updatedAt }, when: (a) => `${a.name("status")} = ${a.value(agent.status)}` }),
      this.event(orgId, agentId, status === "archived" ? "archived" : "unarchived", by),
    ], () => conflict(), request, changed);
    return changed;
  }

  archive(orgId: OrgId, agentId: AgentId, by: string, request?: RequestMark): Promise<AgentRecord> {
    return this.setStatus(orgId, agentId, "archived", by, request);
  }

  unarchive(orgId: OrgId, agentId: AgentId, by: string, request?: RequestMark): Promise<AgentRecord> {
    return this.setStatus(orgId, agentId, "active", by, request);
  }

  /** Sets the budget limits; a number sets, `null` clears and a limit left out stays. A built-in's go on the org's settings for it. */
  async setBudget(orgId: OrgId, agentId: AgentId, budget: { monthlyUsd?: number | null; maxPerRunUsd?: number | null }, by: string): Promise<void> {
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
    if (isBuiltinAgentId(agentId)) {
      await this.ensureBuiltinSettings(orgId, agentId, by);
      key = builtinSettingsKey(orgId, agentId);
      set["updatedBy"] = by;
    } else {
      await this.require(orgId, agentId);
      key = agentKey(orgId, agentId, "META");
    }
    await this.transact([
      this.update(key, { set, ...(remove.length > 0 ? { remove } : {}) }),
      this.event(orgId, agentId, "budget_changed", by, withoutUndefined(detail)),
    ], () => undefined);
  }

  /**
   * Moves a custom agent to another owner. A project's agent needs `accountable`; a member's has none. Who may do this,
   * and whether the new owner's budget total allows it, is the route's check.
   */
  async setOwner(orgId: OrgId, agentId: AgentId, owner: AgentOwner, by: string, accountable?: { developerId: string }, request?: RequestMark): Promise<AgentRecord> {
    if (isBuiltinAgentId(agentId)) throw coded("CONFIG_INVALID", `${this.builtins.name(agentId)} is built in and belongs to the whole company`);
    if (owner.kind === "project" && accountable === undefined) throw coded("CONFIG_INVALID", "accountable: a project's agent needs an accountable maintainer");
    if (owner.kind === "member" && accountable !== undefined) throw coded("CONFIG_INVALID", "accountable: only a project's agent has an accountable maintainer");
    const agent = await this.require(orgId, agentId);
    const updatedAt = this.iso();
    const { accountable: _before, ...rest } = agent; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped when the new owner has none
    const moved: AgentRecord = { ...rest, owner, ...(accountable === undefined ? {} : { accountable }), updatedAt };
    await this.commit([
      this.update(agentKey(orgId, agentId, "META"), {
        set: { owner, accountable, updatedAt },
        ...(accountable === undefined ? { remove: ["accountable"] } : {}),
        when: (a) => `${a.name("updatedAt")} = ${a.value(agent.updatedAt)}`,
      }),
      this.event(orgId, agentId, "owner_changed", by, { from: agent.owner, to: owner, ...(accountable === undefined ? {} : { accountable }) }),
    ], () => conflict(), request, moved);
    return moved;
  }

  /**
   * Changes the maintainer answerable for a project's agent (or the org's one for a built-in). That the new person holds
   * `manage_agents` on the project is the route's check.
   */
  async setAccountable(orgId: OrgId, agentId: AgentId, accountable: { developerId: string }, by: string, request?: RequestMark): Promise<void> {
    const updatedAt = this.iso();
    if (isBuiltinAgentId(agentId)) {
      const before = await this.ensureBuiltinSettings(orgId, agentId, by);
      await this.commit([
        this.update(builtinSettingsKey(orgId, agentId), { set: { accountable, updatedBy: by, updatedAt } }),
        this.event(orgId, agentId, "owner_changed", by, { accountable, ...(before.accountable === undefined ? {} : { from: before.accountable }) }),
      ], () => undefined, request, { accountable });
      return;
    }
    const agent = await this.require(orgId, agentId);
    if (agent.owner.kind !== "project") throw coded("CONFIG_INVALID", "accountable: only a project's agent has an accountable maintainer");
    await this.commit([
      this.update(agentKey(orgId, agentId, "META"), { set: { accountable, updatedAt }, when: (a) => `${a.name("updatedAt")} = ${a.value(agent.updatedAt)}` }),
      this.event(orgId, agentId, "owner_changed", by, { accountable, ...(agent.accountable === undefined ? {} : { from: agent.accountable }) }),
    ], () => conflict(), request, { accountable });
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

  /**
   * Makes `guardrails` the org's agent guardrails (the caller has checked who may, and what is less safe). It applies only while the
   * document is still at `expectedRevision` (0 before the first write), so of two concurrent writes one wins and the other conflicts.
   * Returns the document as stored, with its new revision; that is also what a repeat of the request is answered with.
   */
  async putGuardrails(input: { orgId: OrgId; guardrails: AgentGuardrails; expectedRevision: number; by: string; request?: RequestMark }): Promise<{ guardrails: AgentGuardrails; revision: number }> {
    const expected = input.expectedRevision;
    const stored = { guardrails: input.guardrails, revision: expected + 1 };
    const aliases = new Aliases();
    const item: TransactItem = {
      Put: {
        TableName: this.input.tableName,
        Item: { ...agentGuardrailsKey(input.orgId), entityType: "AGENT_GUARDRAILS", revision: stored.revision, guardrails: withoutUndefined(input.guardrails as unknown as Item), updatedBy: input.by, updatedAt: this.iso() },
        ConditionExpression: expected === 0 ? NOT_EXISTS : `${aliases.name("revision")} = ${aliases.value(expected)}`,
        ...(expected === 0 ? {} : { ExpressionAttributeNames: aliases.names, ExpressionAttributeValues: aliases.values }),
      },
    };
    await this.commit([item], () => guardrailsConflict(), input.request, stored);
    return stored;
  }
}

export interface ResolveOptions {
  /** Looks up an added skill's name and digest. Without it, the org's skill registry (`store.skills`) does. */
  resolveSkill?: (ref: SkillRef) => ResolvedSkill | Promise<ResolvedSkill>;
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
      const draft = await store.getDraft(orgId, id);
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
