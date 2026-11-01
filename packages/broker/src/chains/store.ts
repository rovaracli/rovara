// packages/broker/src/chains/store.ts
// The chain store (Plan 4 Task 3): a chain's META, its DRAFT, immutable numbered versions, the org's name and directory items, its shares and one
// EVENT# item per write. It is the agent store's sibling: both extend `OwnedStore` (keys, events, shares, rollback), and both add to one
// `OwnerBudgets` ledger, so a person's agent budgets and chain budgets are one monthly total. Every multi-item write is one transaction, so a
// refused write leaves nothing behind. A published version pins every agent step to a number; publishing checks again, inside its transaction,
// that each pinned agent version and built-in pin is still what validation saw.
import { unarchiveActorChecks, budgetActorChecks, budgetActorRefused } from "../agents/budget-authority.js";
import { createHash } from "node:crypto";
import {
  sameJsonContent,
  AGENT_DESCRIPTION_MAX,
  AGENT_NAME_MAX,
  ChainDefinitionSchema,
  PinnedChainDefinitionSchema,
  agentGuardrailsKey,
  agentKey,
  agentVersionSk,
  builtinSettingsKey,
  canonicalJson,
  chainDirectoryKey,
  chainKey,
  chainNameKey,
  isBuiltinAgentId,
  newPrefixedId,
  orgScoped,
  type AgentOwner,
  type AgentPrincipal,
  type ChainDefinition,
  type ChainId,
  type OrgId,
  type PinnedChainDefinition,
} from "@agentx/contracts";
import { auditPublished } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditActorOf, accountableChangedEvent, chainBudgetEvents, ownerMovedEvent } from "../audit/plan3-hooks.js";
import { readGuardrailsWithRevision } from "../agents/guardrails.js";
import { CHAIN_KIND, OwnedStore, type AgentShareLevel, type MoveCause, type OwnedStoreInput } from "../agents/owned-store.js";
import type { AgentStore, BudgetWriteOptions } from "../agents/store.js";
import { Aliases, NOT_EXISTS, coded, strip, withoutUndefined, type Item, type RequestMark, type TransactItem } from "../agents/table-writes.js";
import type { OwnerBudgets} from "../spend/owner-budgets.js";
import { budgetGuard, overrideDetail, ownerOverCap, totalsMoved, withOverride, type OwnerCap } from "../spend/owner-budgets.js";
import { ownerShare, withBudgetFields, type BudgetSubject } from "../spend/owner-total.js";
import { chainGraphProblems, formatChainProblem } from "./validate.js";
import { cleanUsd } from "../spend/top-ups.js";

export type { BudgetWriteOptions, OwnerCap };

const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface ChainRecord {
  orgId: OrgId;
  chainId: ChainId;
  name: string;
  description: string;
  owner: AgentOwner;
  /** The maintainer whose monthly total a project-owned chain's budget counts in (R65). Not the run owner of event-started runs. */
  accountable?: { developerId: string };
  currentVersion?: number;
  latestVersion: number;
  draftRevision: number;
  /** Counts the writes of the chain's share set; a share save applies only to the count it read. Absent until the first share. */
  sharesRevision?: number;
  status: "active" | "archived";
  monthlyBudgetUsd?: number;
  /** Runs that have started and not ended (kept by the runner, Task 6). */
  openRuns: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChainDraft {
  definition: ChainDefinition;
  revision: number;
  updatedBy: string;
  updatedAt: string;
}

export interface ChainVersion {
  version: number;
  definition: PinnedChainDefinition;
  /** SHA-256 of the pinned definition's canonical JSON. */
  digest: string;
  publishedBy: string;
  publishedAt: string;
  note?: string;
}

export type ChainEventKind =
  | "created"
  | "draft_saved"
  | "profile_changed"
  | "published"
  | "rolled_back"
  | "archived"
  | "unarchived"
  | "shared"
  | "owner_changed"
  | "budget_changed";

export interface ChainStoreInput extends OwnedStoreInput {
  newId?: () => ChainId;
  /** The agent store: the chain's owner total is shared with it, and publishing reads built-in pins and the guardrails through it. */
  agents: AgentStore;
}

/** The SHA-256 (hex) of a pinned definition's canonical JSON: equal designs have equal digests whatever their key order. */
export function chainDigest(pinned: PinnedChainDefinition): string {
  return createHash("sha256").update(canonicalJson(pinned), "utf8").digest("hex");
}

const notFound = () => coded("NOT_FOUND", "no chain has that ID");
const nameTaken = (name: string) => coded("CONFIG_INVALID", `name: another chain in your company is called ${name}`);
const budgetConflict = () => coded("CHAIN_REVISION_CONFLICT", "Someone else changed this chain's owner, status or budget just now. Reload it and make your change again.");
const policyMoved = () => coded("CHAIN_REVISION_CONFLICT", "Your company's spend policy changed just now. Reload and make your change again.");
const totalsChanged = () => totalsMoved("agent and chain");
const ROLLBACK_MOVED = "An agent this chain uses changed while it was being rolled back. Roll back again.";
const agentMoved = () => coded("CHAIN_REVISION_CONFLICT", "An agent this chain uses changed while it was being published. Publish again.");

const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
/** Everything but an ordinary space that is not a letter, number, mark, symbol or punctuation: other controls, invisible characters and look-alike spaces. */
const NOT_NAME_TEXT = /[\p{C}\p{Z}]/u;

/** A chain's name: 1 to 60 characters (code points), trimmed and in NFC, with no control or invisible character and no space but a plain one. */
function checkName(raw: string): string {
  const name = raw.normalize("NFC").trim();
  if (name.length === 0 || [...name].length > AGENT_NAME_MAX) throw coded("CONFIG_INVALID", `name: must be 1 to ${String(AGENT_NAME_MAX)} characters`);
  if (NOT_NAME_TEXT.test(name.replaceAll(" ", ""))) throw coded("CONFIG_INVALID", "name: use letters, numbers, punctuation and plain spaces only");
  return name;
}

function checkDescription(description: string): string {
  if ([...description].length > AGENT_DESCRIPTION_MAX) throw coded("CONFIG_INVALID", `description: must be at most ${String(AGENT_DESCRIPTION_MAX)} characters`);
  if (CONTROL_OR_FORMAT.test(description.replace(/[\n\r\t]/gu, ""))) throw coded("CONFIG_INVALID", "description: must not contain control or invisible characters");
  return description;
}

function checkAmount(label: string, value: number | undefined): void {
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) throw coded("CONFIG_INVALID", `${label}: must be a number of dollars, zero or more`);
}

