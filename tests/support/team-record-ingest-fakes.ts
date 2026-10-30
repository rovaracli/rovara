// Fakes for the Team record ingest taps (lane "ingest"). They stand in for the record core (R2 sink, source rows, mode, identity resolver) that
// another lane builds; the taps only ever see the interfaces in `team-record/sources/ports.ts`.
import {
  idempotencyKey, type ActorResolverPort, type CaptureModePort, type RecordDraft, type RecordSinkPort, type RovaraPullRequest, type RovaraPullRequestIndexPort, type SourceConfig,
  type SourceConfigPort, type SourceSystem, type TombstoneCause, type TransientDistillerPort, type TrustClass, type Audience,
} from "../../packages/broker/src/team-record/sources/ports.js";

export const WS = "ws-1";

export class FakeSink implements RecordSinkPort {
  readonly puts: RecordDraft[] = [];
  readonly keys = new Set<string>();
  readonly tombstones: Array<{ workspaceId: string; system: string; sourceIds?: readonly string[]; scope?: string; cause: TombstoneCause }> = [];
  readonly principalChanges: Array<{ workspaceId: string; scope: string; add?: readonly string[]; remove?: readonly string[] }> = [];
  readonly audienceReplacements: Array<{ scope: string; audience: Audience }> = [];
  failPut = false;
  async put(draft: RecordDraft) {
    if (this.failPut) throw new Error("table unavailable");
    const key = idempotencyKey(draft);
    if (this.keys.has(key)) return { status: "duplicate" as const };
    this.keys.add(key);
    this.puts.push(draft);
    return { status: "stored" as const };
  }
  async tombstone(input: { workspaceId: string; system: string; sourceIds?: readonly string[]; scope?: string; cause: TombstoneCause }) {
    this.tombstones.push(input);
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
  return { sink: new FakeSink(), distiller: new FakeDistiller(), config: new FakeConfig(), mode: new FakeMode(), actors: new FakeActors(), prs: new FakeRovaraPrs() };
}
