// packages/broker/src/agents/store.ts
// The agent store: an agent's META, its DRAFT, immutable numbered versions, the org's name and directory
// items and one EVENT# item per notable write. Every multi-item write is one transaction, so a refused
// write leaves nothing behind. An agent builds on another by a pinned version (`BaseRef`): the base moving
// on changes nothing until the agent's owner takes the update. `resolveAgent` follows those pins down to a
// built-in version or the empty recipe and applies each layer's overlay on the way back up.
import { unarchiveActorChecks, budgetActorChecks, budgetActorRefused, type BudgetActor } from "./budget-authority.js";
import { usdToWholeMicrodollars } from "../org/budget-amount.js";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  AGENT_DESCRIPTION_MAX,
  AGENT_NAME_MAX,
  AgentOriginSchema,
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
  builtinDefaultPin,
  currentBuiltinVersion,
  formatRecipeProblem,
  isBuiltinAgentId,
  newPrefixedId,
  orgScoped,
  overlayProblems,
  recipeProblems,
  sameJsonContent,
  type AgentGuardrails,
  type AgentId,
  type AgentOrigin,
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
  Aliases, NOT_EXISTS, REQUEST_MEMORY_DAYS, coded, errorName, strip, withoutUndefined,
  type Item, type RequestMark, type TransactItem,
} from "./table-writes.js";
import { AGENT_KIND, OwnedStore, type AgentShareLevel, type MoveCause } from "./owned-store.js";
import { SkillStore } from "./skills.js";
import { ownerShare, withBudgetFields, type BudgetSubject } from "../spend/owner-total.js";
import { OwnerBudgets, budgetGuard, overrideDetail, ownerOverCap, totalsMoved, withOverride, type OverrideCap, type OwnerCap } from "../spend/owner-budgets.js";
import { cleanUsd } from "../spend/top-ups.js";
import { auditBuiltinAdopted, auditGuardrailsChanged, auditOccurrence, auditProcessPublished, auditPublished } from "../audit/events.js";
import { inertProcessOverlay } from "../playbook/inert-rule-text.js";
import { requireRovaraCodeBaseForProcess } from "../playbook/process-base.js";
import { requireBaseIsNotProcess, requireNoOwnerMoveOnProcess, requireNoSharesOnProcess } from "../playbook/process-closed-routes.js";
import { requireNoSequenceForProcess } from "../playbook/process-sequence.js";
import { requireNoSkillsForProcess } from "../playbook/process-skills.js";
import { requireNoNewPullRequestInstructionsForProcess, requireNoNewPullRequestInstructionsToPublish } from "../playbook/process-pull-request.js";
import { flushAuditEvents } from "../audit/flush.js";
import { type AuditRuntime } from "../audit/outbox.js";
import { accountableChangedEvent, agentBudgetEvents, auditActorOf, ownerMovedEvent } from "../audit/plan3-hooks.js";

/** PF28: the most custom layers a recipe can be built from; a built-in base underneath is not counted. */
export const MAX_CUSTOM_LAYERS = 3;
export { REQUEST_MEMORY_DAYS, type RequestMark };
const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface AgentRecord {
  /** Present after the reviewed task-stop seed; absent legacy metadata is never guessed. */
  stopKind?: "inherit" | "limited";
  revision?: number;
  orgId: OrgId;
  agentId: AgentId;
  name: string;
  description: string;
  owner: AgentOwner;
  accountable?: { developerId: string };
  /** `process`: a project's process layer ("How we work"), never offered as an agent. Absent for every ordinary agent. */
  purpose?: "process";
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
  /** Task 10c: the session the agent was made from. Set once, by the create-from-session route; every later draft keeps it and each version published from the draft copies it. Drafts from before have none. */
  origin?: AgentOrigin;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

export interface AgentVersion {
  version: number;
  overlay: RecipeOverlay;
  extends?: BaseRef;
  /** Task 10c: copied unchanged from the draft this version was published from. */
  origin?: AgentOrigin;
  name: string;
  description: string;
  digest: string;
  publishedBy: string;
  publishedAt: string;
  note?: string;
}

export { MAX_SHARE_CHANGES_PER_SAVE, type AgentShareLevel, type AgentShareRecord, type MoveCause } from "./owned-store.js";
export { isOwnerCapRefusal, type OwnerCap } from "../spend/owner-budgets.js";

export interface BuiltinSettings {
  stopKind?: "inherit" | "limited";
  revision?: number;
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
  /** The version an org runs before it has settings for the built-in (Rovara Code stays on 1 until an admin adopts 2; every other built-in reads the newest release). */
  defaultPin(id: AgentId): number;
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
  /** The ledger of monthly totals per person. Left out, the store makes its own; the chain store is given this one so both add to one total. */
  ownerBudgets?: OwnerBudgets;
  /**
   * The Audit Ledger's outbox. With it, a publish, rollback, adoption, owner or accountable change, budget change and guardrails write adds its
   * pending audit item to the transaction that commits it. Absent on a legacy install: nothing is added.
   */
  audit?: AuditRuntime;
}

const SHIPPED_BUILTINS: BuiltinSource = {
  currentVersion: (id) => currentBuiltinVersion(id as Parameters<typeof currentBuiltinVersion>[0]),
  defaultPin: (id) => builtinDefaultPin(id as Parameters<typeof builtinDefaultPin>[0]),
  recipe: (id, version) => builtinRecipe(id as Parameters<typeof builtinRecipe>[0], version),
  name: (id) => BUILTIN_AGENTS[id as keyof typeof BUILTIN_AGENTS].name,
};

const notFound = () => coded("NOT_FOUND", "no agent has that ID");
const conflict = () => coded("AGENT_REVISION_CONFLICT", "Someone else changed this agent's draft. Reload it and make your change again.");
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

/** What a write that changes whose total a budget is in can ask of the store (Task 28). */
export interface BudgetWriteOptions {
  /** Required on request-bearing/approval budget writes; never supplied by an HTTP body. */
  actor?: BudgetActor;
  /** The per-run value the request reviewed, null for confirmed absence. */
  expectedMaxPerRunUsd?: number | null;
  /** Resource fields on which the route granted manage access; never from a client. */
  manageSnapshot?: BudgetSubject;
  /** Original server-read builtin settings; null means confirmed absence. */
  builtinSnapshot?: BuiltinSettings | null;
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
  overrideCap?: OverrideCap;
  /** Condition checks that must hold when the write commits, and the refusal when one fails (a process layer's archive: the playbook still does not point at it). */
  checks?: { items: TransactItem[]; refused: () => Error };
}

const policyMoved = () => coded("AGENT_REVISION_CONFLICT", "Your company's spend policy changed just now. Reload and make your change again.");
const budgetConflict = () => coded("AGENT_REVISION_CONFLICT", "Someone else changed this agent's owner, status or budget just now. Reload it and make your change again.");

/** The counter items of one agent write, and what each refusal of them means. */
interface OwnerTotals {
  items: TransactItem[];
  /** Maps the indexes that failed (counting the agent's own item as 0) to the refusal they mean. */
  refuse: (failed: Set<number>) => Error;
}

function checkAmount(label: string, value: number | null | undefined): void {
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) throw coded("CONFIG_INVALID", `${label}: must be a number of dollars, zero or more`);
}