function parseDefinition(definition: unknown): ChainDefinition {
  const parsed = ChainDefinitionSchema.safeParse(definition);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  throw coded("CONFIG_INVALID", `definition${first && first.path.length > 0 ? `.${first.path.join(".")}` : ""}: ${first?.message ?? "is not valid"}`);
}

function checkOwner(owner: AgentOwner, accountable: { developerId: string } | undefined): void {
  if (owner.kind === "project" && accountable === undefined) throw coded("CONFIG_INVALID", "accountable: a project's chain needs an accountable maintainer");
  if (owner.kind === "member" && accountable !== undefined) throw coded("CONFIG_INVALID", "accountable: only a project's chain has an accountable maintainer");
}

/** What the pins of a design must be: `agent.version` blanked, so two designs that differ only in the pinned numbers compare equal. */
function blankVersions(definition: ChainDefinition | PinnedChainDefinition): string {
  return canonicalJson({
    ...definition,
    steps: definition.steps.map((step) => (step.kind === "agent" ? { ...step, agent: { ...step.agent, version: 0 } } : step)),
  });
}

export class ChainStore extends OwnedStore<ChainId, ChainRecord, ChainVersion, ChainEventKind> {
  protected declare readonly input: ChainStoreInput;
  private readonly newId: () => ChainId;
  private readonly agents: AgentStore;
  private readonly ownerBudgets: OwnerBudgets;

  constructor(input: ChainStoreInput) {
    super(input, CHAIN_KIND);
    this.newId = input.newId ?? (() => newPrefixedId("chn"));
    this.agents = input.agents;
    this.ownerBudgets = input.agents.ownerBudgets;
    this.ownerBudgets.register("chain", { sum: (orgId, _owner, counts) => this.sumChainBudgets(orgId, counts) }, input);
  }

  // ---- reads

  async get(orgId: OrgId, chainId: ChainId): Promise<ChainRecord | undefined> {
    const item = await this.read(chainKey(orgId, chainId, "META"));
    return item === undefined ? undefined : (strip(item) as unknown as ChainRecord);
  }

  protected async require(orgId: OrgId, chainId: ChainId): Promise<ChainRecord> {
    const chain = await this.get(orgId, chainId);
    if (chain === undefined) throw notFound();
    return chain;
  }

  async getDraft(orgId: OrgId, chainId: ChainId): Promise<ChainDraft | undefined> {
    const item = await this.read(chainKey(orgId, chainId, "DRAFT"));
    return item === undefined ? undefined : (strip(item) as unknown as ChainDraft);
  }

  /** The org's chains, in the order of the directory (by id). */
  async list(orgId: OrgId): Promise<ChainRecord[]> {
    const directory = await this.queryAll(orgScoped(orgId, "CHAINS"));
    const chains = await Promise.all(directory.map((entry) => this.get(orgId, entry["sk"] as ChainId)));
    return chains.filter((chain): chain is ChainRecord => chain !== undefined);
  }

  // ---- writes

