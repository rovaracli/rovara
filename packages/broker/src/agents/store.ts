// packages/broker/src/agents/store.ts
// The agent store: an agent's META, its DRAFT, immutable numbered versions, the org's name and directory
// items and one EVENT# item per notable write. Every multi-item write is one transaction, so a refused
// write leaves nothing behind. An agent builds on another by a pinned version (`BaseRef`): the base moving
// on changes nothing until the agent's owner takes the update. `resolveAgent` follows those pins down to a
// built-in version or the empty recipe and applies each layer's overlay on the way back up.
import { randomBytes } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  AGENT_DESCRIPTION_MAX,
  AGENT_NAME_MAX,
  BUILTIN_AGENTS,
  EMPTY_RECIPE,
  RecipeOverlaySchema,
  agentDirectoryKey,
  agentKey,
  agentNameKey,
  agentVersionSk,
  agentXError,
  applyOverlay,
  builtinRecipe,
  builtinSettingsKey,
  currentBuiltinVersion,
  formatRecipeProblem,
  isBuiltinAgentId,
  newPrefixedId,
  orgScoped,
  overlayProblems,
  recipeProblems,
  type AgentId,
  type AgentOwner,
  type AgentXErrorCode,
  type BaseRef,
  type OrgId,
  type OrgKey,
  type RecipeLayer,
  type RecipeOverlay,
  type ResolvedRecipe,
  type ResolvedSkill,
  type SkillRef,
} from "@agentx/contracts";

/** PF28: the most custom layers a recipe can be built from; a built-in base underneath is not counted. */
export const MAX_CUSTOM_LAYERS = 3;
const NOT_EXISTS = "attribute_not_exists(pk)";
const EXISTS = "attribute_exists(pk)";
const SHA256_HEX = /^[a-f0-9]{64}$/;

type Item = Record<string, unknown>;
type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];

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
}

const SHIPPED_BUILTINS: BuiltinSource = {
  currentVersion: (id) => currentBuiltinVersion(id as Parameters<typeof currentBuiltinVersion>[0]),
  recipe: (id, version) => builtinRecipe(id as Parameters<typeof builtinRecipe>[0], version),
  name: (id) => BUILTIN_AGENTS[id as keyof typeof BUILTIN_AGENTS].name,
};

const coded = (code: AgentXErrorCode, message: string) => agentXError(code, message);
const notFound = () => coded("NOT_FOUND", "no agent has that ID");
const conflict = () => coded("AGENT_REVISION_CONFLICT", "Someone else changed this agent's draft. Reload it and make your change again.");
const nameTaken = (name: string) => coded("CONFIG_INVALID", `name: another agent in your company is called ${name}`);

const errorName = (error: unknown) => (error instanceof Error ? error.name : undefined);

/** The indexes of the TransactItems whose own condition failed; undefined when the error is not a cancellation. */
function failedIndexes(error: unknown): Set<number> | undefined {
  if (errorName(error) !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: unknown }).CancellationReasons;
  if (!Array.isArray(reasons)) return undefined;
  const failed = new Set<number>();
  reasons.forEach((reason: { Code?: string } | undefined, index) => {
    if (reason?.Code === "ConditionalCheckFailed") failed.add(index);
  });
  return failed;
}

function strip<T extends Item>(item: T): Omit<T, "pk" | "sk" | "entityType"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the keys
  const { pk: _pk, sk: _sk, entityType: _type, ...rest } = item;
  return rest;
}

/** Collects the `#name` and `:value` aliases of one expression, so no attribute name can hit a reserved word. */
class Aliases {
  readonly names: Record<string, string> = {};
  readonly values: Record<string, unknown> = {};
  private next = 0;

  name(attribute: string): string {
    const existing = Object.entries(this.names).find(([, name]) => name === attribute);
    if (existing) return existing[0];
    const alias = `#n${String(this.next++)}`;
    this.names[alias] = attribute;
    return alias;
  }

  value(value: unknown): string {
    const alias = `:v${String(this.next++)}`;
    this.values[alias] = value;
    return alias;
  }
}

