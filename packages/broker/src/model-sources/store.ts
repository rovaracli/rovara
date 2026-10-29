// Company AI sources (Plan 3 Task 24b): the record of an org's sources, their order, and which of them hold a key. One item per org holds the
// whole document and a revision; every change is one transaction that writes the new document (only while it is still at the revision that was
// read), the request item that makes the change repeatable (R18), and the change's audit item. The key itself is never here: it goes to the model
// proxy's own credential store (ModelAccess.upsertSource) and `credentials` only says which sources have one.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  AgentXError,
  CLI_COMMAND_NAME,
  INDEX_EXPIRY_ATTRIBUTE,
  ModelSourceIdSchema,
  ModelSourceSchema,
  OrgIdSchema,
  OrgModelSourcesSchema,
  agentRequestKey,
  canonicalJson,
  customSourceLimitProblem,
  defaultModelSourceOrder,
  modelSourceOrgProblem,
  modelSourcesKey,
  type AuditEventInput,
  type ModelSource,
  type OrgId,
  type OrgModelSources,
} from "@agentx/contracts";
import { commit, coded, failedIndexes, NOT_EXISTS, withoutUndefined, type Item, type RequestMark, type TransactItem } from "../agents/table-writes.js";
import { auditModelSourceOrderChanged, auditModelSourceRemoved, auditModelSourceSaved, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, tryAuditEvents, type AuditRuntime } from "../audit/outbox.js";
import { changeReviewedSourceOrder } from "./reviewed-order.js";
import { auditActorOf } from "../audit/plan3-hooks.js";

export interface ModelSourceStoreInput {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  /** The install-wide ChatGPT switch, read while an org has no record yet: a new org's order follows it, so today's ChatGPT tasks do not change. */
  chatgptSwitch: () => Promise<boolean>;
  /** The Audit Ledger's outbox. Absent on a legacy install: nothing is audited. */
  audit?: AuditRuntime;
}

/** A source whose record entry is gone but whose proxy registration and egress request may not be: the removal's cleanup is owed until it clears. */
export interface RemovalTombstone {
  sourceId: string;
  kind: string;
}

/** The record as stored: the org's sources, which of them hold a key, removals whose cleanup is owed, and the revision the next change must name (0 while the org has no record). */
export interface StoredModelSources extends OrgModelSources {
  credentials: string[];
  removing: RemovalTombstone[];
  revision: number;
}

/** One small item per org that has a record, so the sweeper can walk the orgs without scanning the table. */
export const MODEL_SOURCES_DIRECTORY_PK = "MODEL_SOURCES_ORGS";
/** A removal whose cleanup keeps failing is not allowed to pile up without end in the record. */
const MAX_TOMBSTONES = 50;

/** How many times a change reads the record again after another change landed first. */
const ATTEMPTS = 3;
const MISSING = "no AI source has that ID";
const CONFLICT = "your company's AI sources changed while saving; reload and try again";
const CHATGPT_OFF = `order: Sign in with ChatGPT is turned off in this Rovara; ask an admin to turn it on with: ${CLI_COMMAND_NAME} config set models.chatgpt.enabled true`;
const SOURCE_CHANGED = "this source changed since it was read; reload and try again";
const UNREADABLE = "your company's AI sources can't be read; ask a Rovara admin to look at them";

/** The conflict a transaction's condition raised: the document changed since it was read. */
class RevisionConflict extends Error {}

/** What a change decided, given the record as it was read. */
interface Plan<T> {
  /** The record to write; absent when the change leaves it as it is (only the request item is written). */
  next?: Omit<StoredModelSources, "revision">;
  /** Builds the audit events once the new revision and the time are known. */
  events?: (revision: number, at: string) => AuditEventInput[];
  result: T;
}

function parseOrg(orgId: string): OrgId {
  const parsed = OrgIdSchema.safeParse(orgId);
  if (!parsed.success) throw coded("FORBIDDEN", "that is not an organization id");
  return parsed.data;
}

function requireActor(by: unknown): void {
  if (typeof by !== "string" || by === "") throw coded("CONFIG_INVALID", "by: say who is making this change");
}

export class ModelSourceStore {
  constructor(private readonly input: ModelSourceStoreInput) {}

  private iso(): string {
    return new Date(this.input.now()).toISOString();
  }

  /**
   * The org's record. An org that never changed anything has none: no sources, and the default order. A record that cannot be read is an error,
   * never the defaults, because the defaults would quietly undo what an admin set.
   */
  async read(orgId: string): Promise<StoredModelSources> {
    return (await this.readIfAny(orgId)) ?? { sources: [], order: defaultModelSourceOrder(await this.input.chatgptSwitch()), credentials: [], removing: [], revision: 0 };
  }