  async create(input: {
    orgId: OrgId;
    name: string;
    description?: string;
    owner: AgentOwner;
    accountable?: { developerId: string };
    definition: unknown;
    createdBy: string;
    request?: RequestMark;
  }): Promise<ChainRecord> {
    const name = checkName(input.name);
    const description = checkDescription(input.description ?? "");
    checkOwner(input.owner, input.accountable);
    const definition = parseDefinition(input.definition);

    const chainId = this.newId();
    const now = this.iso();
    const chain: ChainRecord = {
      orgId: input.orgId,
      chainId,
      name,
      description,
      owner: input.owner,
      ...(input.accountable === undefined ? {} : { accountable: input.accountable }),
      latestVersion: 0,
      draftRevision: 1,
      status: "active",
      openRuns: 0,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    const draft: ChainDraft = { definition, revision: 1, updatedBy: input.createdBy, updatedAt: now };
    await this.commit([
      this.put(chainKey(input.orgId, chainId, "META"), "CHAIN", chain as unknown as Item),
      this.put(chainKey(input.orgId, chainId, "DRAFT"), "CHAIN_DRAFT", draft as unknown as Item),
      this.put(chainDirectoryKey(input.orgId, chainId), "CHAIN_DIRECTORY", { chainId, createdAt: now }),
      this.put(chainNameKey(input.orgId, name), "CHAIN_NAME", { chainId, createdAt: now }),
      this.event(input.orgId, chainId, "created", input.createdBy, { name }),
    ], (failed) => (failed.has(3) ? nameTaken(name) : undefined), input.request, chain);
    return chain;
  }

  /** Saves the draft's design when `expectedRevision` is still its revision. */
  async saveDraft(input: { orgId: OrgId; chainId: ChainId; definition: unknown; expectedRevision: number; by: string; request?: RequestMark }): Promise<ChainDraft> {
    const definition = parseDefinition(input.definition);
    await this.require(input.orgId, input.chainId);
    const draft = await this.getDraft(input.orgId, input.chainId);
    if (draft === undefined) throw notFound();
    if (draft.revision !== input.expectedRevision) throw this.conflict();
    const revision = draft.revision + 1;
    const updatedAt = this.iso();
    const saved: ChainDraft = { definition, revision, updatedBy: input.by, updatedAt };
    await this.commit([
      this.update(chainKey(input.orgId, input.chainId, "DRAFT"), {
        set: { definition, revision, updatedBy: input.by, updatedAt },
        when: (a) => `${a.name("revision")} = ${a.value(input.expectedRevision)}`,
      }),
      this.update(chainKey(input.orgId, input.chainId, "META"), {
        set: { draftRevision: revision, updatedAt },
        when: (a) => `${a.name("draftRevision")} = ${a.value(input.expectedRevision)}`,
      }),
      this.event(input.orgId, input.chainId, "draft_saved", input.by, { revision }),
    ], () => this.conflict(), input.request, saved);
    return saved;
  }

  /** Changes the name or description. A rename swaps the name item, so the new name is checked and the old one freed together. */
  async updateProfile(input: { orgId: OrgId; chainId: ChainId; name?: string; description?: string; by: string; request?: RequestMark }): Promise<ChainRecord> {
    const chain = await this.require(input.orgId, input.chainId);
    const name = input.name === undefined ? chain.name : checkName(input.name);
    const description = input.description === undefined ? chain.description : checkDescription(input.description);
    const renamed = name.toLowerCase() !== chain.name.trim().toLowerCase();
    const updatedAt = this.iso();
    const items: TransactItem[] = [
      this.update(chainKey(input.orgId, input.chainId, "META"), {
        set: { name, description, updatedAt },
        when: (a) => `${a.name("name")} = ${a.value(chain.name)} AND ${a.name("description")} = ${a.value(chain.description)}`,
      }),
    ];
    if (renamed) {
      items.push(
        this.put(chainNameKey(input.orgId, name), "CHAIN_NAME", { chainId: input.chainId, createdAt: updatedAt }),
        {
          Delete: {
            TableName: this.input.tableName,
            Key: chainNameKey(input.orgId, chain.name),
            ConditionExpression: "chainId = :chainId",
            ExpressionAttributeValues: { ":chainId": input.chainId },
          },
        },
      );
    }
    items.push(this.event(input.orgId, input.chainId, "profile_changed", input.by, { ...(renamed ? { from: chain.name, to: name } : {}) }));
    const updated: ChainRecord = { ...chain, name, description, updatedAt };
    await this.commit(items, (failed) => (failed.has(1) && renamed ? nameTaken(name) : this.conflict()), input.request, updated);
    return updated;
  }

  /**
   * Publishes the draft as version `latestVersion + 1`, pinned as `pinned` (the draft's design with every agent version a number, as
   * `validateChainForPublish` made it; the caller publishes only when that returned no problems). The version item must not exist and the chain
   * must still be at the `latestVersion` and draft revision read here, so of two concurrent publishes one wins and the other conflicts.
   * In the same transaction, each pinned agent is checked again: a custom agent's version still exists, the agent is not archived, and a
   * `"current"` pin is still its current version; a built-in's `"current"` pin is still the org's pin and a named release is not above it; and
   * the org's guardrails are as they were read, with none of the built-ins turned off.
   */
  async publish(input: {
    orgId: OrgId; chainId: ChainId; expectedDraftRevision: number; pinned: PinnedChainDefinition; digest: string;
    /** The revision of the org's guardrails the validation read (`validateChainForPublish`): the write commits only while they are still at it. */
    guardrailsRevision: number; note?: string; by: string;
    expectedCurrentVersion?: number | null; request?: RequestMark;
    /** Whether the publish made anything less safe than what ran before, which a person confirmed (`less_safe`), or nothing (`safe`, the default); the audit event says which. */
    safety?: "safe" | "less_safe";
  }): Promise<ChainVersion> {
    if (!SHA256_HEX.test(input.digest)) throw coded("CONFIG_INVALID", "digest: must be a SHA-256 digest of 64 hex characters");
    const chain = await this.require(input.orgId, input.chainId);
    const draft = await this.getDraft(input.orgId, input.chainId);
    if (draft === undefined) throw notFound();
    if (chain.draftRevision !== input.expectedDraftRevision || draft.revision !== input.expectedDraftRevision) throw this.conflict();
    const pinned = this.checkPinned(draft.definition, input.pinned);
    // The graph rules hold of what is stored, not only of what the caller checked: a loop with no limit, a step nothing reaches, a dangling edge.
    const [problem] = chainGraphProblems(pinned);
    if (problem !== undefined) throw coded("CONFIG_INVALID", formatChainProblem(problem));
    if (chainDigest(pinned) !== input.digest) throw coded("CONFIG_INVALID", "digest: must be the SHA-256 of the pinned definition");
    const checks = await this.pinChecks(input.orgId, draft.definition, pinned, input.guardrailsRevision);

    const n = chain.latestVersion;
    const version = n + 1;
    const publishedAt = this.iso();
    const published: ChainVersion = {
      version,
      definition: pinned,
      digest: input.digest,
      publishedBy: input.by,
      publishedAt,
      ...(input.note === undefined ? {} : { note: input.note }),
    };
    const event = this.newEvent(input.orgId, input.chainId, "published", input.by, { version, digest: input.digest, ...(input.note === undefined ? {} : { note: input.note }) });
    const audit = await this.audited(() => [auditPublished({
      orgId: input.orgId, actor: auditActorOf(input.by), occurredAt: event.at, occurrence: event.sk, scope: "chain", targetId: input.chainId, version, safety: input.safety ?? "safe",
    })]);
    const written: TransactItem[] = [
      this.put(chainKey(input.orgId, input.chainId, this.spec.versionSk(version)), "CHAIN_VERSION", published as unknown as Item),
      this.update(chainKey(input.orgId, input.chainId, "META"), {
        set: { currentVersion: version, latestVersion: version, updatedAt: publishedAt },
        when: (a) => [
          `${a.name("latestVersion")} = ${a.value(n)}`,
          `${a.name("draftRevision")} = ${a.value(input.expectedDraftRevision)}`,
          `${a.name("name")} = ${a.value(chain.name)}`,
          `${a.name("description")} = ${a.value(chain.description)}`,
          ...(input.expectedCurrentVersion === undefined ? [] : [input.expectedCurrentVersion === null ? `attribute_not_exists(${a.name("currentVersion")})` : `${a.name("currentVersion")} = ${a.value(input.expectedCurrentVersion)}`]),
        ].join(" AND "),
      }),
      event.item,
    ];
    // The agent checks follow what is written; one of them failing is an agent that moved, not a draft that did. The audit item is last of all.
    await this.commit([...written, ...checks, ...audit.items], (failed) => ([...failed].some((index) => index >= written.length && index < written.length + checks.length) ? agentMoved() : this.conflict()), input.request, published);
    await flushAuditEvents(this.input, audit.events);
    return published;
  }

  /** The pinned design, parsed, when it is the draft's design with its agents pinned to numbers; otherwise `CONFIG_INVALID`. */
  private checkPinned(draft: ChainDefinition, candidate: PinnedChainDefinition): PinnedChainDefinition {
    const parsed = PinnedChainDefinitionSchema.safeParse(candidate);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw coded("CONFIG_INVALID", `pinned${first && first.path.length > 0 ? `.${first.path.join(".")}` : ""}: ${first?.message ?? "is not valid"}`);
    }
    const pinned = parsed.data;
    if (blankVersions(draft) !== blankVersions(pinned)) throw coded("CONFIG_INVALID", "pinned: this is not the design in the draft; validate the draft again");
    draft.steps.forEach((step, index) => {
      const other = pinned.steps[index];
      if (step.kind === "agent" && other?.kind === "agent" && typeof step.agent.version === "number" && step.agent.version !== other.agent.version) {
        throw coded("CONFIG_INVALID", `pinned.steps.${String(index)}.agent.version: the draft names version ${String(step.agent.version)}`);
      }
    });
    return pinned;
  }

