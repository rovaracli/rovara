// What every step gets: the environment, its settings row, the config, the inputs (flags and env), the ports and a logger.
import type { PipelineConfig } from "../config.ts";
import type { SwitchesRow } from "../switches.ts";
import type { Gate, Manifest, PipelineEnv, Ports, StackPart, StepName } from "../types.ts";

export interface Inputs {
  execId: string;
  cloudRef: string | null;
  codeRelease: "run" | "skip";
  cloudProd: boolean;
  codeSha: string | null;
  /** The Code commit this stage runs now: CODE_CTX live in a pipeline run (CODE_LIVE_SHA only in a hand-started one). Read by the Preflight only; later steps read the manifest. */
  codeLiveSha: string | null;
  codeLiveFacts: Record<string, string>;
  supersedes: { executionId: string; codeSha: string | null } | null;
  /** L9b: the Code commit a Code rollback moves to (CODE_CTX target; CODE_ROLLBACK_TARGET / --code-target in a hand-started run or the rollback plan), or null. */
  codeTarget: string | null;
  /** L9b: PIPELINE_MODE=rollback: a declared rollback, even when CLOUD_REF is not older than what is live. */
  declaredRollback: boolean;
  /** L9b: the Code facts above came from CODE_CTX (a pipeline run); false = hand-started (CODE_LIVE_SHA and friends), which a pipeline execution id may not be. */
  codeCtxGiven: boolean;
  adopt: boolean;
  gatewayDigest: string | null;
  /** rollback-plan only (--target): which recorded release to plan the rollback to. */
  target: string | null;
  dryRun: boolean;
  region: string | null;
  /** The account this stage must run in (ROVARA_EXPECTED_DEPLOY_ACCOUNT): from a pipeline variable or an SSM value, never from git. */
  expectedAccount: string | null;
  manifestPath: string | null;
  outDir: string;
  workDir: string;
}

export interface StepContext {
  env: PipelineEnv;
  step: StepName;
  config: PipelineConfig;
  row: SwitchesRow;
  /** The cdk contexts of the gateway and web stacks and the CodeUrl, from switches.json (L0). Injected so tests need no file. */
  contextFor(target: "gateway" | "web"): Record<string, string>;
  codeUrl: string;
  /** The account STS reported for this run (set by the runner after the check); null before. */
  account: string | null;
  inputs: Inputs;
  ports: Ports;
  gates: readonly Gate[];
  /** The gate names each phase must have. */
  requiredGates: Record<string, string[]>;
  pipelineDir: string;
  /** Runs the commands of the common build (and the web build when `web`) in the candidate tree. */
  log: (line: string) => void;
}

export const PARTS_OF_WEB_APP: readonly StackPart[] = ["app", "web"];

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function exec8Of(execId: string): string {
  return execId.slice(0, 8);
}

export type { Manifest };