  /** The org's record, or undefined when it has none (nothing is made up: the sweeper and the org close need to tell the two apart). */
  async readIfAny(orgId: string): Promise<StoredModelSources | undefined> {
    const org = parseOrg(orgId);
    const response = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: modelSourcesKey(org), ConsistentRead: true })) as { Item?: Item };
    const item = response.Item;
    if (item === undefined) return undefined;
    const document = OrgModelSourcesSchema.safeParse({
      sources: item.sources, order: item.order,
      ...(item.assistantModel === undefined ? {} : { assistantModel: item.assistantModel }),
      ...(item.chatgptPreferredModel === undefined ? {} : { chatgptPreferredModel: item.chatgptPreferredModel }),
    });
    const credentials = Array.isArray(item.credentials) ? item.credentials : undefined;
    const removing = item.removing === undefined ? [] : item.removing;
    const tombstones = Array.isArray(removing) && removing.every((entry) => typeof entry === "object" && entry !== null && typeof (entry as Item).sourceId === "string" && typeof (entry as Item).kind === "string") ? removing as RemovalTombstone[] : undefined;
    const known = new Set<string>(document.success ? document.data.sources.map((source) => source.sourceId) : []);
    if (!document.success || credentials === undefined || !credentials.every((id) => typeof id === "string" && known.has(id)) || tombstones === undefined || typeof item.revision !== "number" || !Number.isInteger(item.revision) || item.revision < 1) {
      // A path and a code only: a value could be a label or a host.
      console.error(JSON.stringify({ component: "broker", level: "error", event: "model_sources_invalid", orgId: org, problem: document.success ? "shape" : document.error.issues[0]?.path.join(".") ?? "document" }));
      throw coded("CONFIG_INVALID", UNREADABLE);
    }
    return { ...document.data, credentials: credentials as string[], removing: tombstones.map(({ sourceId, kind }) => ({ sourceId, kind })), revision: item.revision };
  }

  /** The record without its bookkeeping: what ChatGPT's task selection and the router read. */
  async orgSources(orgId: string): Promise<OrgModelSources> {
    const { credentials: _credentials, removing: _removing, revision: _revision, ...sources } = await this.read(orgId); // eslint-disable-line @typescript-eslint/no-unused-vars -- bookkeeping, not part of the document
    return sources;
  }

  /** What an earlier request of this developer's did, if it did anything. */
  async getRequest(orgId: OrgId, developerId: string, requestId: string): Promise<{ fingerprint: string; result: unknown } | undefined> {
    const response = await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: agentRequestKey(orgId, developerId, requestId), ConsistentRead: true })) as { Item?: Item };
    const item = response.Item;
    const expires = item?.[INDEX_EXPIRY_ATTRIBUTE];
    if (item === undefined || (typeof expires === "number" && expires <= Math.floor(this.input.now() / 1000))) return undefined;
    return { fingerprint: String(item.fingerprint), result: item.result };
  }

  /**
   * Reads the record, plans the change, and writes it conditional on the revision that was read. A change that lost a race reads again and plans again
   * (the plan may now throw, or come out different); after `ATTEMPTS` it is IDEMPOTENCY_CONFLICT. A repeat of the request, found before or after a lost
   * race, is answered from the stored outcome and writes nothing.
   */
  private async mutate<T>(orgId: OrgId, by: string, request: RequestMark | undefined, plan: (current: StoredModelSources) => Plan<T>): Promise<{ result: T; replayed: boolean }> {
    requireActor(by);
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      if (request !== undefined) {
        const earlier = await this.getRequest(orgId, request.developerId, request.requestId);
        if (earlier !== undefined) {
          if (earlier.fingerprint !== request.fingerprint) throw coded("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
          return { result: earlier.result as T, replayed: true };
        }
      }
      const current = await this.read(orgId);
      const planned = plan(current);
      const at = this.iso();
      const revision = planned.next === undefined ? current.revision : current.revision + 1;
      const events = planned.next === undefined ? [] : await tryAuditEvents(this.input, () => planned.events?.(revision, at) ?? []);
      const key = modelSourcesKey(orgId);
      const guard = current.revision === 0 ? { ConditionExpression: NOT_EXISTS } : { ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": current.revision } };
      const document: TransactItem = planned.next === undefined
        // A change that stores nothing still holds the record where it was read, so its request item says what was true when it was answered.
        ? { ConditionCheck: { TableName: this.input.tableName, Key: key, ...guard } }
        : { Put: { TableName: this.input.tableName, Item: documentItem(orgId, planned.next, revision, by, at), ...guard } };
      try {
        // The directory item rides with every change of the record, so the sweeper finds an org with a record and a crash cannot leave one without the other.
        const directory: TransactItem[] = planned.next === undefined ? [] : [{ Put: { TableName: this.input.tableName, Item: { pk: MODEL_SOURCES_DIRECTORY_PK, sk: orgId, entityType: "MODEL_SOURCES_ORG", updatedAt: at } } }];
        await commit(this.input, [document, ...directory, ...events.flatMap((event) => auditPending(this.input, event))], (failed) => (failed.has(0) ? new RevisionConflict() : undefined), request, planned.result);
      } catch (error) {
        // A lost race on the record, or on the request's own item (the same request arriving twice at once): read again, which finds the request's outcome.
        if (error instanceof RevisionConflict || (request !== undefined && error instanceof AgentXError && error.code === "IDEMPOTENCY_CONFLICT")) continue;
        throw error;
      }
      await flushAuditEvents(this.input, events);
      return { result: planned.result, replayed: false };
    }
    throw coded("IDEMPOTENCY_CONFLICT", CONFLICT);
  }

  /**
   * Adds a source or changes one. `source` is the whole source as the server holds it (its id, and for Bedrock the external id and `tested`); it is
   * validated again here. `mode` says what the caller read: a source it is adding (which must not exist yet) or one it is changing (which must still be
   * there, so a change that lost a race with a removal does not bring the source back). `keyStored` says this write stored a key with the proxy; without
   * it, whatever key the source had stays. A new source is not in the order until an admin puts it there.
   */
  async save(input: {
    orgId: string; source: ModelSource; mode: "create" | "update"; keyStored?: boolean | undefined; by: string; request?: RequestMark | undefined;
    /**
     * What the caller checked its change against. A change is refused as a conflict, never planned again, when the record has moved (`revision`) or the source
     * is no longer the one that was read (`source`): a key and a host that were checked together stay together.
     */
    expect?: { revision: number } | { source: ModelSource } | undefined;
  }): Promise<{ sourceId: string }> {
    const orgId = parseOrg(input.orgId);
    const parsed = ModelSourceSchema.safeParse(input.source);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw coded("CONFIG_INVALID", `source${first && first.path.length > 0 ? `.${first.path.join(".")}` : ""}: ${first?.message ?? "is not valid"}`);
    }
    const source = parsed.data;
    const problem = modelSourceOrgProblem(orgId, source);
    if (problem !== undefined) throw coded("CONFIG_INVALID", `source: ${problem}`);
    const { result } = await this.mutate(orgId, input.by, input.request, (current): Plan<{ sourceId: string }> => {
      const existing = current.sources.find((candidate) => candidate.sourceId === source.sourceId);
      if (input.mode === "update" && existing === undefined) throw coded("NOT_FOUND", MISSING);
      if (input.expect !== undefined && "revision" in input.expect && current.revision !== input.expect.revision) throw coded("IDEMPOTENCY_CONFLICT", CONFLICT);
      if (input.expect !== undefined && "source" in input.expect && canonicalJson(existing) !== canonicalJson(input.expect.source)) throw coded("IDEMPOTENCY_CONFLICT", SOURCE_CHANGED);
      if (input.mode === "create" && existing !== undefined) throw coded("CONFIG_INVALID", "source: that source already exists");
      if (existing !== undefined && existing.kind !== source.kind) throw coded("CONFIG_INVALID", "source.kind: a source's kind can't change; remove it and add a new one");
      if (existing === undefined) {
        const tooMany = customSourceLimitProblem(current.sources.length);
        if (tooMany !== undefined) throw coded("CONFIG_INVALID", tooMany);
      }
      const sources = existing === undefined ? [...current.sources, source] : current.sources.map((candidate) => (candidate.sourceId === source.sourceId ? source : candidate));
      const credentials = input.keyStored === true && !current.credentials.includes(source.sourceId) ? [...current.credentials, source.sourceId] : current.credentials;
      const change = existing === undefined ? "created" : existing.kind === "bedrock" && source.kind === "bedrock" && !existing.tested && source.tested && sameBedrockSettings(existing, source) ? "tested" : "updated";
      return {
        next: { ...kept(current), sources, credentials },
        events: (revision, at) => [auditModelSourceSaved({
          orgId, actor: auditActorOf(input.by), occurredAt: at, occurrence: auditOccurrence(String(revision)), sourceId: source.sourceId, sourceKind: source.kind, change,
        })],
        result: { sourceId: source.sourceId },
      };
    });
    return result;
  }

  /** Removes a source and its place in the order. It refuses to leave the order empty, since nothing could then serve a task. */
  async remove(input: { orgId: string; sourceId: string; by: string; request?: RequestMark | undefined }): Promise<{ sourceId: string; kind: string }> {
    const orgId = parseOrg(input.orgId);
    const { result } = await this.mutate(orgId, input.by, input.request, (current): Plan<{ sourceId: string; kind: string }> => {
      const existing = ModelSourceIdSchema.safeParse(input.sourceId).success ? current.sources.find((candidate) => candidate.sourceId === input.sourceId) : undefined;
      if (existing === undefined) throw coded("NOT_FOUND", MISSING);
      const order = current.order.filter((id) => id !== existing.sourceId);
      if (order.length === 0) throw coded("CONFIG_INVALID", "order: put another source in the order before removing the last one");
      const orderChanged = order.length !== current.order.length;
      if (current.removing.length >= MAX_TOMBSTONES) throw coded("RUNTIME_UNAVAILABLE", "earlier removals haven't finished; try again in a few minutes");
      return {
        // The tombstone commits with the removal: whatever dies after it, the cleanup is owed in the record and the next write, read or sweep finishes it.
        next: {
          ...kept(current), sources: current.sources.filter((candidate) => candidate.sourceId !== existing.sourceId), credentials: current.credentials.filter((id) => id !== existing.sourceId), order,
          removing: [...current.removing.filter((entry) => entry.sourceId !== existing.sourceId), { sourceId: existing.sourceId, kind: existing.kind }],
        },
        events: (revision, at) => [
          auditModelSourceRemoved({ orgId, actor: auditActorOf(input.by), occurredAt: at, occurrence: auditOccurrence(String(revision)), sourceId: existing.sourceId, sourceKind: existing.kind }),
          ...(orderChanged ? [auditModelSourceOrderChanged({ orgId, actor: auditActorOf(input.by), occurredAt: at, occurrence: auditOccurrence(String(revision)), count: order.length })] : []),
        ],
        result: { sourceId: existing.sourceId, kind: existing.kind },
      };
    });
    return result;
  }

  /** Sets the order sources are tried in. It names at least one source, none twice, and only `rovara`, `personal-chatgpt` and sources the org has. */
  async setOrder(input: { orgId: string; order: readonly string[]; by: string; request?: RequestMark | undefined; expectedRevision?: number | undefined; expectedOrgId?: string | undefined; expectedDeveloperId?: string | undefined }): Promise<{ order: string[]; revision?: number }> {
    if (input.expectedRevision !== undefined) return changeReviewedSourceOrder({ ...this.input, read: (orgId) => this.read(orgId) }, { ...input, expectedRevision: input.expectedRevision });
    const orgId = parseOrg(input.orgId);
    const adding = input.order.includes("personal-chatgpt");
    // The install-wide switch is a hard off: ChatGPT cannot be put into an order while it is off. An order that already has it may be changed around it.
    const switchOn = adding ? await this.input.chatgptSwitch() : true;
    const { result } = await this.mutate(orgId, input.by, input.request, (current): Plan<{ order: string[] }> => {
      if (input.order.length === 0) throw coded("CONFIG_INVALID", "order: name at least one source");
      if (adding && !switchOn && !current.order.includes("personal-chatgpt")) throw coded("CONFIG_INVALID", CHATGPT_OFF);
      const { credentials: _credentials, removing: _removing, ...contract } = kept(current); // eslint-disable-line @typescript-eslint/no-unused-vars -- bookkeeping, not part of the contract
      const candidate = OrgModelSourcesSchema.safeParse({ ...contract, order: input.order });
      if (!candidate.success) {
        // The message names the rule that failed, never the id the client sent.
        const message = candidate.error.issues[0]?.message ?? "is not valid";
        throw coded("CONFIG_INVALID", message.startsWith("order ") ? message : `order: ${message}`);
      }
      const order = candidate.data.order;
      if (order.length === current.order.length && order.every((id, index) => id === current.order[index])) return { result: { order } };
      return {
        next: { ...kept(current), order },
        events: (revision, at) => [auditModelSourceOrderChanged({ orgId, actor: auditActorOf(input.by), occurredAt: at, occurrence: auditOccurrence(String(revision)), count: order.length })],
        result: { order },
      };
    });
    return result;
  }

  /** Clears a removal's tombstone once its cleanup is done. A tombstone that is already gone is not an error: two cleanups may finish the same removal. */
  async finishRemoval(input: { orgId: string; sourceId: string }): Promise<void> {
    const orgId = parseOrg(input.orgId);
    await this.mutate(orgId, "system", undefined, (current): Plan<undefined> => {
      if (!current.removing.some((entry) => entry.sourceId === input.sourceId)) return { result: undefined };
      return { next: { ...kept(current), removing: current.removing.filter((entry) => entry.sourceId !== input.sourceId) }, result: undefined };
    });
  }

  /**
   * Says a source has no key any more, because the proxy's was dropped (a host move that failed to save must not leave the new key beside the old host).
   * A source that is not there, or has no key, is left alone.
   */
  async dropCredential(input: { orgId: string; sourceId: string; by: string }): Promise<void> {
    const orgId = parseOrg(input.orgId);
    await this.mutate(orgId, input.by, undefined, (current): Plan<undefined> => {
      const existing = current.sources.find((candidate) => candidate.sourceId === input.sourceId);
      if (existing === undefined || !current.credentials.includes(input.sourceId)) return { result: undefined };
      return {
        next: { ...kept(current), credentials: current.credentials.filter((id) => id !== input.sourceId) },
        events: (revision, at) => [auditModelSourceSaved({
          orgId, actor: auditActorOf(input.by), occurredAt: at, occurrence: auditOccurrence(String(revision)), sourceId: existing.sourceId, sourceKind: existing.kind, change: "updated",
        })],
        result: undefined,
      };
    });
  }

  /**
   * Deletes the org's record and directory item: the org is closed and the sources the record held at `revision` (undefined: no record) have been taken
   * out of the proxy. It holds only while the record is still at that revision; a source added or removed meanwhile is IDEMPOTENCY_CONFLICT, and the
   * caller releases again.
   */
  async deleteRecord(orgId: string, revision?: number): Promise<void> {
    const org = parseOrg(orgId);
    const guard = revision === undefined
      ? { ConditionExpression: NOT_EXISTS }
      : { ConditionExpression: "#revision = :revision", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":revision": revision } };
    try {
      await this.input.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: this.input.tableName, Key: modelSourcesKey(org), ...guard } },
          { Delete: { TableName: this.input.tableName, Key: { pk: MODEL_SOURCES_DIRECTORY_PK, sk: org } } },
        ],
      }));
    } catch (error) {
      if (failedIndexes(error)?.has(0) === true) throw coded("IDEMPOTENCY_CONFLICT", CONFLICT);
      throw error;
    }
  }

  /** The orgs that have a record, in id order, after `after`: at most `limit`. */
  async listOrgs(after: string | undefined, limit: number): Promise<OrgId[]> {
    const page = await this.input.documentClient.send(new QueryCommand({
      TableName: this.input.tableName, ConsistentRead: true, Limit: limit,
      KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": MODEL_SOURCES_DIRECTORY_PK },
      // A start key need not be an item: the read resumes after it.
      ...(after === undefined ? {} : { ExclusiveStartKey: { pk: MODEL_SOURCES_DIRECTORY_PK, sk: after } }),
    })) as { Items?: Array<{ sk?: unknown }> };
    return (page.Items ?? []).flatMap((item) => {
      const parsed = OrgIdSchema.safeParse(item.sk);
      return parsed.success ? [parsed.data] : [];
    });
  }
}

/** The part of a record a change keeps unless it changes it. */
function kept(current: StoredModelSources): Omit<StoredModelSources, "revision"> {
  return {
    sources: current.sources, order: current.order, credentials: current.credentials, removing: current.removing,
    ...(current.assistantModel === undefined ? {} : { assistantModel: current.assistantModel }),
    ...(current.chatgptPreferredModel === undefined ? {} : { chatgptPreferredModel: current.chatgptPreferredModel }),
  };
}

function sameBedrockSettings(left: ModelSource, right: ModelSource): boolean {
  return left.kind === "bedrock" && right.kind === "bedrock" && left.roleArn === right.roleArn && left.region === right.region && JSON.stringify(left.models) === JSON.stringify(right.models);
}

/** The item as written: JSON round-tripped so no `undefined` reaches DynamoDB. */
function documentItem(orgId: OrgId, next: Omit<StoredModelSources, "revision">, revision: number, by: string, at: string): Item {
  return JSON.parse(JSON.stringify(withoutUndefined({ ...modelSourcesKey(orgId), entityType: "ORG_MODEL_SOURCES", revision, ...next, updatedBy: by, updatedAt: at }))) as Item;
}