  /**
   * The condition checks that make the pins of a publish hold at the moment it commits, one per item (a transaction cannot touch an item
   * twice), and the refusal of a built-in the org has turned off. Throws before anything is written when a pin is plainly wrong.
   */
  private async pinChecks(orgId: OrgId, draft: ChainDefinition, pinned: PinnedChainDefinition, guardrailsRevision: number, moved: () => Error = agentMoved): Promise<TransactItem[]> {
    interface Wanted { current: Set<number>; named: Set<number> }
    const custom = new Map<string, Wanted>();
    const builtins = new Map<string, Wanted>();
    draft.steps.forEach((draftStep, index) => {
      const step = pinned.steps[index];
      if (draftStep.kind !== "agent" || step?.kind !== "agent") return;
      const group = isBuiltinAgentId(step.agent.agentId) ? builtins : custom;
      const wanted = group.get(step.agent.agentId) ?? { current: new Set<number>(), named: new Set<number>() };
      wanted[draftStep.agent.version === "current" ? "current" : "named"].add((step).agent.version);
      group.set(step.agent.agentId, wanted);
    });
    const items: TransactItem[] = [];
    const disagree = (wanted: Wanted) => wanted.current.size > 1;

    for (const [agentId, wanted] of custom) {
      if (disagree(wanted)) throw coded("CONFIG_INVALID", "pinned: one agent's \"current\" cannot be two versions");
      const [current] = wanted.current;
      items.push(this.agentCheck(orgId, agentId, current));
      for (const version of new Set([...wanted.current, ...wanted.named])) {
        items.push({ ConditionCheck: { TableName: this.input.tableName, Key: agentKey(orgId, agentId, agentVersionSk(version)), ConditionExpression: "attribute_exists(pk)" } });
      }
    }

    if (builtins.size > 0) {
      const guardrails = await readGuardrailsWithRevision(this.input, orgId);
      for (const [agentId, wanted] of builtins) {
        if (disagree(wanted)) throw coded("CONFIG_INVALID", "pinned: one agent's \"current\" cannot be two versions");
        const name = this.agents.builtinName(agentId);
        if ((guardrails.guardrails.disabledBuiltins as string[]).includes(agentId)) throw coded("AGENT_UNAVAILABLE", `${name} is turned off in your company. Ask an admin to turn it on.`);
        const latest = this.agents.builtinLatestVersion(agentId);
        const settings = await this.agents.getBuiltinSettings(orgId, agentId);
        const orgPin = settings?.pinnedVersion ?? this.agents.builtinDefaultPin(agentId);
        for (const version of [...wanted.current, ...wanted.named]) {
          if (version > latest) throw coded("NOT_FOUND", `${name} has no version ${String(version)}`);
        }
        const [current] = wanted.current;
        if (current !== undefined && current !== orgPin) throw moved();
        for (const version of wanted.named) if (version > orgPin) throw moved();
        items.push(this.builtinCheck(orgId, agentId, current, wanted.named));
      }
      // The guardrails changed after the validation read them, so what it found may no longer hold.
      if (guardrails.revision !== guardrailsRevision) throw moved();
    }
    // Every publish commits at the guardrails the validation read (their forbidden models and limits judged each agent's recipe).
    items.push({
      ConditionCheck: {
        TableName: this.input.tableName,
        Key: agentGuardrailsKey(orgId),
        ...(guardrailsRevision === 0
          ? { ConditionExpression: NOT_EXISTS }
          : { ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": guardrailsRevision } }),
      },
    });
    return items;
  }

  /** A ConditionCheck of one item: the transaction fails when `when` does not hold of it. */
  private checkItem(key: { pk: string; sk: string }, when: (aliases: Aliases) => string): TransactItem {
    const aliases = new Aliases();
    const condition = when(aliases);
    return {
      ConditionCheck: {
        TableName: this.input.tableName,
        Key: key,
        ConditionExpression: condition,
        ...(Object.keys(aliases.names).length > 0 ? { ExpressionAttributeNames: aliases.names } : {}),
        ...(Object.keys(aliases.values).length > 0 ? { ExpressionAttributeValues: aliases.values } : {}),
      },
    };
  }

  /** The agent is still active and, when a step asked for its current version, that is still the version pinned. */
  private agentCheck(orgId: OrgId, agentId: string, current: number | undefined): TransactItem {
    return this.checkItem(agentKey(orgId, agentId, "META"), (a) => [`${a.name("status")} = ${a.value("active")}`, ...(current === undefined ? [] : [`${a.name("currentVersion")} = ${a.value(current)}`])].join(" AND "));
  }

  /** The org's pin of a built-in is still the pinned "current", and a release named outright is not above it. */
  private builtinCheck(orgId: OrgId, agentId: string, current: number | undefined, named: Set<number>): TransactItem {
    return this.checkItem(builtinSettingsKey(orgId, agentId), (a) => [
      ...(current === undefined ? [] : [`(attribute_not_exists(pk) OR ${a.name("pinnedVersion")} = ${a.value(current)})`]),
      ...[...named].map((version) => `(attribute_not_exists(pk) OR ${a.name("pinnedVersion")} >= ${a.value(version)})`),
    ].join(" AND "));
  }

  // ---- the owner totals (the counter itself is `spend/owner-budgets.ts`)

  /** The sum of the monthly budgets of the active chains that count for the owner `counts` asks about. */
  private async sumChainBudgets(orgId: OrgId, counts: (subject: BudgetSubject) => Promise<boolean>): Promise<number> {
    return cleanUsd((await this.countedChains(orgId, counts)).reduce((total, chain) => total + chain.monthlyBudgetUsd, 0));
  }

  /**
   * The active chains whose monthly budgets count in `owner`'s total, each with that budget (the chain side of the agent store's `ownerAgents`; the owner total's
   * contributors read it). A chain whose owner is a merged duplicate counts for its survivor.
   * A chain whose base is $0 is listed too (review I-2, as agents): it adds nothing to the counter, but this month's top-ups on it are spendable, so the effective
   * total adds them. One with no base at all, or an archived one, is not listed.
   */
  async ownerChains(orgId: OrgId, owner: string): Promise<Array<{ chainId: ChainId; monthlyBudgetUsd: number }>> {
    return this.countedChains(orgId, this.ownerBudgets.countsFor(orgId, owner));
  }

  private async countedChains(orgId: OrgId, counts: (subject: BudgetSubject) => Promise<boolean>): Promise<Array<{ chainId: ChainId; monthlyBudgetUsd: number }>> {
    const found: Array<{ chainId: ChainId; monthlyBudgetUsd: number }> = [];
    for (const chain of await this.list(orgId)) {
      if (ownerShare(chain) !== undefined && await counts(chain)) found.push({ chainId: chain.chainId, monthlyBudgetUsd: chain.monthlyBudgetUsd ?? 0 });
    }
    return found;
  }

  /** The counter items that take a chain from `before` to `after`, and what their refusals mean. */
  private async totalsFor(orgId: OrgId, before: BudgetSubject, after: BudgetSubject, cap?: OwnerCap): Promise<{ items: TransactItem[]; refuse: (failed: Set<number>) => Error }> {
    const totals = await this.ownerBudgets.itemsFor(orgId, before, after, cap, "agent and chain");
    return {
      items: totals.items,
      refuse: (failed) => {
        const outcome = totals.classify(failed);
        if (outcome.kind === "policy") return policyMoved();
        if (outcome.kind === "cap") return ownerOverCap(outcome.owner, "agent and chain");
        if (outcome.kind === "totals") return totalsChanged();
        return budgetConflict();
      },
    };
  }

  private async setStatus(orgId: OrgId, chainId: ChainId, status: "active" | "archived", by: string, request?: RequestMark, options: BudgetWriteOptions = {}): Promise<ChainRecord> {
    const actorChecks = status === "active" ? unarchiveActorChecks(this.input.tableName, orgId, by, request, options) : [];
    const chain = await this.require(orgId, chainId);
    const sourceGuard = (a: Aliases) => `${budgetGuard(chain)(a)}${status !== "active" ? "" : ` AND ${a.name("updatedAt")} = ${a.value(chain.updatedAt)}${options.manageSnapshot === undefined ? "" : ` AND ${budgetGuard(options.manageSnapshot)(a)}`}`}`;
    if (chain.status === status) {
      if (status === "active") {
        const actorStart = 1;
        await this.commit(...withOverride([
          this.update(chainKey(orgId, chainId, "META"), { set: { status }, when: sourceGuard }),
          ...actorChecks,
        ], failed => [...failed].some(index => index >= actorStart && index < actorStart + actorChecks.length) ? budgetActorRefused() : budgetConflict(), options, { tableName: this.input.tableName, orgId, by }), request, chain);
      }
      return chain;
    }
    const updatedAt = this.iso();
    const changed: ChainRecord = { ...chain, status, updatedAt };
    const totals = await this.totalsFor(orgId, chain, changed, options.ownerCap);
    const ownItems = [
      this.update(chainKey(orgId, chainId, "META"), { set: { status, updatedAt }, when: sourceGuard }),
      ...totals.items,
      this.event(orgId, chainId, status === "archived" ? "archived" : "unarchived", by, overrideDetail(options)),
    ];
    const actorStart = ownItems.length;
    const [items, refuse] = withOverride([...ownItems, ...actorChecks], failed =>
      [...failed].some(index => index >= actorStart && index < actorStart + actorChecks.length) ? budgetActorRefused() : totals.refuse(failed),
    options, { tableName: this.input.tableName, orgId, by });
    await this.commit(items, refuse, request, changed);
    return changed;
  }

  archive(orgId: OrgId, chainId: ChainId, by: string, request?: RequestMark, options?: BudgetWriteOptions): Promise<ChainRecord> {
    return this.setStatus(orgId, chainId, "archived", by, request, options);
  }

  unarchive(orgId: OrgId, chainId: ChainId, by: string, request?: RequestMark, options?: BudgetWriteOptions): Promise<ChainRecord> {
    return this.setStatus(orgId, chainId, "active", by, request, options);
  }

  /**
   * Sets the monthly budget; `undefined` clears it. It is counted in its owner's total in the same transaction, and only while the chain still has
   * the status, owner, accountable and budget that were read. Returns the chain as written.
   */
  async setBudget(orgId: OrgId, chainId: ChainId, monthlyUsd: number | undefined, by: string, request?: RequestMark, options: BudgetWriteOptions = {}): Promise<ChainRecord> {
    checkAmount("monthlyUsd", monthlyUsd);
    const actor = options.actor ?? options.overrideCap?.actor;
    if (actor === undefined) throw budgetActorRefused();
    if (actor !== undefined && (actor.developerId !== by || (request !== undefined && request.developerId !== actor.developerId))) throw budgetActorRefused();
    if (options.actor !== undefined && options.overrideCap !== undefined && (options.overrideCap.actor?.developerId !== actor?.developerId || options.overrideCap.actor?.role !== actor?.role)) throw budgetActorRefused();
    const actorChecks = actor === undefined || options.overrideCap !== undefined ? [] : budgetActorChecks(this.input.tableName, orgId, actor);
    const chain = await this.require(orgId, chainId);
    const updatedAt = this.iso();
    const written = withBudgetFields({ ...chain, updatedAt }, { monthlyBudgetUsd: monthlyUsd });
    const totals = await this.totalsFor(orgId, chain, written, options.ownerCap);
    const event = this.newEvent(orgId, chainId, "budget_changed", by, { ...withoutUndefined({ monthlyUsd, cleared: monthlyUsd === undefined }), ...overrideDetail(options) });
    const audit = await this.audited(() => chainBudgetEvents({
      orgId, actor: auditActorOf(by), occurredAt: event.at, occurrence: event.sk, chainId, before: chain.monthlyBudgetUsd, after: monthlyUsd,
    }));
    const items = [
      this.update(chainKey(orgId, chainId, "META"), {
        set: { monthlyBudgetUsd: monthlyUsd, updatedAt },
        ...(monthlyUsd === undefined ? { remove: ["monthlyBudgetUsd"] } : {}),
        when: aliases => `${budgetGuard(chain)(aliases)}${options.manageSnapshot === undefined ? "" : ` AND ${budgetGuard(options.manageSnapshot)(aliases)}`}`,
      }),
      ...totals.items,
      event.item,
      ...audit.items,
    ];
    const actorStart = items.length;
    await this.commit(...withOverride([...items, ...actorChecks], failed => (
      [...failed].some(index => index >= actorStart && index < actorStart + actorChecks.length) ? budgetActorRefused() : totals.refuse(failed)
    ), options, { tableName: this.input.tableName, orgId, by }), request, written);
    await flushAuditEvents(this.input, audit.events);
    return written;
  }

  /**
   * Moves the chain to another owner. A project's chain needs `accountable`; a member's has none. Who may do this, and that the accountable person
   * holds `manage_agents` on the project, are the route's checks.
   */
  async setOwner(orgId: OrgId, chainId: ChainId, owner: AgentOwner, by: string, accountable?: { developerId: string }, request?: RequestMark, options: BudgetWriteOptions = {}): Promise<ChainRecord> {
    checkOwner(owner, accountable);
    const actor = options.actor;
    if ((request !== undefined && actor === undefined) ||
      (actor !== undefined && (actor.developerId !== by || options.overrideCap !== undefined)) ||
      (request !== undefined && (request.orgId !== orgId || request.developerId !== actor?.developerId)) ||
      (actor === undefined && options.overrideCap === undefined && (by !== "system" || options.cause === undefined))) throw budgetActorRefused();
    const actorChecks = actor === undefined ? [] : budgetActorChecks(this.input.tableName, orgId, actor);
    const chain = await this.require(orgId, chainId);
    const managedOwner = (subject: BudgetSubject) => ({ owner: subject.owner, accountable: subject.accountable });
    if (options.manageSnapshot !== undefined && !sameJsonContent(managedOwner(chain), managedOwner(options.manageSnapshot))) throw budgetActorRefused();
    const updatedAt = this.iso();
    const { accountable: _before, ...rest } = chain; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped when the new owner has none
    const moved: ChainRecord = { ...rest, owner, ...(accountable === undefined ? {} : { accountable }), updatedAt };
    // The chain's budget leaves the old owner's total and joins the new one's, which the cap holds when one is given.
    const totals = await this.totalsFor(orgId, chain, moved, options.ownerCap);
    const guard = budgetGuard(chain);
    const event = this.newEvent(orgId, chainId, "owner_changed", by, { from: chain.owner, to: owner, ...(accountable === undefined ? {} : { accountable }), ...(options.cause === undefined ? {} : { cause: options.cause }), ...overrideDetail(options) });
    const audit = await this.audited(() => [ownerMovedEvent({
      orgId, actor: auditActorOf(by), occurredAt: event.at, occurrence: event.sk, agentId: chainId, from: chain.owner, to: owner,
      ...(accountable === undefined ? {} : { accountable: accountable.developerId }),
    }, "chain")]);
    const items = [
      this.update(chainKey(orgId, chainId, "META"), {
        set: { owner, accountable, updatedAt },
        ...(accountable === undefined ? { remove: ["accountable"] } : {}),
        when: (a) => `${a.name("updatedAt")} = ${a.value(chain.updatedAt)} AND ${guard(a)}${options.manageSnapshot === undefined ? "" : ` AND ${budgetGuard(options.manageSnapshot)(a)}`}`,
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

  /** Changes the maintainer answerable for a project's chain. That the new person holds `manage_agents` on the project is the route's check. */
  async setAccountable(orgId: OrgId, chainId: ChainId, accountable: { developerId: string }, by: string, request?: RequestMark, options: BudgetWriteOptions = {}): Promise<ChainRecord> {
    const actor = options.actor;
    if ((request !== undefined && actor === undefined) ||
      (actor !== undefined && (actor.developerId !== by || options.overrideCap !== undefined)) ||
      (request !== undefined && (request.orgId !== orgId || request.developerId !== actor?.developerId)) ||
      (actor === undefined && options.overrideCap === undefined && (by !== "system" || options.cause === undefined))) throw budgetActorRefused();
    const actorChecks = actor === undefined ? [] : budgetActorChecks(this.input.tableName, orgId, actor);
    const chain = await this.require(orgId, chainId);
    const managedOwner = (subject: BudgetSubject) => ({ owner: subject.owner, accountable: subject.accountable });
    if (options.manageSnapshot !== undefined && !sameJsonContent(managedOwner(chain), managedOwner(options.manageSnapshot))) throw budgetActorRefused();
    if (chain.owner.kind !== "project") throw coded("CONFIG_INVALID", "accountable: only a project's chain has an accountable maintainer");
    const updatedAt = this.iso();
    const changed: ChainRecord = { ...chain, accountable, updatedAt };
    const totals = await this.totalsFor(orgId, chain, withBudgetFields(chain, { accountable }), options.ownerCap);
    const guard = budgetGuard(chain);
    const event = this.newEvent(orgId, chainId, "owner_changed", by, { accountable, ...(chain.accountable === undefined ? {} : { from: chain.accountable }), ...(options.cause === undefined ? {} : { cause: options.cause }), ...overrideDetail(options) });
    const audit = await this.audited(() => [accountableChangedEvent({
      orgId, actor: auditActorOf(by), occurredAt: event.at, occurrence: event.sk, agentId: chainId, accountable: accountable.developerId,
      ...(chain.accountable === undefined ? {} : { previous: chain.accountable.developerId }),
    }, "chain")]);
    const items = [
      this.update(chainKey(orgId, chainId, "META"), { set: { accountable, updatedAt }, when: (a) => `${a.name("updatedAt")} = ${a.value(chain.updatedAt)} AND ${guard(a)}${options.manageSnapshot === undefined ? "" : ` AND ${budgetGuard(options.manageSnapshot)(a)}`}` }),
      ...totals.items,
      event.item,
      ...audit.items,
    ];
    const actorStart = items.length;
    await this.commit(...withOverride([...items, ...actorChecks], (failed) => (
      [...failed].some(index => index >= actorStart && index < actorStart + actorChecks.length) ? budgetActorRefused() : totals.refuse(failed)
    ), options, { tableName: this.input.tableName, orgId, by }), request, changed);
    await flushAuditEvents(this.input, audit.events);
    return changed;
  }

  // ---- versions and shares (one implementation with the agent store: `OwnedStore`)

  /**
   * Makes an earlier published version the current one. Later versions stay, and the next publish still numbers after them.
   * It applies only while the current version is still `expectedCurrentVersion`, and, like a publish, only while each agent the version pins is
   * still there and active (a custom agent), still allowed and not above the org's pin (a built-in), and the guardrails are at
   * `guardrailsRevision`, the revision the caller checked the version against (`validatePinnedChainForOrg`).
   */
  async rollback(input: { orgId: OrgId; chainId: ChainId; version: number; expectedCurrentVersion: number; guardrailsRevision: number; by: string; request?: RequestMark }): Promise<ChainRecord> {
    const { chainId, guardrailsRevision, ...rest } = input;
    const target = await this.getVersion(input.orgId, chainId, input.version);
    if (target === undefined) return this.rollbackItem({ ...rest, id: chainId });
    const moved = () => coded("CHAIN_REVISION_CONFLICT", ROLLBACK_MOVED);
    const items = await this.pinChecks(input.orgId, target.definition, target.definition, guardrailsRevision, moved);
    return this.rollbackItem({ ...rest, id: chainId, checks: { items, refused: moved } });
  }

  /** Changes the share set; see `OwnedStore.replaceItemShares`. Who may share, and that the principals exist, are the caller's checks (access.ts). */
  replaceShares(input: {
    orgId: OrgId;
    chainId: ChainId;
    upsert: Array<{ principal: AgentPrincipal; level: AgentShareLevel }>;
    remove: AgentPrincipal[];
    expectedSharesRevision: number;
    by: string;
    request?: RequestMark;
  }): Promise<void> {
    const { chainId, ...rest } = input;
    return this.replaceItemShares({ ...rest, id: chainId });
  }

  /** Takes `from`'s share of one chain away and gives it to `to` (Rovara's own move after a member merge or removal). */
  reassignShare(input: { orgId: OrgId; chainId: ChainId; from: AgentPrincipal; to?: AgentPrincipal; by: string; cause: MoveCause }): Promise<void> {
    const { chainId, ...rest } = input;
    return this.reassignItemShare({ ...rest, id: chainId });
  }
}