export class AgentStore extends OwnedStore<AgentId, AgentRecord, AgentVersion, AgentEventKind> {
  protected declare readonly input: AgentStoreInput;
  private readonly newId: () => AgentId;
  private readonly builtins: BuiltinSource;
  /** The monthly total each person's budgets count against; share it with the chain store so both add to one total. */
  readonly ownerBudgets: OwnerBudgets;
  /** The org's skills: a draft may only name ones the org has, publishing pins them, and a recipe resolves them from here. */
  readonly skills: SkillStore;

  constructor(input: AgentStoreInput) {
    super(input, AGENT_KIND);
    this.newId = input.newId ?? (() => newPrefixedId("agt"));
    this.builtins = input.builtins ?? SHIPPED_BUILTINS;
    this.skills = input.skills ?? new SkillStore({ documentClient: input.documentClient, tableName: input.tableName, now: input.now });
    this.ownerBudgets = input.ownerBudgets ?? new OwnerBudgets({ documentClient: input.documentClient, tableName: input.tableName, now: input.now, ...(input.resolveOwner === undefined ? {} : { resolveOwner: input.resolveOwner }) });
    this.ownerBudgets.register("agent", { sum: (orgId, _owner, counts) => this.sumAgentBudgets(orgId, counts) }, input);
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

  protected async require(orgId: OrgId, agentId: AgentId): Promise<AgentRecord> {
    const agent = await this.get(orgId, agentId);
    if (agent === undefined) throw notFound();
    return agent;
  }

  async getDraft(orgId: OrgId, agentId: AgentId): Promise<AgentDraft | undefined> {
    const item = await this.read(agentKey(orgId, agentId, "DRAFT"));
    return item === undefined ? undefined : (strip(item) as unknown as AgentDraft);
  }

  /** The org's custom agents, in the order of the directory (by id). */
  async list(orgId: OrgId): Promise<AgentRecord[]> {
    const directory = await this.queryAll(orgScoped(orgId, "AGENT_DIRECTORY"));
    const agents = await Promise.all(directory.map((entry) => this.get(orgId, entry.sk as AgentId)));
    return agents.filter((agent): agent is AgentRecord => agent !== undefined);
  }

  // ---- built-ins

  builtinName(agentId: AgentId): string {
    return this.builtins.name(agentId);
  }

  builtinLatestVersion(agentId: AgentId): number {
    return this.builtins.currentVersion(agentId);
  }

  /** The version the org runs while it has no settings for the built-in (`BuiltinSource.defaultPin`). */
  builtinDefaultPin(agentId: AgentId): number {
    return this.builtins.defaultPin(agentId);
  }

  builtinRecipe(agentId: AgentId, version: number): ResolvedRecipe {
    return this.builtins.recipe(agentId, version);
  }

  /** The org's settings for one built-in, or undefined while it has never changed any. */
  async getBuiltinSettings(orgId: OrgId, agentId: AgentId): Promise<BuiltinSettings | undefined> {
    const item = await this.read(builtinSettingsKey(orgId, agentId));
    return item === undefined ? undefined : (strip(item) as unknown as BuiltinSettings);
  }

  /** The version the org's own use of a built-in runs: its pin, or the default pin while it has no settings yet. */
  async pinnedBuiltinVersion(orgId: OrgId, agentId: AgentId): Promise<number> {
    return (await this.getBuiltinSettings(orgId, agentId))?.pinnedVersion ?? this.builtins.defaultPin(agentId);
  }

  /** Budget review reads the existing settings or a virtual default, without initializing a row. */
  async builtinBudgetSnapshot(orgId: OrgId, agentId: AgentId, by = "system"): Promise<BuiltinSettings> {
    this.requireBuiltin(agentId);
    return await this.getBuiltinSettings(orgId, agentId) ?? { pinnedVersion: this.builtins.defaultPin(agentId), updatedBy: by, updatedAt: this.iso() };
  }

  /** Creates the org's settings for a built-in, pinned to its default pin (the newest release, except Rovara Code's), if it has none; returns them either way. */
  async ensureBuiltinSettings(orgId: OrgId, agentId: AgentId, by = "system"): Promise<BuiltinSettings> {
    this.requireBuiltin(agentId);
    const existing = await this.getBuiltinSettings(orgId, agentId);
    if (existing !== undefined) return existing;
    const settings: BuiltinSettings = { pinnedVersion: this.builtins.defaultPin(agentId), updatedBy: by, updatedAt: this.iso() };
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
    // Nothing is built on a project's How we work.
    requireBaseIsNotProcess(base);
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
    /** Marks the agent as a project's process layer. Left out, it is an ordinary agent. */
    purpose?: "process";
    /** Task 10c: where the agent comes from. Only the create-from-session route passes it. */
    origin?: AgentOrigin;
    /** What the request's stored answer carries besides the agent (the create-from-session route's `copied` report); a repeat of the request reads it back. */
    answer?: Readonly<Record<string, unknown>>;
    createdBy: string;
    request?: RequestMark;
  }): Promise<AgentRecord> {
    const name = input.name.trim();
    const description = input.description ?? "";
    checkProfile(name, description);
    if (this.reservedName(name)) throw nameTaken(name);
    if (input.owner.kind === "project" && input.accountable === undefined) throw coded("CONFIG_INVALID", "accountable: a project's agent needs an accountable maintainer");
    if (input.owner.kind === "member" && input.accountable !== undefined) throw coded("CONFIG_INVALID", "accountable: only a project's agent has an accountable maintainer");
    const parsed = parseOverlay(input.overlay ?? {});
    requireNoSequenceForProcess({ purpose: input.purpose }, parsed);
    requireNoSkillsForProcess({ purpose: input.purpose }, parsed);
    requireNoNewPullRequestInstructionsForProcess({ purpose: input.purpose }, parsed);
    requireRovaraCodeBaseForProcess({ purpose: input.purpose }, input.extends);
    const overlay = inertProcessOverlay({ purpose: input.purpose }, parsed);
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
      ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
      latestVersion: 0,
      draftRevision: 1,
      revision: 1,
      stopKind: "inherit",
      status: "active",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    const origin = input.origin === undefined ? undefined : AgentOriginSchema.safeParse(input.origin);
    if (origin !== undefined && !origin.success) throw coded("CONFIG_INVALID", "origin: is not a session origin");
    const draft: AgentDraft = { overlay, ...(base === undefined ? {} : { extends: base }), ...(origin === undefined ? {} : { origin: origin.data }), revision: 1, updatedBy: input.createdBy, updatedAt: now };
    await this.commit([
      this.put(agentKey(input.orgId, agentId, "META"), "AGENT", agent as unknown as Item),
      this.put(agentKey(input.orgId, agentId, "DRAFT"), "AGENT_DRAFT", draft as unknown as Item),
      this.put(agentDirectoryKey(input.orgId, agentId), "AGENT_DIRECTORY", { agentId, createdAt: now }),
      this.put(agentNameKey(input.orgId, name), "AGENT_NAME", { agentId, createdAt: now }),
      this.event(input.orgId, agentId, "created", input.createdBy, { name, ...(base === undefined ? {} : { extends: base }) }),
    ], (failed) => (failed.has(3) ? nameTaken(name) : undefined), input.request, input.answer === undefined ? agent : { ...agent, ...input.answer });
    return agent;
  }

