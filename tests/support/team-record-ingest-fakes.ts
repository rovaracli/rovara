// Fakes for the Team record ingest taps (lane "ingest"). They stand in for the record core (R2 sink, source rows, mode, identity resolver) that
// another lane builds; the taps only ever see the interfaces in `team-record/sources/ports.ts`.
import {
  idempotencyKey, type ActorResolverPort, type CaptureModePort, type PushIndexPort, type PushRecord, type RecordDraft, type RecordHistoryPort, type RecordSinkPort, type RovaraPullRequest, type RovaraPullRequestIndexPort, type SourceConfig,
  type SourceConfigPort, type SourceSystem, type TombstoneCause, type TransientDistillerPort, type TrustClass, type Audience,
} from "../../packages/broker/src/team-record/sources/ports.js";

export const WS = "ws-1";

export class FakeSink implements RecordSinkPort, RecordHistoryPort {
  readonly puts: RecordDraft[] = [];
  readonly keys = new Set<string>();
  readonly tombstones: Array<{ workspaceId: string; system: string; sourceIds?: readonly string[]; scope?: string; cause: TombstoneCause }> = [];
  readonly principalChanges: Array<{ workspaceId: string; scope: string; add?: readonly string[]; remove?: readonly string[] }> = [];
  readonly audienceReplacements: Array<{ scope: string; audience: Audience }> = [];
  private readonly dead = new Set<string>();
  private readonly deadScopes = new Set<string>();
  private readonly lowest = new Map<string, TrustClass>();
  failPut = false;
  private static itemKey(workspaceId: string, source: string, system: string, id: string): string { return `${workspaceId}|${source}|${system}|${id}`; }
  private static rank(trust: TrustClass): number { return { outsider: 0, system: 1, rovara: 2, member: 3 }[trust]; }
  async put(draft: RecordDraft) {
    if (this.failPut) throw new Error("table unavailable");
    // The sink contract (ports.ts): a tombstone is sticky, versions are ordered by their own time, a new version replaces the older text,
    // and the lowest trust ever seen for the item is remembered.
    const item = FakeSink.itemKey(draft.workspaceId, draft.source, draft.sourceRef.system, draft.sourceRef.id);
    if (this.dead.has(`${draft.workspaceId}|${draft.sourceRef.system}|${draft.sourceRef.id}`)) return { status: "refused" as const, reason: "tombstoned" };
    const scope = draft.audience.kind === "restricted" ? draft.audience.acl.scope : undefined;
    if (scope !== undefined && this.deadScopes.has(scope)) return { status: "refused" as const, reason: "excluded_scope" };
    const key = idempotencyKey(draft);
    if (this.keys.has(key)) return { status: "duplicate" as const };
    const stamp = draft.sourceRef.versionAt ?? draft.occurredAt;
    const existing = this.puts.find((old) => FakeSink.itemKey(old.workspaceId, old.source, old.sourceRef.system, old.sourceRef.id) === item);
    if (existing !== undefined && (existing.sourceRef.versionAt ?? existing.occurredAt) > stamp) return { status: "duplicate" as const };
    this.keys.add(key);
    for (let i = this.puts.length - 1; i >= 0; i -= 1) {
      if (FakeSink.itemKey(this.puts[i]!.workspaceId, this.puts[i]!.source, this.puts[i]!.sourceRef.system, this.puts[i]!.sourceRef.id) === item) this.puts.splice(i, 1);
    }
    this.puts.push(draft);
    const before = this.lowest.get(item);
    if (before === undefined || FakeSink.rank(draft.trust) < FakeSink.rank(before)) this.lowest.set(item, draft.trust);
    return { status: "stored" as const };
  }
  async lowestTrust(input: { workspaceId: string; source: SourceSystem; system: string; id: string }) {
    return this.lowest.get(FakeSink.itemKey(input.workspaceId, input.source, input.system, input.id));
  }
  async tombstone(input: { workspaceId: string; system: string; sourceIds?: readonly string[]; scope?: string; cause: TombstoneCause }) {
    this.tombstones.push(input);
    for (const id of input.sourceIds ?? []) {
      this.dead.add(`${input.workspaceId}|${input.system}|${id}`);
      for (let i = this.puts.length - 1; i >= 0; i -= 1) if (this.puts[i]!.workspaceId === input.workspaceId && this.puts[i]!.sourceRef.system === input.system && this.puts[i]!.sourceRef.id === id) this.puts.splice(i, 1);
    }
    if (input.scope !== undefined && input.cause === "excluded") this.deadScopes.add(input.scope);
    return { hidden: 1 };
  }
  async changePrincipals(input: { workspaceId: string; scope: string; add?: readonly string[]; remove?: readonly string[]; at: string }) {
    this.principalChanges.push(input);
  }
  async replaceScopeAudience(input: { workspaceId: string; scope: string; audience: Audience; at: string }) {
    this.audienceReplacements.push({ scope: input.scope, audience: input.audience });
  }
  kinds(): string[] { return this.puts.map((draft) => draft.kind); }
}

