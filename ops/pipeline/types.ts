// The types of the stage CLI (L2-STAGE-CLI-INTERFACE.md, sections 2-6). Erasable TypeScript only: Node runs these files directly.
// Other lanes (gates, the image step, the rollback lane) import these types; keep them equal to the interface file.

import type { PipelineConfig } from "./config.ts";

export type PipelineEnv = "beta" | "production";
export type StepName = "preflight" | "image" | "gateway" | "gateway-check" | "web-app" | "proof";
export type PipelineMode = "release" | "rollback" | "adoption";
export type GatePhase = "preflight" | "change-sets" | "gateway-live" | "proof";
export type StackPart = "gateway" | "web" | "app";

export interface ChangeRow {
  action: string;
  logicalId: string;
  physicalId: string | null;
  resourceType: string;
  replacement: "True" | "False" | "Conditional" | null;
  /** Names only, never values: what describe-change-set says changed on a Modify, as `Properties:<Name>` or the attribute (`Tags`, `DeletionPolicy`). Absent when the answer carried no details. */
  changedProperties?: string[];
}

export interface ChangeCounts { add: number; modify: number; remove: number; replace: number }

export interface ChangeSetRecord {
  part: StackPart;
  stack: string;
  changeSetName: string;
  changeSetId: string | null;
  noChanges: boolean;
  status: string | null;
  executionStatus: string | null;
  templateSha256: string | null;
  rows: ChangeRow[];
  counts: ChangeCounts;
  previewedAt: string;
  executedAt: string | null;
  finalStatus: string | null;
}

export interface GateRecord {
  schema: 1;
  name: string;
  phase: GatePhase;
  /** Phase "change-sets": the parts the gate saw ("app+web" or "gateway"); else null. A retried step replaces its own scope only. */
  scope: string | null;
  env: PipelineEnv;
  executionId: string;
  cloudSha: string;
  startedAt: string;
  writtenAt: string;
  result: "pass" | "fail" | "skipped";
  skippedReason: string | null;
  failures: string[];
  notes: string[];
  data: Record<string, unknown>;
}

export interface RollbackRecord {
  schema: 1;
  env: PipelineEnv;
  capturedAt: string;
  executionId: string;
  cloud: { tag: string | null; sha: string | null };
  gateway: { digest: string | null };
  stacks: Record<string, { status: string; templateSha256: string | null }>;
  code: { liveSha: string | null; facts: Record<string, string> };
}

export interface PromotionSummary {
  schema: 1;
  env: PipelineEnv;
  executionId: string;
  mode: PipelineMode;
  code: {
    sha: string | null; release: "run" | "skip"; pinnedSha: string | null; supersedes: { executionId: string; codeSha: string | null } | null;
    /** L9b: the Code commit this stage runs now (CODE_CTX live) and the commit a Code rollback moves to; absent in a summary from before L9b. */
    liveSha?: string | null; rollbackTarget?: string | null;
  };
  cloud: { tag: string; sha: string; liveSha: string | null };
  gateway: { digest: string | null; source: string | null };
  changeSets: Array<{ part: string; stack: string; noChanges: boolean; counts: ChangeCounts }>;
  gates: Array<{ name: string; phase: string; result: "pass" | "fail" | "skipped"; skippedReason: string | null }>;
  warnings: string[];
}

export interface StageRecord {
  env: PipelineEnv;
  startedAt: string;
  skipped: string | null;
  /** true: a dry run (nothing was written); false: a real run; null: not recorded (a record from before this field), which never counts as proven. */
  dryRun: boolean | null;
  account: string | null;
  completed: StepName[];
  gates: GateRecord[];
  changeSets: ChangeSetRecord[];
  rollback: RollbackRecord | null;
  releaseCheck: { base: string | null; probes: number; failures: string[] } | null;
  summary: PromotionSummary | null;
  warnings: string[];
}

export interface Manifest {
  schema: 1;
  executionId: string;
  exec8: string;
  createdAt: string;
  mode: PipelineMode;
  cloud: {
    tag: string;
    sha: string;
    ref: "latest-tag" | "CLOUD_REF" | "from-trigger" | "last-good";
    trunk: string;
    liveSha: Record<PipelineEnv, string | null>;
  };
  code: {
    sha: string | null;
    release: "run" | "skip";
    requestedRelease: "run" | "skip";
    /** Rollback only: the Code sha each environment is pinned to: the rollback target when a Code target is given, else what is live there (CODE_CTX live of that environment's preflight). */
    pinnedSha: Record<PipelineEnv, string | null>;
    supersedes: { executionId: string; codeSha: string | null } | null;
    /** L9b (read tolerantly: absent in a manifest from before L9b = null): the Code commit each environment ran before this run (CODE_CTX live; the commit Code moves FROM). */
    liveSha?: Record<PipelineEnv, string | null>;
    /** L9b: the Code commit a Code rollback moves to (CODE_CTX target, the same for both stages), or null (no Code rollback). With a target Code releases (release = run) and the pin is the target. */
    rollbackTarget?: string | null;
  };
  gateway: {
    digest: string | null;
    source: "built" | "copied" | "adopted" | "supplied" | null;
    imageTag: string | null;
    repository: string | null;
  };
  stages: Partial<Record<PipelineEnv, StageRecord>>;
}

