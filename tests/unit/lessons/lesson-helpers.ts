// Shared fakes for the learning v2 lane tests (L1-L5). No AWS, no network: every port of packages/broker/src/lessons/ports.ts has an in-memory stand-in.
import type { LessonDraft } from "../../../packages/broker/src/lessons/reflect.js";
import type {
  AlertSink, ApproverDirectory, CitationVerifier, CorrectionJudge, Embedder, LearningSpend, LessonAuditEvent, LessonAuditSink, LessonVectors, PipelineModel, RulePublisher,
} from "../../../packages/broker/src/lessons/ports.js";
import type { LearningSettings, LearningSettingsReader } from "../../../packages/broker/src/lessons/policy.js";
import type { ReflectSubject, EvidenceSpan } from "../../../packages/broker/src/lessons/reflect-input.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import type { Lesson } from "../../../packages/broker/src/lessons/types.js";

export const WS = "ws-1";
export const PROJECT = "proj-1";
export const KEY = { workspaceId: WS, project: PROJECT };
export const BASE = "abcdef0123456789abcdef0123456789abcdef01";
export const MERGED = "1234567890abcdef1234567890abcdef12345678";

export class Clock { constructor(public t = 1_800_000_000_000) {} now = (): number => this.t; advance(ms: number): void { this.t += ms; } }

/** A bag-of-words embedder: the same words give the same direction, so cosine similarity tracks word overlap. */
export const embedder: Embedder & { fail: boolean } = {
  fail: false,
  async embed(text: string): Promise<number[]> {
    if (this.fail) throw new Error("embed down");
    const v = new Array<number>(256).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9_]+/gu) ?? []) {
      let h = 2166136261;
      for (const c of word) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
      v[h % 256]! += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  },
};

export class MemoryVectors implements LessonVectors {
  rows = new Map<string, { id: string; vector: readonly number[] }>();
  fail = false;
  private k(ws: string, p: string, id: string): string { return `${ws}\u0001${p}\u0001${id}`; }
  async upsert(ws: string, p: string, id: string, vector: readonly number[], _meta?: { status: string }): Promise<void> {
    void _meta; this.rows.set(this.k(ws, p, id), { id, vector }); }
  async query(ws: string, p: string, vector: readonly number[], k: number): Promise<Array<{ id: string; score: number }>> {
    if (this.fail) throw new Error("index down");
    const prefix = `${ws}\u0001${p}\u0001`;
    return [...this.rows.entries()].filter(([key]) => key.startsWith(prefix)).map(([, row]) => ({ id: row.id, score: row.vector.reduce((s, x, i) => s + x * (vector[i] ?? 0), 0) })).sort((a, b) => b.score - a.score).slice(0, k);
  }
  async remove(ws: string, p: string, id: string): Promise<void> { this.rows.delete(this.k(ws, p, id)); }
}

export class ScriptedModel implements PipelineModel {
  calls: Array<Record<string, unknown>> = [];
  constructor(public replies: Array<string | Error | { text: string; costUsd: number }> = []) {}
  async complete(request: Parameters<PipelineModel["complete"]>[0]): Promise<{ text: string; costUsd: number; model: string }> {
    this.calls.push({ ...request });
    const next = this.replies.shift();
    if (next === undefined) throw new Error("no scripted reply");
    if (next instanceof Error) throw next;
    return typeof next === "string" ? { text: next, costUsd: 0.01, model: "test-model" } : { ...next, model: "test-model" };
  }
}

export class Spend implements LearningSpend {
  charges: Array<{ usd: number; purpose: string }> = [];
  admitted = true;
  async admit(): Promise<boolean> { return this.admitted; }
  async charge(_ws: string, _p: string, usd: number, purpose: string): Promise<void> { this.charges.push({ usd, purpose }); }
  get total(): number { return this.charges.reduce((s, c) => s + c.usd, 0); }
}

export class Audit implements LessonAuditSink {
  events: LessonAuditEvent[] = [];
  async emit(event: LessonAuditEvent): Promise<void> { this.events.push(event); }
  actions(): string[] { return this.events.map((e) => e.action); }
}
export class Alerts implements AlertSink { sent: string[] = []; async alert(_w: string, _p: string, code: string): Promise<void> { this.sent.push(code); } }

export const settings = (value: LearningSettings = {}): LearningSettingsReader => ({ read: async () => value });

