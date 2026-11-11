// What an agent and a chain share as stored things (Plan 4 Task 3): an item with an owner, a draft, immutable numbered versions, shares
// with an index item per principal, and one EVENT# item per notable write. One implementation, parameterised by `kind`; `AgentStore` and
// `ChainStore` extend it, so the share, event and version code is the same code. Every multi-item write is one transaction.
import { randomBytes } from "node:crypto";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { agentKey, agentVersionSk, chainKey, chainVersionSk, principalChainSharesKey, principalKey, principalSharesKey, type AgentPrincipal, type AgentXErrorCode, type OrgId, type OrgKey } from "@rovara-code/contracts";
import { type AuditEventInput } from "@agentx/cloud-contracts";
import { auditProcessRolledBack, auditRolledBack } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditRuntime } from "../audit/outbox.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import {
  EXISTS, coded, commit as commitTransaction, putNew, strip, transact as sendTransaction, updateItem,
  type Aliases, type Item, type RequestMark, type TableInput, type TransactItem,
} from "./table-writes.js";

export type OwnedKind = "agent" | "chain";

/** What a share gives: `view` sees the item, `use` runs it, `edit` changes its draft. Owning it (`manage`) is not something a share gives. */
export type AgentShareLevel = "view" | "use" | "edit";

/** One principal's share of one agent or chain, as stored at `SHARE#<principal>`; the share-index item beside it carries the same level. */
export interface AgentShareRecord {
  principal: AgentPrincipal;
  level: AgentShareLevel;
  grantedBy: string;
  grantedAt: string;
}

/**
 * A transaction holds at most 100 items. A save of shares writes two per share it adds, changes or drops (the share and its index
 * item) plus the item's revision and one event, and, when the request is marked, its request item, so it can change at most 48.
 */
export const MAX_SHARE_CHANGES_PER_SAVE = 48;

/** Why Rovara moved something of a member's to someone else: the person was removed from the org, merged into another member, or stopped being a maintainer of the project (accountable only). */
export interface MoveCause {
  kind: "member_removed" | "member_merged" | "project_role_changed";
  developerId: string;
}

/** What differs between the two kinds: their keys, their entity types and the words of their conflicts. */
export interface OwnedKindSpec {
  kind: OwnedKind;
  idField: "agentId" | "chainId";
  key(orgId: OrgId, id: string, sk: "META" | "DRAFT" | `VERSION#${string}` | `SHARE#${string}` | `EVENT#${string}`): OrgKey;
  versionSk(version: number): `VERSION#${string}`;
  shareIndexKey(orgId: OrgId, principal: AgentPrincipal, id: string): OrgKey;
  entity: { event: string; share: string; shareIndex: string };
  conflictCode: AgentXErrorCode;
  /** What a save of shares answers when the share set moved since the writer read it. */
  sharesConflict: string;
}

export const AGENT_KIND: OwnedKindSpec = {
  kind: "agent",
  idField: "agentId",
  key: (orgId, id, sk) => agentKey(orgId, id, sk),
  versionSk: agentVersionSk,
  shareIndexKey: (orgId, principal, id) => principalSharesKey(orgId, principal, id),
  entity: { event: "AGENT_EVENT", share: "AGENT_SHARE", shareIndex: "AGENT_SHARE_INDEX" },
  conflictCode: "AGENT_REVISION_CONFLICT",
  sharesConflict: "Someone else changed who this agent is shared with. Reload it and make your change again.",
};

export const CHAIN_KIND: OwnedKindSpec = {
  kind: "chain",
  idField: "chainId",
  key: (orgId, id, sk) => chainKey(orgId, id, sk),
  versionSk: chainVersionSk,
  shareIndexKey: (orgId, principal, id) => principalChainSharesKey(orgId, principal, id),
  entity: { event: "CHAIN_EVENT", share: "CHAIN_SHARE", shareIndex: "CHAIN_SHARE_INDEX" },
  conflictCode: "CHAIN_REVISION_CONFLICT",
  sharesConflict: "Someone else changed who this chain is shared with. Reload it and make your change again.",
};

export interface OwnedStoreInput extends TableInput {
  /** The Audit Ledger's outbox; absent on a legacy install, where nothing is added. */
  audit?: AuditRuntime;
}

/** The part of an item's META that rollback reads and writes. */
export interface OwnedRecord {
  orgId: OrgId;
  name: string;
  currentVersion?: number;
  updatedAt: string;
}

/** The kinds of event the base writes itself, whichever kind of item it is. */
export type BaseEventKind = "rolled_back" | "shared";

export abstract class OwnedStore<Id extends string, Rec extends OwnedRecord, Version, EventKind extends string> {
  private eventSequence = 0;

