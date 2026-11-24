import type { Kind, Outcome } from "./config.ts";

export interface LedgerEntry {
  key: string;
  lastModifiedMs: number;
}

/** Everything the canary touches goes through these ports, so the tests drive every outcome with fakes and the real adapters (aws.ts) stay thin. Every port throws on any error. */
export interface CanaryPorts {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  /** Ledger objects whose key sorts after `startAfterKey` (all of them when null), with S3's last-modified time. */
  listLedger(startAfterKey: string | null): Promise<LedgerEntry[]>;
  putLedger(key: string, body: string): Promise<void>;
  /** null: the parameter does not exist. */
  getParameter(name: string): Promise<string | null>;
  /** A pointer write (overwrite). Only last-good and last-good-execution, only after a PASS. */
  putPointer(name: string, value: string): Promise<void>;
  /** A HOLD write: never overwrites, an existing hold is fine. Only the human approver may delete one. */
  putHold(name: string, value: string): Promise<void>;
  /** The canary lane's Lambdas (DEC 409): `start` also serves the ops install-open / install-close / lock-state. */
  invokeLane(fn: "start" | "status", payload: Record<string, unknown>): Promise<unknown>;
  /** Sum of Lambda Errors in the window, or null when it cannot be read. */
  lambdaErrors(fromMs: number, toMs: number): Promise<number | null>;
  publish(topicArn: string, subject: string, message: string): Promise<void>;
  /** A file of the stage's out/ directory (result.json, summary.txt). */
  writeFile(name: string, text: string): void;
}

export interface Topics {
  /** The environment's OperatorAlerts topic (email). Required. */
  operator: string | null;
  /** The release-alerts topic that AWS Chatbot posts to Slack once the owner has done the one-time setup. */
  slack: string | null;
}

export interface CanaryInput {
  kind: string;
  executionId: string;
  /** `STANDARD` or `ROLLBACK`, as CodePipeline reports it. */
  executionType: string;
  sha: string;
  /** For example `/rovara-release/staging`. */
  parameterPrefix: string;
  topics: Topics;
  /** Where the stage uploads out/ to, for the alert text. */
  s3Path: string;
}

export interface ValidInput extends CanaryInput {
  kind: Kind;
}

export interface LaneReportFacts {
  result: string;
  outcome: string | null;
  firstFailure: string | null;
  costUsd: number | null;
}

export interface CanaryResult {
  outcome: Outcome;
  /** 0: PASS, SKIPPED-CAP, INCONCLUSIVE (the HOLD is the effect). 1: FAIL (the stage fails, the rollback guards decide). 4: a required HOLD could not be written. */
  exitCode: number;
  reason: string;
  cap: { limit: number; n: number | null };
  report: LaneReportFacts | null;
  holds: string[];
  lastGoodMoved: boolean;
  alertDelivery: { operator: string; slack: string }[];
}