const withoutUndefined = <T extends Item>(item: T): T => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined)) as T;

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

  constructor(private readonly input: AgentStoreInput) {
    this.newId = input.newId ?? (() => newPrefixedId("agt"));
    this.builtins = input.builtins ?? SHIPPED_BUILTINS;
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
    return { Put: { TableName: this.input.tableName, Item: { ...key, entityType, ...withoutUndefined(fields) }, ConditionExpression: NOT_EXISTS } };
  }

  /** An Update of one item: `set` values (undefined skipped), `remove` attributes and a condition built from the same aliases. */
  private update(key: OrgKey, change: { set?: Item; remove?: string[]; when?: (aliases: Aliases) => string }): TransactItem {
    const aliases = new Aliases();
    const sets = Object.entries(change.set ?? {}).filter(([, value]) => value !== undefined).map(([name, value]) => `${aliases.name(name)} = ${aliases.value(value)}`);
    const removes = (change.remove ?? []).map((name) => aliases.name(name));
    const expression = [sets.length > 0 ? `SET ${sets.join(", ")}` : "", removes.length > 0 ? `REMOVE ${removes.join(", ")}` : ""].filter(Boolean).join(" ");
    const condition = change.when?.(aliases) ?? EXISTS;
    return {
      Update: {
        TableName: this.input.tableName,
        Key: key,
        UpdateExpression: expression,
        ConditionExpression: condition,
        ExpressionAttributeNames: aliases.names,
        ...(Object.keys(aliases.values).length > 0 ? { ExpressionAttributeValues: aliases.values } : {}),
      },
    };
  }

  /** The one EVENT# item a write leaves. The sequence keeps one process's events in order; the random tail keeps two processes' apart. */
  private event(orgId: OrgId, agentId: AgentId, kind: AgentEventKind, by: string, detail: Item = {}): TransactItem {
    const at = this.iso();
    const tail = `${String(++this.eventSequence).padStart(6, "0")}-${randomBytes(3).toString("hex")}`;
    return this.put(agentKey(orgId, agentId, `EVENT#${at}#${tail}`), "AGENT_EVENT", { orgId, agentId, kind, at, by, ...detail });
  }

  private async transact(items: TransactItem[], refuse: (failed: Set<number>) => Error | undefined): Promise<void> {
    try {
      await this.input.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      const failed = failedIndexes(error);
      const refusal = failed === undefined ? undefined : refuse(failed);
      throw refusal ?? error;
    }
  }

  // ---- reads

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

  /** Moves the org's pin of a built-in to a released version (the route limits this to org owners and admins). */
  async adoptBuiltinVersion(input: { orgId: OrgId; agentId: AgentId; version: number; by: string }): Promise<BuiltinSettings> {
    this.requireBuiltin(input.agentId);
    if (!Number.isInteger(input.version) || input.version < 1 || input.version > this.builtins.currentVersion(input.agentId)) {
      throw coded("NOT_FOUND", `${this.builtins.name(input.agentId)} has no version ${String(input.version)}`);
    }
    const before = await this.ensureBuiltinSettings(input.orgId, input.agentId, input.by);
    const updatedAt = this.iso();
    await this.transact([
      this.update(builtinSettingsKey(input.orgId, input.agentId), { set: { pinnedVersion: input.version, updatedBy: input.by, updatedAt } }),
      this.event(input.orgId, input.agentId, "base_updated", input.by, { from: before.pinnedVersion, to: input.version }),
    ], () => undefined);
    return { ...before, pinnedVersion: input.version, updatedBy: input.by, updatedAt };
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
  }): Promise<AgentRecord> {
    const name = input.name.trim();
    const description = input.description ?? "";
    checkProfile(name, description);
    if (this.reservedName(name)) throw nameTaken(name);
    if (input.owner.kind === "project" && input.accountable === undefined) throw coded("CONFIG_INVALID", "accountable: a project's agent needs an accountable maintainer");
    if (input.owner.kind === "member" && input.accountable !== undefined) throw coded("CONFIG_INVALID", "accountable: only a project's agent has an accountable maintainer");
    const overlay = parseOverlay(input.overlay ?? {});
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
    await this.transact([
      this.put(agentKey(input.orgId, agentId, "META"), "AGENT", agent as unknown as Item),
      this.put(agentKey(input.orgId, agentId, "DRAFT"), "AGENT_DRAFT", draft as unknown as Item),
      this.put(agentDirectoryKey(input.orgId, agentId), "AGENT_DIRECTORY", { agentId, createdAt: now }),
      this.put(agentNameKey(input.orgId, name), "AGENT_NAME", { agentId, createdAt: now }),
      this.event(input.orgId, agentId, "created", input.createdBy, { name, ...(base === undefined ? {} : { extends: base }) }),
    ], (failed) => (failed.has(3) ? nameTaken(name) : undefined));
    return agent;
  }

  /**
   * Saves the draft's overlay when `expectedRevision` is still its revision. `extends` picks another base (pinned to
   * its current version; the same base keeps its pin) or, as `null`, none; left out, the base stays as it is.
   */
  async saveDraft(input: { orgId: OrgId; agentId: AgentId; overlay: RecipeOverlay; extends?: AgentId | null; expectedRevision: number; by: string }): Promise<AgentDraft> {
    const overlay = parseOverlay(input.overlay);
    const agent = await this.require(input.orgId, input.agentId);
    const draft = await this.getDraft(input.orgId, input.agentId);
    if (draft === undefined) throw notFound();
    if (draft.revision !== input.expectedRevision) throw conflict();
    let base: BaseRef | undefined = draft.extends;
    if (input.extends === null) base = undefined;
    else if (input.extends !== undefined && input.extends !== draft.extends?.agentId) {
      if (input.extends === input.agentId) throw coded("CONFIG_INVALID", "extends: an agent can't build on itself");
      base = await this.pinTarget(input.orgId, input.extends, agent.name);
    }
    const revision = draft.revision + 1;
    const updatedAt = this.iso();
    await this.transact([
      this.update(agentKey(input.orgId, input.agentId, "DRAFT"), {
        set: { overlay, revision, updatedBy: input.by, updatedAt, extends: base },
        ...(base === undefined ? { remove: ["extends"] } : {}),
        when: (a) => `${a.name("revision")} = ${a.value(input.expectedRevision)}`,
      }),
      this.update(agentKey(input.orgId, input.agentId, "META"), {
        set: { draftRevision: revision, updatedAt },
        when: (a) => `${a.name("draftRevision")} = ${a.value(input.expectedRevision)}`,
      }),
    ], () => conflict());
    return { overlay, ...(base === undefined ? {} : { extends: base }), revision, updatedBy: input.by, updatedAt };
  }

  /** Changes the name or description. A rename swaps the name item, so the new name is checked and the old one freed together. */
  async updateProfile(input: { orgId: OrgId; agentId: AgentId; name?: string; description?: string; by: string }): Promise<AgentRecord> {
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
    await this.transact(items, (failed) => (failed.has(1) ? nameTaken(name) : conflict()));
    return { ...agent, name, description, updatedAt };
  }

  /**
   * Publishes the draft as version `latestVersion + 1`. The version item must not exist and the agent must still be at
   * the `latestVersion` and draft revision read here, so of two concurrent publishes one wins and the other conflicts.
   */
  async publish(input: { orgId: OrgId; agentId: AgentId; expectedDraftRevision: number; digest: string; note?: string; by: string }): Promise<AgentVersion> {
    if (!SHA256_HEX.test(input.digest)) throw coded("CONFIG_INVALID", "digest: must be the recipe's SHA-256 digest");
    const agent = await this.require(input.orgId, input.agentId);
    const draft = await this.getDraft(input.orgId, input.agentId);
    if (draft === undefined) throw notFound();
    if (agent.draftRevision !== input.expectedDraftRevision || draft.revision !== input.expectedDraftRevision) throw conflict();
    const n = agent.latestVersion;
    const version = n + 1;
    const publishedAt = this.iso();
    const published: AgentVersion = {
      version,
      overlay: draft.overlay,
      ...(draft.extends === undefined ? {} : { extends: draft.extends }),
      name: agent.name,
      description: agent.description,
      digest: input.digest,
      publishedBy: input.by,
      publishedAt,
      ...(input.note === undefined ? {} : { note: input.note }),
    };
    await this.transact([
      this.put(agentKey(input.orgId, input.agentId, agentVersionSk(version)), "AGENT_VERSION", published as unknown as Item),
      this.update(agentKey(input.orgId, input.agentId, "META"), {
        set: { currentVersion: version, latestVersion: version, updatedAt: publishedAt },
        when: (a) => [
          `${a.name("latestVersion")} = ${a.value(n)}`,
          `${a.name("draftRevision")} = ${a.value(input.expectedDraftRevision)}`,
          `${a.name("name")} = ${a.value(agent.name)}`,
          `${a.name("description")} = ${a.value(agent.description)}`,
        ].join(" AND "),
      }),
      this.event(input.orgId, input.agentId, "published", input.by, { version, digest: input.digest, ...(input.note === undefined ? {} : { note: input.note }) }),
    ], () => conflict());
    return published;
  }

  /** Makes an earlier published version the current one. Later versions stay, and the next publish still numbers after them. */
  async rollback(input: { orgId: OrgId; agentId: AgentId; version: number; by: string }): Promise<AgentRecord> {
    const agent = await this.require(input.orgId, input.agentId);
    if (await this.getVersion(input.orgId, input.agentId, input.version) === undefined) throw coded("NOT_FOUND", `${agent.name} has no version ${String(input.version)}`);
    const updatedAt = this.iso();
    await this.transact([
      this.update(agentKey(input.orgId, input.agentId, "META"), { set: { currentVersion: input.version, updatedAt } }),
      this.event(input.orgId, input.agentId, "rolled_back", input.by, { from: agent.currentVersion, to: input.version }),
    ], () => undefined);
    return { ...agent, currentVersion: input.version, updatedAt };
  }

  private async setStatus(orgId: OrgId, agentId: AgentId, status: "active" | "archived", by: string): Promise<AgentRecord> {
    if (isBuiltinAgentId(agentId)) throw coded("CONFIG_INVALID", `${this.builtins.name(agentId)} is built in and can't be archived`);
    const agent = await this.require(orgId, agentId);
    if (agent.status === status) return agent;
    const updatedAt = this.iso();
    await this.transact([
      this.update(agentKey(orgId, agentId, "META"), { set: { status, updatedAt }, when: (a) => `${a.name("status")} = ${a.value(agent.status)}` }),
      this.event(orgId, agentId, status === "archived" ? "archived" : "unarchived", by),
    ], () => conflict());
    return { ...agent, status, updatedAt };
  }

  archive(orgId: OrgId, agentId: AgentId, by: string): Promise<AgentRecord> {
    return this.setStatus(orgId, agentId, "archived", by);
  }

  unarchive(orgId: OrgId, agentId: AgentId, by: string): Promise<AgentRecord> {
    return this.setStatus(orgId, agentId, "active", by);
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
  async setOwner(orgId: OrgId, agentId: AgentId, owner: AgentOwner, by: string, accountable?: { developerId: string }): Promise<AgentRecord> {
    if (isBuiltinAgentId(agentId)) throw coded("CONFIG_INVALID", `${this.builtins.name(agentId)} is built in and belongs to the whole company`);
    if (owner.kind === "project" && accountable === undefined) throw coded("CONFIG_INVALID", "accountable: a project's agent needs an accountable maintainer");
    if (owner.kind === "member" && accountable !== undefined) throw coded("CONFIG_INVALID", "accountable: only a project's agent has an accountable maintainer");
    const agent = await this.require(orgId, agentId);
    const updatedAt = this.iso();
    await this.transact([
      this.update(agentKey(orgId, agentId, "META"), {
        set: { owner, accountable, updatedAt },
        ...(accountable === undefined ? { remove: ["accountable"] } : {}),
        when: (a) => `${a.name("updatedAt")} = ${a.value(agent.updatedAt)}`,
      }),
      this.event(orgId, agentId, "owner_changed", by, { from: agent.owner, to: owner, ...(accountable === undefined ? {} : { accountable }) }),
    ], () => conflict());
    const { accountable: _before, ...rest } = agent; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped when the new owner has none
    return { ...rest, owner, ...(accountable === undefined ? {} : { accountable }), updatedAt };
  }

  /**
   * Changes the maintainer answerable for a project's agent (or the org's one for a built-in). That the new person holds
   * `manage_agents` on the project is the route's check.
   */
  async setAccountable(orgId: OrgId, agentId: AgentId, accountable: { developerId: string }, by: string): Promise<void> {
    const updatedAt = this.iso();
    if (isBuiltinAgentId(agentId)) {
      const before = await this.ensureBuiltinSettings(orgId, agentId, by);
      await this.transact([
        this.update(builtinSettingsKey(orgId, agentId), { set: { accountable, updatedBy: by, updatedAt } }),
        this.event(orgId, agentId, "owner_changed", by, { accountable, ...(before.accountable === undefined ? {} : { from: before.accountable }) }),
      ], () => undefined);
      return;
    }
    const agent = await this.require(orgId, agentId);
    if (agent.owner.kind !== "project") throw coded("CONFIG_INVALID", "accountable: only a project's agent has an accountable maintainer");
    await this.transact([
      this.update(agentKey(orgId, agentId, "META"), { set: { accountable, updatedAt }, when: (a) => `${a.name("updatedAt")} = ${a.value(agent.updatedAt)}` }),
      this.event(orgId, agentId, "owner_changed", by, { accountable, ...(agent.accountable === undefined ? {} : { from: agent.accountable }) }),
    ], () => conflict());
  }

  /**
   * Moves the draft's base to the version it would be pinned to today: a custom base's current version, or the org's pin
   * of a built-in. The draft changes (and its revision with it); nothing is published.
   */
  async updateBase(input: { orgId: OrgId; agentId: AgentId; expectedRevision: number; by: string }): Promise<AgentDraft> {
    const agent = await this.require(input.orgId, input.agentId);
    const draft = await this.getDraft(input.orgId, input.agentId);
    if (draft === undefined) throw notFound();
    if (draft.revision !== input.expectedRevision) throw conflict();
    if (draft.extends === undefined) throw coded("CONFIG_INVALID", `${agent.name} is built from scratch, so it has no base to update`);
    const target = await this.pinTarget(input.orgId, draft.extends.agentId, agent.name);
    if (target.version === draft.extends.version) return draft;
    const revision = draft.revision + 1;
    const updatedAt = this.iso();
    await this.transact([
      this.update(agentKey(input.orgId, input.agentId, "DRAFT"), {
        set: { extends: target, revision, updatedBy: input.by, updatedAt },
        when: (a) => `${a.name("revision")} = ${a.value(input.expectedRevision)}`,
      }),
      this.update(agentKey(input.orgId, input.agentId, "META"), {
        set: { draftRevision: revision, updatedAt },
        when: (a) => `${a.name("draftRevision")} = ${a.value(input.expectedRevision)}`,
      }),
      this.event(input.orgId, input.agentId, "base_updated", input.by, { base: target.agentId, from: draft.extends.version, to: target.version }),
    ], () => conflict());
    return { ...draft, extends: target, revision, updatedBy: input.by, updatedAt };
  }
}