  protected constructor(protected readonly input: OwnedStoreInput, protected readonly spec: OwnedKindSpec) {}

  protected iso(): string {
    return new Date(this.input.now()).toISOString();
  }

  protected conflict(): Error {
    return coded(this.spec.conflictCode, `Someone else changed this ${this.spec.kind}'s draft. Reload it and make your change again.`);
  }

  protected sharesConflict(): Error {
    return coded(this.spec.conflictCode, this.spec.sharesConflict);
  }

  protected async read(key: OrgKey): Promise<Item | undefined> {
    const response = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: key, ConsistentRead: true })) as { Item?: Item };
    return response.Item;
  }

  protected async queryAll(pk: string, skPrefix?: string): Promise<Item[]> {
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

  protected put(key: OrgKey, entityType: string, fields: Item): TransactItem {
    return putNew(this.input, key, entityType, fields);
  }

  /** An Update of one item: `set` values (undefined skipped), `remove` attributes and a condition built from the same aliases. */
  protected update(key: OrgKey, change: { set?: Item; remove?: string[]; when?: (aliases: Aliases) => string }): TransactItem {
    return updateItem(this.input, key, change);
  }

  /**
   * The one EVENT# item a write leaves, with its sort key and time, which are also the occurrence and the time of the audit events about the
   * same change. The sequence keeps one process's events in order; the random tail keeps two processes' apart.
   */
  protected newEvent(orgId: OrgId, id: Id, kind: EventKind | BaseEventKind, by: string, detail: Item = {}): { item: TransactItem; sk: string; at: string } {
    const at = this.iso();
    const tail = `${String(++this.eventSequence).padStart(6, "0")}-${randomBytes(3).toString("hex")}`;
    const sk = `EVENT#${at}#${tail}` as const;
    return { item: this.put(this.spec.key(orgId, id, sk), this.spec.entity.event, { orgId, [this.spec.idField]: id, kind, at, by, ...detail }), sk, at };
  }

  protected event(orgId: OrgId, id: Id, kind: EventKind | BaseEventKind, by: string, detail: Item = {}): TransactItem {
    return this.newEvent(orgId, id, kind, by, detail).item;
  }

  /**
   * The audit events of a write and their pending items, to add to the write's transaction (after every item whose refusal is mapped by position).
   * `build` runs only on an install with a ledger; if it throws, or an event is not valid, the write goes on without that event (logged, no value).
   * After the commit, `flushAuditEvents(this.input, events)` sends them.
   */
  protected async audited(build: () => AuditEventInput[]): Promise<{ items: TransactItem[]; events: AuditEventInput[] }> {
    const events = await tryAuditEvents(this.input, build);
    return { items: events.flatMap((event) => auditPending(this.input, event)), events };
  }

  protected transact(items: TransactItem[], refuse: (failed: Set<number>) => Error | undefined): Promise<void> {
    return sendTransaction(this.input, items, refuse);
  }

  /** `transact` with the request's own item added: the mark is written with the change or not at all. */
  protected commit(items: TransactItem[], refuse: (failed: Set<number>) => Error | undefined, request?: RequestMark, result?: unknown): Promise<void> {
    return commitTransaction(this.input, items, refuse, request, result);
  }

  protected abstract require(orgId: OrgId, id: Id): Promise<Rec>;

  // ---- reads

  async getVersion(orgId: OrgId, id: Id, version: number): Promise<Version | undefined> {
    if (!Number.isInteger(version) || version < 1) return undefined;
    const item = await this.read(this.spec.key(orgId, id, this.spec.versionSk(version)));
    return item === undefined ? undefined : (strip(item) as unknown as Version);
  }

  /** Every published version, oldest first. */
  async listVersions(orgId: OrgId, id: Id): Promise<Version[]> {
    const items = await this.queryAll(this.spec.key(orgId, id, "META").pk, "VERSION#");
    return items.map((item) => strip(item) as unknown as Version);
  }

  /** Who the item is shared with, in the order of their keys. */
  async listShares(orgId: OrgId, id: Id): Promise<AgentShareRecord[]> {
    const items = await this.queryAll(this.spec.key(orgId, id, "META").pk, "SHARE#");
    return items.map((item) => strip(item) as unknown as AgentShareRecord);
  }

  /** Every event of one item, oldest first. */
  async listEvents(orgId: OrgId, id: Id): Promise<Item[]> {
    return (await this.queryAll(this.spec.key(orgId, id, "META").pk, "EVENT#")).map(strip);
  }

  /** The items shared with one principal, in the order of their ids (from the share index). */
  async listSharedWith(orgId: OrgId, principal: AgentPrincipal): Promise<Id[]> {
    return (await this.queryAll(this.spec.shareIndexKey(orgId, principal, "").pk)).map((item) => item["sk"] as Id);
  }

  // ---- writes

  /**
   * Makes an earlier published version the current one. Later versions stay, and the next publish still numbers after them.
   * It applies only while the current version is still `expectedCurrentVersion`, so a publish that landed since can't be undone unseen.
   */
  protected async rollbackItem(input: {
    orgId: OrgId; id: Id; version: number; expectedCurrentVersion: number; by: string; request?: RequestMark;
    /** Whether the rollback made anything less safe, which a person confirmed; only a project's process layer's event says so. */
    safety?: "safe" | "less_safe";
    /** Optional tighter bound for a reviewed protocol, including audit and request mark. */
    maxTransactionItems?: number;
    /** Condition checks that must hold when the write commits (a chain's agents), and what a failed one means; the item's own conditions give the draft conflict. */
    checks?: { items: TransactItem[]; refused: () => Error };
  }): Promise<Rec> {
    const item = await this.require(input.orgId, input.id);
    if (await this.getVersion(input.orgId, input.id, input.version) === undefined) throw coded("NOT_FOUND", `${item.name} has no version ${String(input.version)}`);
    const updatedAt = this.iso();
    const rolled: Rec = { ...item, currentVersion: input.version, updatedAt };
    const event = this.newEvent(input.orgId, input.id, "rolled_back", input.by, { from: input.expectedCurrentVersion, to: input.version });
    // A project's process layer audits `process.rolled_back` instead.
    const audit = await this.audited(() => [(item as { purpose?: unknown }).purpose === "process"
      ? auditProcessRolledBack({
        orgId: input.orgId, actor: auditActorOf(input.by), occurredAt: event.at, occurrence: event.sk, agentId: input.id,
        fromVersion: input.expectedCurrentVersion, toVersion: input.version, safety: input.safety ?? "safe",
      })
      : auditRolledBack({
        orgId: input.orgId, actor: auditActorOf(input.by), occurredAt: event.at, occurrence: event.sk, scope: this.spec.kind, targetId: input.id,
        fromVersion: input.expectedCurrentVersion, toVersion: input.version,
      })]);
    const items:TransactItem[]=[
      this.update(this.spec.key(input.orgId, input.id, "META"), {
        set: { currentVersion: input.version, updatedAt },
        when: (a) => `${a.name("currentVersion")} = ${a.value(input.expectedCurrentVersion)}`,
      }),
      event.item,
      ...(input.checks?.items ?? []),
      ...audit.items,
    ];
    if(input.maxTransactionItems!==undefined&&items.length+(input.request===undefined?0:1)>input.maxTransactionItems) throw coded("CONFIG_INVALID","The model rollback exceeds the transaction limit.");
    await this.commit(items, (failed) => (input.checks !== undefined && [...failed].some((index) => index >= 2 && index < 2 + input.checks!.items.length) ? input.checks.refused() : this.conflict()), input.request, rolled);
    await flushAuditEvents(this.input, audit.events);
    return rolled;
  }

  /**
   * Changes the share set in one transaction: each `upsert` writes the share and its index item, each `remove` deletes both, and one
   * `shared` event records it. It applies only while the item's `sharesRevision` is still `expectedSharesRevision` (0 before the first
   * share), so of two concurrent saves one wins and the other conflicts. Who may share, and that the principals exist, are the caller's checks.
   */
  protected async replaceItemShares(input: {
    orgId: OrgId;
    id: Id;
    upsert: Array<{ principal: AgentPrincipal; level: AgentShareLevel }>;
    remove: AgentPrincipal[];
    expectedSharesRevision: number;
    by: string;
    request?: RequestMark;
  }): Promise<void> {
    if (input.upsert.length + input.remove.length > MAX_SHARE_CHANGES_PER_SAVE) {
      throw coded("CONFIG_INVALID", `shares: change at most ${String(MAX_SHARE_CHANGES_PER_SAVE)} people or groups in one save`);
    }
    const { spec } = this;
    const idField = spec.idField;
    const at = this.iso();
    const expected = input.expectedSharesRevision;
    const items: TransactItem[] = [
      this.update(spec.key(input.orgId, input.id, "META"), {
        set: { sharesRevision: expected + 1 },
        when: (a) => (expected === 0 ? `${EXISTS} AND attribute_not_exists(${a.name("sharesRevision")})` : `${a.name("sharesRevision")} = ${a.value(expected)}`),
      }),
    ];
    const write = (key: OrgKey, entityType: string, fields: Item): TransactItem => ({ Put: { TableName: this.input.tableName, Item: { ...key, entityType, ...fields } } });
    const drop = (key: OrgKey): TransactItem => ({ Delete: { TableName: this.input.tableName, Key: key } });
    for (const { principal, level } of input.upsert) {
      items.push(
        write(spec.key(input.orgId, input.id, `SHARE#${principalKey(principal)}`), spec.entity.share, { orgId: input.orgId, [idField]: input.id, principal, level, grantedBy: input.by, grantedAt: at }),
        write(spec.shareIndexKey(input.orgId, principal, input.id), spec.entity.shareIndex, { [idField]: input.id, principal, level, grantedAt: at }),
      );
    }
    for (const principal of input.remove) {
      items.push(drop(spec.key(input.orgId, input.id, `SHARE#${principalKey(principal)}`)), drop(spec.shareIndexKey(input.orgId, principal, input.id)));
    }
    items.push(this.event(input.orgId, input.id, "shared", input.by, {
      shared: input.upsert.map(({ principal, level }) => ({ principal: principalKey(principal), level })),
      unshared: input.remove.map((principal) => principalKey(principal)),
    }));
    await this.commit(items, () => this.sharesConflict(), input.request, input.upsert);
  }

  /**
   * Takes `from`'s share of one item away and, when `to` is given, gives `to` the share instead (the higher level when `to` already has
   * one; `to` keeps its own item then). Rovara's own move after a member merge or removal (Task 11): one transaction holds the item's
   * share revision, the share and index items and one `shared` event naming the cause, so a save that raced it conflicts and is read again.
   * Nothing is written when `from` holds no share, so the move can be repeated.
   */
  protected async reassignItemShare(input: { orgId: OrgId; id: Id; from: AgentPrincipal; to?: AgentPrincipal; by: string; cause: MoveCause }): Promise<void> {
    const { orgId, id, from, to } = input;
    const { spec } = this;
    if (to !== undefined && principalKey(to) === principalKey(from)) return;
    const rank = (level: unknown) => ["view", "use", "edit"].indexOf(String(level));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [meta, own, index] = await Promise.all([
        this.read(spec.key(orgId, id, "META")), this.read(spec.key(orgId, id, `SHARE#${principalKey(from)}`)), this.read(spec.shareIndexKey(orgId, from, id)),
      ]);
      if (own === undefined && index === undefined) return;
      const drop = (key: OrgKey): TransactItem => ({ Delete: { TableName: this.input.tableName, Key: key } });
      const dropped = [...(own === undefined ? [] : [drop(spec.key(orgId, id, `SHARE#${principalKey(from)}`))]), ...(index === undefined ? [] : [drop(spec.shareIndexKey(orgId, from, id))])];
      if (meta === undefined || own === undefined) {
        // Nothing to guard or to give: an item that is gone, or an index item left without its share.
        await this.transact(dropped, () => undefined);
        return;
      }
      const revision = typeof meta["sharesRevision"] === "number" ? meta["sharesRevision"] : 0;
      const theirs = to === undefined ? undefined : await this.read(spec.key(orgId, id, `SHARE#${principalKey(to)}`));
      const giveTo = to !== undefined && (theirs === undefined || rank(own["level"]) > rank(theirs["level"])) ? to : undefined;
      const level = own["level"];
      const items: TransactItem[] = [
        this.update(spec.key(orgId, id, "META"), {
          set: { sharesRevision: revision + 1 },
          when: (a) => (revision === 0 ? `${EXISTS} AND attribute_not_exists(${a.name("sharesRevision")})` : `${a.name("sharesRevision")} = ${a.value(revision)}`),
        }),
        ...(giveTo === undefined ? [] : [
          { Put: { TableName: this.input.tableName, Item: { ...spec.key(orgId, id, `SHARE#${principalKey(giveTo)}`), entityType: spec.entity.share, orgId, [spec.idField]: id, principal: giveTo, level, grantedBy: own["grantedBy"], grantedAt: own["grantedAt"] } } },
          { Put: { TableName: this.input.tableName, Item: { ...spec.shareIndexKey(orgId, giveTo, id), entityType: spec.entity.shareIndex, [spec.idField]: id, principal: giveTo, level, grantedAt: own["grantedAt"] } } },
        ] satisfies TransactItem[]),
        ...dropped,
        this.event(orgId, id, "shared", input.by, {
          shared: giveTo === undefined ? [] : [{ principal: principalKey(giveTo), level }], unshared: [principalKey(from)], cause: input.cause,
        }),
      ];
      try {
        await this.transact(items, (failed) => (failed.has(0) ? this.sharesConflict() : undefined));
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== this.spec.conflictCode || attempt === 2) throw error;
      }
    }
  }
}