export function directory(over: Partial<Awaited<ReturnType<ApproverDirectory["eligibility"]>>> = {}): ApproverDirectory & { value: Awaited<ReturnType<ApproverDirectory["eligibility"]>> } {
  const value = { complete: true, membershipVersion: 1, ownerIds: ["owner"], eligibleIds: ["owner", "ann", "bob"], lastEligibleLossAtMs: null, ...over };
  return { value, eligibility: async () => value, identity: async () => ({ principals: [], groups: [] }) };
}

export const verifier = (result: "valid" | "moved" | "stale" | "unknown" = "valid"): CitationVerifier & { calls: number } => ({
  calls: 0,
  async verify() { this.calls += 1; return result === "moved" ? { result, startLine: 20, endLine: 30 } : { result }; },
});

export class Publisher implements RulePublisher {
  published: Array<{ paragraph: string; lessonId: string }> = [];
  async publish(input: { paragraph: string; lessonId: string }): Promise<{ ruleId: string }> { this.published.push(input); return { ruleId: `rule-${this.published.length}` }; }
}

export class Judge implements CorrectionJudge {
  calls = 0;
  constructor(public answer: "caused" | "contradicts" | "unrelated" | "same_ignored" | Error = "unrelated") {}
  async rate(): Promise<"caused" | "contradicts" | "unrelated" | "same_ignored"> { this.calls += 1; if (this.answer instanceof Error) throw this.answer; return this.answer; }
}

export const codeCite = (over: Record<string, unknown> = {}) => ({ kind: "code" as const, repo: "api", path: "src/retry/index.ts", startLine: 12, endLine: 30, anchor: "export function withRetry(", commit: BASE, ...over });

export function draft(over: Partial<LessonDraft> = {}): LessonDraft {
  return {
    type: "fact", title: "Retries use withRetry", description: "HTTP retries in api go through the shared helper", body: "HTTP retries in the api service use withRetry from src/retry/index.ts.",
    scope: { repos: ["api"], paths: ["src/**"] }, stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"], citations: [codeCite()],
    provenance: { sourceEvents: ["ev-1"], sourceKinds: ["human_edit"], authors: ["ann"], supportTasks: ["task-1"], sources: ["member:ann"], inputSources: ["member:ann"], measured: false, minTrust: "member", audience: { kind: "project" }, reflectorRun: "run-1", model: "m", memberSignal: true },
    ...over,
  };
}

export function subject(spans: EvidenceSpan[], over: Partial<ReflectSubject> = {}): ReflectSubject {
  return {
    kind: "task", id: "task-1", workspaceId: WS, project: PROJECT, repositories: ["api"], baseCommit: BASE, mergedCommit: MERGED, outcome: "merged",
    initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", links: ["https://github.com/acme/api/pull/7"], spans, ...over,
  };
}

export const memberSpan = (text: string, over: Partial<EvidenceSpan> = {}): EvidenceSpan => ({ kind: "human_edit", text, trust: "member", eventId: "ev-1", authorId: "ann", ...over });

export const candidateJson = (over: Record<string, unknown> = {}) => ({
  type: "convention", title: "Use withRetry", description: "Shared retry helper", body: "HTTP retries in api use withRetry from src/retry/index.ts.",
  scope: { repos: ["api"], paths: ["src/**"] }, stages: ["IMPLEMENT"], citations: [codeCite()], evidenceSpanIds: ["S1"], ...over,
});
export const reply = (...candidates: unknown[]): string => JSON.stringify({ candidates });

export function newStore(): InMemoryLessonStore { return new InMemoryLessonStore(); }

export type LessonOver = Partial<Lesson>;
export function lessonRecord(over: LessonOver = {}): Lesson {
  const d = draft();
  return {
    id: "les_aaaa1111", version: 1, workspaceId: WS, project: PROJECT, scope: d.scope, type: d.type, stages: d.stages, title: d.title, description: d.description, body: d.body,
    citations: d.citations, citationChecks: [{ index: 0, result: "valid", at: 1 }], provenance: d.provenance, tier: 0, tierReasons: ["cited_fact"], status: "active",
    counters: { loaded: 0, helpful: 0, harmful: 0, citationStale: 0 }, staleAt: [], expiresAt: 1_800_000_000_000 + 90 * 86_400_000, approvals: [{ approvalId: "a", by: "system:auto", at: 1, mode: "auto" }],
    createdAt: 1, updatedAt: 1, ...over,
  };
}
export async function seed(store: InMemoryLessonStore, ...lessons: Lesson[]): Promise<void> {
  for (const lesson of lessons) await store.commit({ workspaceId: lesson.workspaceId, project: lesson.project }, await store.setVersion({ workspaceId: lesson.workspaceId, project: lesson.project }), [lesson], 1);
}