export interface ResolveOptions {
  /** Looks up an added skill's name and digest (Task 9's skill store). Without it, an overlay that adds a skill is refused. */
  resolveSkill?: (ref: SkillRef) => ResolvedSkill;
}

function problemsError(problems: Array<{ path: string; message: string }>): Error {
  return coded("CONFIG_INVALID", problems.map(formatRecipeProblem).join("; "));
}

function refuseSkills(): ResolvedSkill {
  throw coded("CONFIG_INVALID", "skills.add: skills can't be added to an agent yet");
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
  const resolveSkill = options.resolveSkill ?? refuseSkills;

  async function layer(id: AgentId, wanted: number | "current" | "draft", trail: Array<{ agentId: AgentId; name: string }>): Promise<ResolvedRecipe> {
    if (isBuiltinAgentId(id)) {
      return store.builtinRecipe(id, typeof wanted === "number" ? wanted : await store.pinnedBuiltinVersion(orgId, id));
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
    return applyOverlay(base, content.overlay, recipeLayer, resolveSkill);
  }

  const recipe = await layer(agentId, version, []);
  const problems = recipeProblems(recipe);
  if (problems.length > 0) throw problemsError(problems);
  return recipe;
}

/** Whether the base the agent's draft builds on has moved past the version it pinned: a custom base's current version, or a built-in's newest release. */
export async function updateAvailable(store: AgentStore, orgId: OrgId, agentId: AgentId): Promise<{ from: number; to: number } | undefined> {
  if (isBuiltinAgentId(agentId)) return undefined;
  const agent = await store.get(orgId, agentId);
  if (agent === undefined) throw notFound();
  const base = (await store.getDraft(orgId, agentId))?.extends;
  if (base === undefined) return undefined;
  let latest: number | undefined;
  if (isBuiltinAgentId(base.agentId)) {
    latest = store.builtinLatestVersion(base.agentId);
  } else {
    const record = await store.get(orgId, base.agentId);
    latest = record?.status === "active" ? record.currentVersion : undefined;
  }
  return latest !== undefined && latest > base.version ? { from: base.version, to: latest } : undefined;
}