export class FakePushIndex implements PushIndexPort {
  readonly pushes: PushRecord[] = [];
  async record(input: { push: PushRecord }) { this.pushes.push(input.push); }
  async byAfter(input: { repo: string; after: string }) { return this.pushes.find((push) => push.repo === input.repo && push.after === input.after); }
}

export class FakeDistiller implements TransientDistillerPort {
  readonly received: Array<RecordDraft & { text: string }> = [];
  async distillTransient(draft: RecordDraft & { text: string }) {
    this.received.push(draft);
    return { accepted: true };
  }
}

export class FakeConfig implements SourceConfigPort {
  readonly rows = new Map<string, SourceConfig>();
  throws = false;
  set(source: SourceSystem, scope: string, config: Partial<SourceConfig> = {}): void {
    this.rows.set(`${source}|${scope}`, { enabled: true, retention: "D", exclude: [], audienceDefault: "maintainers", ...config });
  }
  async get(_workspaceId: string, source: SourceSystem, scope: string) {
    if (this.throws) throw new Error("table unavailable");
    return this.rows.get(`${source}|${scope}`);
  }
}

export class FakeMode implements CaptureModePort {
  on = true;
  async captureOn() { return this.on; }
}

/** Identities: `members` map a source id to a developer; everything else is an outsider (an unmapped identity matches nothing). */
export class FakeActors implements ActorResolverPort {
  members = new Map<string, string>();
  async resolve(input: { sourceId: string; isBot?: boolean }): Promise<{ developerId?: string; trust: TrustClass }> {
    const developerId = this.members.get(input.sourceId);
    return developerId === undefined ? { trust: "outsider" } : { developerId, trust: "member" };
  }
  async resolveDeveloper(input: { developerId: string }): Promise<{ trust: TrustClass }> {
    return { trust: [...this.members.values()].includes(input.developerId) ? "member" : "outsider" };
  }
}

export class FakeRovaraPrs implements RovaraPullRequestIndexPort {
  readonly list: RovaraPullRequest[] = [];
  readonly calls: string[] = [];
  async byNumber(input: { repo: string; number: number }) { this.calls.push(`n${input.number}`); return this.list.find((pr) => pr.number === input.number); }
  async byMergeCommit(input: { repo: string; sha: string }) { this.calls.push(`m${input.sha}`); return this.list.find((pr) => pr.mergeCommitSha === input.sha); }
}

export const sha = (n: number): string => n.toString(16).padStart(40, "0");

/** A world with the source rows most tests want already present. */
export function world() {
  return { pushes: new FakePushIndex(), sink: new FakeSink(), distiller: new FakeDistiller(), config: new FakeConfig(), mode: new FakeMode(), actors: new FakeActors(), prs: new FakeRovaraPrs() };
}
