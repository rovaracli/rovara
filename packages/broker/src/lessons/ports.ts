// Learning v2: the seams of the learning lane. The record core (R-lanes), storage and ingest are built in parallel; each interface here is what this
// lane needs from them, with an in-memory stand-in in the tests. Nothing here talks to AWS.
import type { LessonStage } from "@agentx/contracts";
import type { Lesson, LessonAuditAction, IdentitySet } from "./types.js";

export type Clock = () => number;

/**
 * A model call for the learning pipeline (reflector, curator judge, outcome judge). It takes text and returns text: there is no field for tools, so a
 * pipeline model cannot act (control C4). The caller validates the text against a schema and drops it on any failure.
 */
export interface PipelineModel {
  complete(request: { purpose: "reflect" | "judge" | "distill" | "outcome"; system: string; user: string; maxOutputTokens: number; workspaceId: string }): Promise<{ text: string; costUsd: number; model: string }>;
}

export interface Embedder { embed(text: string): Promise<number[]> }

/** Per-workspace, per-project lesson vectors (S3 Vectors behind the R3 `VectorIndex`). Every call carries the workspace; a hit from another workspace is impossible. */
export interface LessonVectors {
  upsert(workspaceId: string, project: string, id: string, vector: readonly number[], meta: { status: string }): Promise<void>;
  query(workspaceId: string, project: string, vector: readonly number[], k: number): Promise<Array<{ id: string; score: number }>>;
  remove(workspaceId: string, project: string, id: string): Promise<void>;
}

/**
 * Spend for learning. `admit` asks the customer's own limits (org and member budgets) whether a call of about `estimateUsd` may start; `charge` records
 * what was spent, on the org's ledger under the learning line. Enterprise has no learning caps of its own, only these limits (decision Q8).
 */
export interface LearningSpend {
  admit(workspaceId: string, estimateUsd: number): Promise<boolean>;
  charge(workspaceId: string, project: string, usd: number, purpose: string): Promise<void>;
}

export interface LessonAuditEvent {
  action: LessonAuditAction; workspaceId: string; project: string; lessonId?: string; actor?: string;
  /** Ids, counts and fixed codes only; never lesson text or anything a person wrote. */
  facts: Record<string, string | number | boolean>;
}
export interface LessonAuditSink { emit(event: LessonAuditEvent): Promise<void> }
export interface AlertSink { alert(workspaceId: string, project: string, code: "source_spike_paused" | "lesson_contradiction" | "retire_proposed"): Promise<void> }
export interface Metrics { count(name: string, tags?: Record<string, string>): void }

/** The broker's check of a code citation against a base commit's objects (never a working tree). `unknown`: it could not tell, so the lesson is not trusted as verified. */
export interface CitationVerifier {
  verify(input: { workspaceId: string; repo: string; commit: string; path: string; startLine: number; endLine: number; anchor: string }): Promise<{ result: "valid" | "moved" | "stale" | "unknown"; startLine?: number; endLine?: number }>;
}

/** Who may approve lessons for a project (project maintainers, How-we-work editors, company admins). `complete: false` means the answer is not trustworthy. */
export interface ApproverDirectory {
  eligibility(workspaceId: string, project: string): Promise<{
    complete: boolean; membershipVersion: number; ownerIds: string[]; eligibleIds: string[]; lastEligibleLossAtMs: number | null;
    /** Named groups (Enterprise): group id to member ids. */
    groups?: Record<string, string[]>;
  }>;
  identity(workspaceId: string, developerId: string): Promise<IdentitySet>;
}

/** Publishes one paragraph as a How we work rule (the v1.2 accept path, `learning/decide.ts acceptSuggestion` through `publishDraft`). It inherits that path's own less-safe checks. */
export interface RulePublisher {
  publish(input: { workspaceId: string; project: string; paragraph: string; lessonId: string; approverId: string }): Promise<{ ruleId: string }>;
}

export type CorrectionKind = "send_back" | "review_comment" | "human_edit" | "revert";
export type CorrectionRating = "caused" | "contradicts" | "unrelated" | "same_ignored";
/** Rates one correction against one lesson that was loaded for the task (no tools; the answer is a fixed code). */
export interface CorrectionJudge {
  rate(input: { lesson: Pick<Lesson, "id" | "title" | "description" | "body" | "type">; correctionKind: CorrectionKind; correctionText: string }): Promise<CorrectionRating>;
}

export interface LessonDeps {
  now: Clock;
  audit: LessonAuditSink;
  metrics?: Metrics;
  newId?: () => string;
}

export type { LessonStage };