export interface LastGoodRecord {
  schema: 1;
  env: PipelineEnv;
  recordedAt: string;
  executionId: string;
  mode: PipelineMode;
  cloud: { tag: string; sha: string };
  gateway: { digest: string };
  code: { sha: string | null };
  proofGates: string[];
  /** L9, a sibling attribute (rule 8: older readers ignore it): proof gates that were skipped when this record was written; absent = none. */
  proofSkipped?: string[];
  previous: { cloudTag: string; cloudSha: string; gatewayDigest: string | null } | null;
}

// ---- gates ----

export interface GateInput {
  env: PipelineEnv;
  phase: GatePhase;
  region: string;
  /** The layout (config.json): stack names, prefixes. Plain data. */
  config: PipelineConfig;
  manifest: Readonly<Manifest>;
  changeSets: readonly ChangeSetRecord[];
  dirs: { pipeline: string; cloud: string | null; out: string; work: string };
  ports: Ports;
  log: (line: string) => void;
  /** A dry run (--dry-run): a gate must not start or change anything, and says what a real run would do. Absent = a real run. */
  dryRun?: boolean;
}

export interface GateOutcome {
  result: "pass" | "fail" | "skipped";
  skippedReason?: string;
  failures?: string[];
  notes?: string[];
  /** Small JSON facts. One key has meaning to the runner: a `proof` gate that skips with `holdsLastGood: true` gave no proof either way, so the proof step does not move last-good (L9). */
  data?: Record<string, unknown>;
}

export interface Gate {
  name: string;
  phases: readonly GatePhase[];
  envs?: readonly PipelineEnv[];
  run(input: GateInput): Promise<GateOutcome>;
}

// ---- ports ----

export interface ExecResult { code: number; stdout: string; stderr: string }
export interface ExecOptions { cwd?: string; env?: Record<string, string | undefined>; input?: string }
export interface ChangeSetDescription { id: string; status: string; executionStatus: string; statusReason: string | null; rows: ChangeRow[] }
/** `changeSetId` is the id of the change set the stack last ran (describe-stacks ChangeSetId); `lastUpdatedTime` is its LastUpdatedTime (ISO; null for a stack never updated). */
export interface StackDescription { status: string; parameters: Record<string, string>; outputs: Record<string, string>; changeSetId: string | null; lastUpdatedTime: string | null }

/** One cdk call: it names every stack it may touch (the cdk stack id selects it, the stack name is what `--parameters` matches) and each stack's own parameters, so a parameter can never be left unprefixed. */
export interface CdkStackSelection { stackId: string; stackName: string; parameters: Record<string, string> }
export interface Ports {
  exec(cmd: string, args: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
  aws: { json(args: readonly string[], opts?: { profile?: string | null; env?: Record<string, string> }): Promise<unknown> };
  git: {
    fetchTags(): Promise<void>;
    fetchBranch(branch: string): Promise<boolean>;
    tags(): Promise<string[]>;
    revParse(ref: string): Promise<string>;
    isAncestor(ancestor: string, descendant: string): Promise<boolean>;
    worktree(sha: string, dir: string): Promise<void>;
  };
  cfn: {
    describeStack(stack: string): Promise<StackDescription | null>;
    describeChangeSet(stack: string, name: string): Promise<ChangeSetDescription | null>;
    templateSha256(stack: string, changeSetName: string): Promise<string>;
    liveTemplateSha256(stack: string): Promise<string | null>;
    executeChangeSet(stack: string, name: string): Promise<void>;
    deleteChangeSet(stack: string, name: string): Promise<void>;
    listChangeSetNames(stack: string): Promise<string[]>;
    waitSettled(stack: string, timeoutSeconds: number): Promise<string>;
  };
  cdk: { deployNoExecute(a: { dir: string; stacks: readonly CdkStackSelection[]; changeSetName: string; context: Record<string, string> }): Promise<void> };
  ssm: { get(name: string): Promise<string | null>; put(name: string, value: string): Promise<void> };
  /** `body` is the response text (at most 64 KiB), for a gate that reads a JSON answer (the gateway's /healthz); absent when the call failed (status 0). */
  http: { get(url: string, timeoutMs: number): Promise<{ status: number; body?: string }> };
  sts: { account(): Promise<string> };
  fs: { readText(p: string): string; writeText(p: string, text: string): void; exists(p: string): boolean; mkdirp(p: string): void; readdir(p: string): string[] };
  clock: { now(): Date; sleep(ms: number): Promise<void> };
}

// ---- image step (L6) ----

export interface ImageStepInput {
  env: PipelineEnv;
  manifest: Readonly<Manifest>;
  supplied: { digest: string } | null;
  dirs: { pipeline: string; cloud: string; out: string; work: string };
  ports: Ports;
  log: (line: string) => void;
}
export interface ImageStepResult { digest: string; source: "built" | "copied" | "supplied"; imageTag: string; repository: string }

// ---- exit codes ----

export const EXIT = {
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  REFUSED: 3,
  GATE_FAILED: 20,
  GATE_MISSING: 21,
  CHANGE_SET_MISMATCH: 30,
  DEPLOY_FAILED: 31,
  RELEASE_CHECK_FAILED: 32,
  REF_FAILED: 40,
  ROLLBACK_REFUSED: 41,
  ADOPTION_REQUIRED: 42,
  NOT_INSTALLED: 70,
} as const;
export type ExitName = keyof typeof EXIT;

/** A failure with an exit code. The CLI prints `STAGE-FAILED <env> <step> <name>: <message>` and exits with the code. */
export class StageError extends Error {
  readonly exitName: ExitName;
  constructor(exitName: ExitName, message: string) {
    super(message);
    this.exitName = exitName;
  }
}