  /**
   * Saves the draft's overlay when `expectedRevision` is still its revision. `extends` picks another base (pinned to
   * its current version; the same base keeps its pin) or, as `null`, none; left out, the base stays as it is.
   */
  async saveDraft(input: { orgId: OrgId; agentId: AgentId; overlay: RecipeOverlay; extends?: AgentId | null; expectedRevision: number; by: string; request?: RequestMark }): Promise<AgentDraft> {
    const parsed = parseOverlay(input.overlay);
    const agent = await this.require(input.orgId, input.agentId);
    requireNoSequenceForProcess(agent, parsed);
    requireNoSkillsForProcess(agent, parsed);
    const overlay = inertProcessOverlay(agent, parsed);
    const draft = await this.getDraft(input.orgId, input.agentId);
    if (draft === undefined) throw notFound();
    // Pull request stage rules are used nowhere: kept as they are or removed, never added or changed.
    requireNoNewPullRequestInstructionsForProcess(agent, parsed, draft.overlay);
    if (draft.revision !== input.expectedRevision) throw conflict();
    await this.skills.requireRefs(input.orgId, overlay.skills?.add);
    // A process layer stays on Rovara Code: checked before the new base is read.
    requireRovaraCodeBaseForProcess(agent, input.extends === undefined ? draft.extends : input.extends);
    let base: BaseRef | undefined = draft.extends;
    if (input.extends === null) base = undefined;
    else if (input.extends !== undefined && input.extends !== draft.extends?.agentId) {
      if (input.extends === input.agentId) throw coded("CONFIG_INVALID", "extends: an agent can't build on itself");
      base = await this.pinTarget(input.orgId, input.extends, agent.name);
    } else if (base !== undefined && !isBuiltinAgentId(base.agentId)) {
      // The same base keeps its pin; one stored before this rule that is a process layer is not kept.
      requireBaseIsNotProcess(await this.get(input.orgId, base.agentId));
    }
    const revision = draft.revision + 1;
    const updatedAt = this.iso();
    // The origin is never written here: the update below leaves the stored one as it is, and the draft returned carries it.
    const saved: AgentDraft = { overlay, ...(base === undefined ? {} : { extends: base }), ...(draft.origin === undefined ? {} : { origin: draft.origin }), revision, updatedBy: input.by, updatedAt };
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
    /** A project's process layer only: the person who confirmed this publish is the one who asked, being the only one who could (`process.published` says so). */
    selfConfirmedSoleOwner?: boolean;
  }): Promise<AgentVersion> {
    if (!SHA256_HEX.test(input.digest)) throw coded("CONFIG_INVALID", "digest: must be the recipe's SHA-256 digest");
    const agent = await this.require(input.orgId, input.agentId);
    const draft = await this.getDraft(input.orgId, input.agentId);
    if (draft === undefined) throw notFound();
    if (agent.draftRevision !== input.expectedDraftRevision || draft.revision !== input.expectedDraftRevision) throw conflict();
    const n = agent.latestVersion;
    const version = n + 1;
    const publishedAt = this.iso();
    // A process layer's stored draft with skills is not published, whatever stored it.
    requireNoSkillsForProcess(agent, draft.overlay);
    await requireNoNewPullRequestInstructionsToPublish(this, agent, draft.overlay);
    const added = draft.overlay.skills?.add;
    const pinned = added === undefined ? undefined : await this.skills.pin(input.orgId, added, input.skillDigests);
    const overlay: RecipeOverlay = pinned === undefined ? draft.overlay : { ...draft.overlay, skills: { ...draft.overlay.skills, add: pinned.refs } };
    const published: AgentVersion = {
      version,
      overlay,
      ...(draft.extends === undefined ? {} : { extends: draft.extends }),
      ...(draft.origin === undefined ? {} : { origin: draft.origin }),
      name: agent.name,
      description: agent.description,
      digest: input.digest,
      publishedBy: input.by,
      publishedAt,
      ...(input.note === undefined ? {} : { note: input.note }),
    };
    const event = this.newEvent(input.orgId, input.agentId, "published", input.by, { version, digest: input.digest, ...(input.note === undefined ? {} : { note: input.note }) });
    // A project's process layer audits `process.published` instead.
    const audit = await this.audited(() => [agent.purpose === "process"
      ? auditProcessPublished({ orgId: input.orgId, actor: auditActorOf(input.by), occurredAt: event.at, occurrence: event.sk, agentId: input.agentId, version, safety: input.safety ?? "safe", selfConfirmedSoleOwner: input.selfConfirmedSoleOwner === true })
      : auditPublished({ orgId: input.orgId, actor: auditActorOf(input.by), occurredAt: event.at, occurrence: event.sk, scope: "agent", targetId: input.agentId, version, safety: input.safety ?? "safe" })]);
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
  async rollback(input: { orgId: OrgId; agentId: AgentId; version: number; expectedCurrentVersion: number; by: string; request?: RequestMark; safety?: "safe" | "less_safe" }): Promise<AgentRecord> {
    const { agentId, ...rest } = input;
    // A process layer is never rolled back to a version that does not build on Rovara Code, whatever stored it.
    const agent = await this.require(input.orgId, agentId);
    if (agent.purpose === "process") {
      const target = await this.getVersion(input.orgId, agentId, input.version);
      requireRovaraCodeBaseForProcess(agent, target?.extends);
      if (target !== undefined) {
        requireNoSkillsForProcess(agent, target.overlay);
        // The version that runs now is the baseline, as for a publish: older pull request stage text can't come back.
        await requireNoNewPullRequestInstructionsToPublish(this, agent, target.overlay);
      }
    }
    return this.rollbackItem({ ...rest, id: agentId });
  }

  // ---- the owner totals (Task 28; the counter itself is `spend/owner-budgets.ts`)

  /** The sum of the monthly budgets of the active agents (custom ones, and built-ins with an accountable person) that count for the owner `counts` asks about. */
  private async sumAgentBudgets(orgId: OrgId, counts: (subject: BudgetSubject) => Promise<boolean>): Promise<number> {
    return cleanUsd((await this.countedAgents(orgId, counts)).reduce((total, agent) => total + agent.monthlyBudgetUsd, 0));
  }

  /**
   * Task 33: the active agents (and built-ins it is accountable for) whose monthly budgets count in `owner`'s total, each with that budget. An id that names a
   * merged duplicate counts for its survivor. An agent whose base is $0 is listed too (Plan 4 review I-2): it adds nothing to the counter, but this month's
   * top-ups on it are spendable, so the effective total adds them. One with no base at all, or an archived one, is not listed.
   */
  async ownerAgents(orgId: OrgId, owner: string): Promise<Array<{ agentId: AgentId; monthlyBudgetUsd: number }>> {
    return this.countedAgents(orgId, this.ownerBudgets.countsFor(orgId, owner));
  }

  private async countedAgents(orgId: OrgId, counts: (subject: BudgetSubject) => Promise<boolean>): Promise<Array<{ agentId: AgentId; monthlyBudgetUsd: number }>> {
    const found: Array<{ agentId: AgentId; monthlyBudgetUsd: number }> = [];
    for (const agent of await this.list(orgId)) {
      if (ownerShare(agent) !== undefined && await counts(agent)) found.push({ agentId: agent.agentId, monthlyBudgetUsd: agent.monthlyBudgetUsd ?? 0 });
    }
    for (const id of Object.keys(BUILTIN_AGENTS)) {
      const settings = await this.getBuiltinSettings(orgId, id);
      if (settings !== undefined && ownerShare(settings) !== undefined && await counts(settings)) found.push({ agentId: id, monthlyBudgetUsd: settings.monthlyBudgetUsd ?? 0 });
    }
    return found;
  }

  /** Makes sure `owner` has a total to add to (built from every budget when there is none yet). */
  ensureOwnerTotal(orgId: OrgId, owner: string): Promise<void> {
    return this.ownerBudgets.ensure(orgId, owner);
  }

  /** Replaces `owner`'s total with the sum of their budgets and answers it (a merge calls this for the survivor). */
  rebuildOwnerTotal(orgId: OrgId, owner: string): Promise<number> {
    return this.ownerBudgets.rebuild(orgId, owner);
  }

  /** The counter items that take an agent from `before` to `after`, and what their refusals mean. */
  private async totalsFor(orgId: OrgId, before: BudgetSubject, after: BudgetSubject, cap?: OwnerCap): Promise<OwnerTotals> {
    const totals = await this.ownerBudgets.itemsFor(orgId, before, after, cap);
    return {
      items: totals.items,
      refuse: (failed) => {
        const outcome = totals.classify(failed);
        if (outcome.kind === "policy") return policyMoved();
        if (outcome.kind === "cap") return ownerOverCap(outcome.owner);
        if (outcome.kind === "totals") return totalsMoved();
        return budgetConflict();
      },
    };
  }

  private async setStatus(orgId: OrgId, agentId: AgentId, status: "active" | "archived", by: string, request?: RequestMark, options: BudgetWriteOptions = {}): Promise<AgentRecord> {
    if (isBuiltinAgentId(agentId)) throw coded("CONFIG_INVALID", `${this.builtins.name(agentId)} is built in and can't be archived`);
    const actorChecks = status === "active" ? unarchiveActorChecks(this.input.tableName, orgId, by, request, options) : [];
    const agent = await this.require(orgId, agentId);
    const sourceGuard = (a: Aliases) => `${budgetGuard(agent)(a)}${status !== "active" ? "" : ` AND ${a.name("updatedAt")} = ${a.value(agent.updatedAt)} AND ${agent.maxPerRunUsd === undefined ? `attribute_not_exists(${a.name("maxPerRunUsd")})` : `${a.name("maxPerRunUsd")} = ${a.value(agent.maxPerRunUsd)}`}${options.manageSnapshot === undefined ? "" : ` AND ${budgetGuard(options.manageSnapshot)(a)}`}`}`;
    if (agent.status === status) {
      if (status === "active") {
        const actorStart = 1;
        await this.commit(...withOverride([
          this.update(agentKey(orgId, agentId, "META"), { set: { status }, when: sourceGuard }),
          ...actorChecks,
        ], failed => [...failed].some(index => index >= actorStart && index < actorStart + actorChecks.length) ? budgetActorRefused() : budgetConflict(), options, { tableName: this.input.tableName, orgId, by }), request, agent);
      }
      return agent;
    }
    const updatedAt = this.iso();
    const changed: AgentRecord = { ...agent, status, updatedAt };
    const totals = await this.totalsFor(orgId, agent, changed, options.ownerCap);
    const ownItems = [
      this.update(agentKey(orgId, agentId, "META"), { set: { status, updatedAt }, when: sourceGuard }),
      ...totals.items,
      this.event(orgId, agentId, status === "archived" ? "archived" : "unarchived", by, overrideDetail(options)),
    ];
    const actorStart = ownItems.length;
    const [items, refuse] = withOverride([...ownItems, ...actorChecks], failed =>
      [...failed].some(index => index >= actorStart && index < actorStart + actorChecks.length) ? budgetActorRefused() : totals.refuse(failed),
    options, { tableName: this.input.tableName, orgId, by });
    const checks = options.checks;
    await this.commit([...items, ...(checks?.items ?? [])], failed =>
      checks !== undefined && [...failed].some(index => index >= items.length) ? checks.refused() : refuse(failed), request, changed);
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
    if (budget.maxPerRunUsd !== undefined && budget.maxPerRunUsd !== null && usdToWholeMicrodollars(budget.maxPerRunUsd) === undefined) {
      throw coded("CONFIG_INVALID", "maxPerRunUsd: must be a number from 0 to 1000000 with at most 6 decimal places");
    }
    const actor = options.actor ?? options.overrideCap?.actor;
    if (actor === undefined) throw budgetActorRefused();
    if (actor !== undefined && (actor.developerId !== by || (request !== undefined && request.developerId !== actor.developerId))) throw budgetActorRefused();
    if (options.actor !== undefined && options.overrideCap !== undefined && (options.overrideCap.actor?.developerId !== actor?.developerId || options.overrideCap.actor?.role !== actor?.role)) throw budgetActorRefused();
    // Approval actor checks are generated once by withOverride, on this store's actual scope.
    const actorChecks = actor === undefined || options.overrideCap !== undefined ? [] : budgetActorChecks(this.input.tableName, orgId, actor);
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
    let createBuiltin = false;
    if (isBuiltinAgentId(agentId)) {
      const existing = await this.getBuiltinSettings(orgId, agentId);
      createBuiltin = existing === undefined;
      current = existing ?? { pinnedVersion: this.builtins.defaultPin(agentId), updatedBy: by, updatedAt };
      key = builtinSettingsKey(orgId, agentId);
      set["updatedBy"] = by;
    } else {
      current = await this.require(orgId, agentId);
      key = agentKey(orgId, agentId, "META");
    }
    let taskStopMetadata: { stopKind: "inherit" | "limited"; revision: number } | undefined;
    if (budget.maxPerRunUsd !== undefined && current.stopKind !== undefined) {
      if (!Number.isSafeInteger(current.revision) || current.revision === undefined || current.revision < 1 || current.revision >= Number.MAX_SAFE_INTEGER
        || current.stopKind !== (current.maxPerRunUsd === undefined ? "inherit" : "limited")) throw coded("TASK_STOP_CONFIG_INVALID", "The agent spending setting is invalid. Ask an admin to repair it before editing the stop.");
      taskStopMetadata = { stopKind: budget.maxPerRunUsd === null ? "inherit" : "limited", revision: current.revision + 1 };
      Object.assign(set, taskStopMetadata);
    }
    if (options.expectedMaxPerRunUsd !== undefined && options.expectedMaxPerRunUsd !== (current.maxPerRunUsd ?? null)) throw budgetConflict();
    const monthlyBudgetUsd = typeof budget.monthlyUsd === "number" ? budget.monthlyUsd : budget.monthlyUsd === null ? undefined : current.monthlyBudgetUsd;
    const maxPerRunUsd = typeof budget.maxPerRunUsd === "number" ? budget.maxPerRunUsd : budget.maxPerRunUsd === null ? undefined : current.maxPerRunUsd;
    const { monthlyBudgetUsd: _monthly, maxPerRunUsd: _perRun, ...others } = current; // eslint-disable-line @typescript-eslint/no-unused-vars -- replaced below
    const written = { ...others, ...taskStopMetadata, ...(monthlyBudgetUsd === undefined ? {} : { monthlyBudgetUsd }), ...(maxPerRunUsd === undefined ? {} : { maxPerRunUsd }), updatedAt, ...(isBuiltinAgentId(agentId) ? { updatedBy: by } : {}) };
    const totals = await this.totalsFor(orgId, current, written, options.ownerCap);
    const event = this.newEvent(orgId, agentId, "budget_changed", by, { ...withoutUndefined(detail), ...overrideDetail(options) });
    const audit = await this.audited(() => agentBudgetEvents({
      orgId, actor: auditActorOf(by), occurredAt: event.at, occurrence: event.sk, agentId,
      before: { monthlyBudgetUsd: current.monthlyBudgetUsd, maxPerRunUsd: current.maxPerRunUsd }, after: { monthlyBudgetUsd, maxPerRunUsd },
    }));
    const items = [
      createBuiltin ? this.put(key, "BUILTIN_AGENT_SETTINGS", written) : this.update(key, { set, ...(remove.length > 0 ? { remove } : {}), when: (aliases) => {
        const field = aliases.name("maxPerRunUsd");
        const perRun = current.maxPerRunUsd === undefined ? `attribute_not_exists(${field})` : `${field} = ${aliases.value(current.maxPerRunUsd)}`;
        const manage = options.manageSnapshot === undefined ? "" : ` AND ${budgetGuard(options.manageSnapshot)(aliases)}`;
        const metadata = budget.maxPerRunUsd === undefined ? "" : ["stopKind", "revision"].map(field => {
          const value = field === "stopKind" ? current.stopKind : current.revision;
          return value === undefined ? ` AND attribute_not_exists(${aliases.name(field)})` : ` AND ${aliases.name(field)} = ${aliases.value(value)}`;
        }).join("");
        return `${budgetGuard(current)(aliases)} AND ${perRun}${metadata}${manage}`;
      } }),
      ...totals.items,
      event.item,
      ...audit.items,
    ];
    const actorStart = items.length;
    await this.commit(...withOverride([...items, ...actorChecks], (failed) => (
      [...failed].some(index => index >= actorStart && index < actorStart + actorChecks.length) ? budgetActorRefused() : totals.refuse(failed)
    ), options, { tableName: this.input.tableName, orgId, by }), request, written);
    await flushAuditEvents(this.input, audit.events);
    return written;
  }

  /**
   * Moves a custom agent to another owner. A project's agent needs `accountable`; a member's has none. Who may do this,
   * and whether the new owner's budget total allows it, is the route's check.
   */
  async setOwner(orgId: OrgId, agentId: AgentId, owner: AgentOwner, by: string, accountable?: { developerId: string }, request?: RequestMark, options: BudgetWriteOptions = {}): Promise<AgentRecord> {
    const actor = options.actor;
    if ((request !== undefined && actor === undefined) ||
      (actor !== undefined && (actor.developerId !== by || options.overrideCap !== undefined)) ||
      (request !== undefined && (request.orgId !== orgId || request.developerId !== actor?.developerId)) ||
      (actor === undefined && options.overrideCap === undefined && (by !== "system" || options.cause === undefined))) throw budgetActorRefused();
    const actorChecks = actor === undefined ? [] : budgetActorChecks(this.input.tableName, orgId, actor);
    if (isBuiltinAgentId(agentId)) throw coded("CONFIG_INVALID", `${this.builtins.name(agentId)} is built in and belongs to the whole company`);
    if (owner.kind === "project" && accountable === undefined) throw coded("CONFIG_INVALID", "accountable: a project's agent needs an accountable maintainer");
    if (owner.kind === "member" && accountable !== undefined) throw coded("CONFIG_INVALID", "accountable: only a project's agent has an accountable maintainer");
    const agent = await this.require(orgId, agentId);
    // A different owner/accountable can invalidate the route's manage authority before this writer reads it.
    const managedOwner = (subject: BudgetSubject) => ({ owner: subject.owner, accountable: subject.accountable });
    if (options.manageSnapshot !== undefined && !sameJsonContent(managedOwner(agent), managedOwner(options.manageSnapshot))) throw budgetActorRefused();
    requireNoOwnerMoveOnProcess(agent, options);
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
    const items = [
      this.update(agentKey(orgId, agentId, "META"), {
        set: { owner, accountable, updatedAt },
        ...(accountable === undefined ? { remove: ["accountable"] } : {}),
        when: (a) => `${a.name("updatedAt")} = ${a.value(agent.updatedAt)} AND ${guard(a)}${options.manageSnapshot === undefined ? "" : ` AND ${budgetGuard(options.manageSnapshot)(a)}`}`,
      }),
      ...totals.items,
      event.item,
      ...audit.items,
    ];
    const actorStart = items.length;
    await this.commit(...withOverride([...items, ...actorChecks], (failed) => (
      [...failed].some(index => index >= actorStart && index < actorStart + actorChecks.length) ? budgetActorRefused() : totals.refuse(failed)
    ), options, { tableName: this.input.tableName, orgId, by }), request, moved);
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
      const actor = options.actor;
      if ((request !== undefined && actor === undefined) ||
        (actor !== undefined && (actor.developerId !== by || options.overrideCap !== undefined)) ||
        (request !== undefined && (request.orgId !== orgId || request.developerId !== actor?.developerId)) ||
        (actor === undefined && options.overrideCap === undefined && (by !== "system" || options.cause === undefined))) throw budgetActorRefused();
      if (actor !== undefined && actor.role !== "owner" && actor.role !== "admin") throw budgetActorRefused();
      const actorChecks = actor === undefined ? [] : budgetActorChecks(this.input.tableName, orgId, actor);
      const existing = await this.getBuiltinSettings(orgId, agentId);
      if (options.builtinSnapshot !== undefined && !sameJsonContent(existing ?? null, options.builtinSnapshot)) throw budgetConflict();
      if (existing !== undefined && (!Number.isInteger(existing.pinnedVersion) || existing.pinnedVersion < 1 || typeof existing.updatedAt !== "string" || typeof existing.updatedBy !== "string")) throw coded("CONFIG_INVALID", "Built-in settings are invalid; repair them before changing the accountable person");
      const before = existing ?? { pinnedVersion: this.builtins.defaultPin(agentId), updatedBy: by, updatedAt };
      const written = { ...before, accountable, updatedBy: by, updatedAt };
      const totals = await this.totalsFor(orgId, before, withBudgetFields(before, { accountable }), options.ownerCap);
      const event = this.newEvent(orgId, agentId, "owner_changed", by, { accountable, ...(before.accountable === undefined ? {} : { from: before.accountable }), ...(options.cause === undefined ? {} : { cause: options.cause }), ...overrideDetail(options) });
      const audit = await this.audited(() => [accountableChangedEvent({
        orgId, actor: auditActorOf(by), occurredAt: event.at, occurrence: event.sk, agentId, accountable: accountable.developerId,
        ...(before.accountable === undefined ? {} : { previous: before.accountable.developerId }),
      })]);
      const key = builtinSettingsKey(orgId, agentId);
      const items = [
        existing === undefined ? this.put(key, "BUILTIN_AGENT_SETTINGS", written) : this.update(key, {
          set: { accountable, updatedBy: by, updatedAt },
          when: (aliases) => {
            const equal = (field: "pinnedVersion" | "maxPerRunUsd" | "updatedAt" | "updatedBy") => before[field] === undefined
              ? `attribute_not_exists(${aliases.name(field)})` : `${aliases.name(field)} = ${aliases.value(before[field])}`;
            return `attribute_exists(${aliases.name("pk")}) AND ${budgetGuard(before)(aliases)} AND ${equal("pinnedVersion")} AND ${equal("maxPerRunUsd")} AND ${equal("updatedAt")} AND ${equal("updatedBy")}`;
          },
        }),
        ...totals.items,
        event.item,
        ...audit.items,
      ];
      const actorStart = items.length;
      await this.commit(...withOverride([...items, ...actorChecks], (failed) => (
        [...failed].some(index => index >= actorStart && index < actorStart + actorChecks.length) ? budgetActorRefused() : totals.refuse(failed)
      ), options, { tableName: this.input.tableName, orgId, by }), request, { accountable });
      await flushAuditEvents(this.input, audit.events);
      return;
    }
    const actor = options.actor;
    if ((request !== undefined && actor === undefined) ||
      (actor !== undefined && (actor.developerId !== by || options.overrideCap !== undefined)) ||
      (request !== undefined && (request.orgId !== orgId || request.developerId !== actor?.developerId)) ||
      (actor === undefined && options.overrideCap === undefined && (by !== "system" || options.cause === undefined))) throw budgetActorRefused();
    const actorChecks = actor === undefined ? [] : budgetActorChecks(this.input.tableName, orgId, actor);
    const agent = await this.require(orgId, agentId);
    const managedOwner = (subject: BudgetSubject) => ({ owner: subject.owner, accountable: subject.accountable });
    if (options.manageSnapshot !== undefined && !sameJsonContent(managedOwner(agent), managedOwner(options.manageSnapshot))) throw budgetActorRefused();
    requireNoOwnerMoveOnProcess(agent, options);
    if (agent.owner.kind !== "project") throw coded("CONFIG_INVALID", "accountable: only a project's agent has an accountable maintainer");
    const totals = await this.totalsFor(orgId, agent, withBudgetFields(agent, { accountable }), options.ownerCap);
    const guard = budgetGuard(agent);
    const event = this.newEvent(orgId, agentId, "owner_changed", by, { accountable, ...(agent.accountable === undefined ? {} : { from: agent.accountable }), ...(options.cause === undefined ? {} : { cause: options.cause }), ...overrideDetail(options) });
    const audit = await this.audited(() => [accountableChangedEvent({
      orgId, actor: auditActorOf(by), occurredAt: event.at, occurrence: event.sk, agentId, accountable: accountable.developerId,
      ...(agent.accountable === undefined ? {} : { previous: agent.accountable.developerId }),
    })]);
    const items = [
      this.update(agentKey(orgId, agentId, "META"), { set: { accountable, updatedAt }, when: (a) => `${a.name("updatedAt")} = ${a.value(agent.updatedAt)} AND ${guard(a)}${options.manageSnapshot === undefined ? "" : ` AND ${budgetGuard(options.manageSnapshot)(a)}`}` }),
      ...totals.items,
      event.item,
      ...audit.items,
    ];
    const actorStart = items.length;
    await this.commit(...withOverride([...items, ...actorChecks], (failed) => (
      [...failed].some(index => index >= actorStart && index < actorStart + actorChecks.length) ? budgetActorRefused() : totals.refuse(failed)
    ), options, { tableName: this.input.tableName, orgId, by }), request, { accountable });
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
    requireRovaraCodeBaseForProcess(agent, draft.extends);
    requireNoSkillsForProcess(agent, draft.overlay);
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
    const { agentId, ...rest } = input;
    // A process layer is never shared on its own: whoever the route or a confirmation was, the share is not written.
    requireNoSharesOnProcess(await this.get(input.orgId, agentId));
    return this.replaceItemShares({ ...rest, id: agentId });
  }

  /**
   * Takes `from`'s share of one agent away and, when `to` is given, gives `to` the share instead (the higher level when `to` already has
   * one). Rovara's own move after a member merge or removal (Task 11); see `OwnedStore.reassignItemShare`.
   */
  async reassignShare(input: { orgId: OrgId; agentId: AgentId; from: AgentPrincipal; to?: AgentPrincipal; by: string; cause: MoveCause }): Promise<void> {
    const { agentId, to, ...rest } = input;
    // A process layer's share of a departed member is dropped, never handed to someone else.
    const dropOnly = (await this.get(input.orgId, agentId))?.purpose === "process";
    return this.reassignItemShare({ ...rest, ...(to === undefined || dropOnly ? {} : { to }), id: agentId });
  }

  /**
   * Makes `guardrails` the org's agent guardrails (the caller has checked who may, and what is less safe). It applies only while the
   * document is still at `expectedRevision` (0 before the first write), so of two concurrent writes one wins and the other conflicts.
   * Returns the document as stored, with its new revision; that is also what a repeat of the request is answered with.
   */
  async putGuardrails(input: {
    orgId: OrgId; guardrails: AgentGuardrails; expectedRevision: number; by: string; actor: BudgetActor; request?: RequestMark;
    /** Whether this write makes anything less safe, which a person confirmed; the audit event says so. Default: no. */
    widened?: boolean;
  }): Promise<{ guardrails: AgentGuardrails; revision: number }> {
    // Validate writes only: historical read/enforcement semantics remain unchanged.
    if (usdToWholeMicrodollars(input.guardrails.maxPerRunCeilingUsd) === undefined) {
      throw coded("CONFIG_INVALID", "maxPerRunCeilingUsd: must be a number from 0 to 1000000 with at most 6 decimal places");
    }
    if (input.actor === undefined || (input.actor.role !== "owner" && input.actor.role !== "admin") || input.actor.developerId !== input.by || (input.request !== undefined && (input.request.orgId !== input.orgId || input.request.developerId !== input.by))) throw budgetActorRefused();
    const checks = budgetActorChecks(this.input.tableName, input.orgId, input.actor);
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
    const items = [item, ...audit.items], actorStart = items.length;
    await this.commit([...items, ...checks], failed => [...failed].some(index => index >= actorStart && index < actorStart + checks.length) ? budgetActorRefused() : guardrailsConflict(), input.request, stored);
    await flushAuditEvents(this.input, audit.events);
    return stored;
  }
}

export interface ResolveOptions {
  /** RULING Q48: draft inspection collects all structure issues; normal resolution still refuses. */
  problems?: Array<{path:string;message:string}>;
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
    if (problems.length > 0) { if (options.problems) options.problems.push(...problems); else throw problemsError(problems); }
    const recipeLayer: RecipeLayer = { agentId: id, name: content.name, version: content.version, builtin: false, ...(agent.purpose === "process" ? { process: true as const } : {}) };
    // The registry is read here, not inside applyOverlay, which is synchronous: the layer's added skills are looked up first.
    const added = new Map<string, ResolvedSkill>();
    for (const ref of content.overlay.skills?.add ?? []) added.set(ref.skillId, await resolveSkill(ref));
    return applyOverlay(base, content.overlay, recipeLayer, (ref) => added.get(ref.skillId)!);
  }

  const recipe = await layer(agentId, version, []);
  const problems = recipeProblems(recipe);
  if (problems.length > 0) { if (options.problems) options.problems.push(...problems); else throw problemsError(problems); }
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
