import type { CanaryPorts } from "../../canary/src/types.ts";

export interface ExecutionFacts {
  /** STANDARD or ROLLBACK, as CodePipeline reports it; null when it did not say. */
  executionType: string | null;
  /** Succeeded, Failed, ...; null when unknown. */
  status: string | null;
  /** For a ROLLBACK execution: `rollbackMetadata.rollbackTargetPipelineExecutionId`. */
  rollbackTargetId: string | null;
  /** The 40-hex commit of the `Code` source artifact revision; null when it is not exactly one. */
  sourceSha: string | null;
}

export interface DecisionLike {
  verdict: string;
  reasons: { rule: string; code: string; message: string }[];
  alerts: { rule: string; code: string; message: string }[];
  sha: string | null;
  pipeline: string | null;
}

export interface RollbackPorts extends Pick<CanaryPorts, "nowMs" | "getParameter" | "putHold" | "publish" | "writeFile"> {
  /** Every hold parameter name (full names) under `<prefix>/<kind>-hold/`. */
  listHolds(dir: string): Promise<string[]>;
  getExecution(executionId: string): Promise<ExecutionFacts>;
  /** `canary/<execution>/result.json` of the runs bucket, parsed; null when there is none. */
  readCanaryResult(executionId: string): Promise<unknown>;
  /** The target execution's release package record is still in the runs bucket (the artifacts a rollback re-runs). */
  releasePackagePresent(executionId: string): Promise<boolean>;
  /** The explicit rollback of the Release stage to a chosen execution (the rollback role only). */
  rollbackStage(targetExecutionId: string): Promise<void>;
  /** The pinned evaluator, in-process. */
  evaluate(input: unknown): DecisionLike & { alerts: DecisionLike["alerts"] };
}

export interface RollbackContext {
  kind: string;
  executionId: string;
  executionType: string;
  parameterPrefix: string;
  topics: { operator: string | null; slack: string | null };
  s3Path: string;
}
