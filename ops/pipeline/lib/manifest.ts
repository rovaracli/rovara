// The whole-run manifest: created by the Beta preflight, read and rewritten by every later action (L2-STAGE-CLI-INTERFACE.md 2.4).
// Read tolerantly (rule 8): extra keys are ignored, a missing optional value is null; only a wrong schema or a missing required value refuses.
import { StageError } from "../types.ts";
import type { Manifest, PipelineEnv, StageRecord, StepName } from "../types.ts";

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const need = (value: unknown, what: string): string => {
  const found = text(value);
  if (found === null) throw new StageError("REFUSED", `the manifest is missing ${what}`);
  return found;
};

export function newStageRecord(env: PipelineEnv, now: Date, dryRun: boolean): StageRecord {
  return { env, startedAt: now.toISOString(), skipped: null, dryRun, account: null, completed: [], gates: [], changeSets: [], rollback: null, releaseCheck: null, summary: null, warnings: [] };
}

export function parseManifest(raw: string): Manifest {
  let file: unknown;
  try { file = JSON.parse(raw); } catch { throw new StageError("REFUSED", "the manifest is not JSON"); }
  if (!isObject(file) || file.schema !== 1) throw new StageError("REFUSED", "the manifest has no schema 1");
  const cloud = isObject(file.cloud) ? file.cloud : {};
  const code = isObject(file.code) ? file.code : {};
  const gateway = isObject(file.gateway) ? file.gateway : {};
  const live = isObject(cloud.liveSha) ? cloud.liveSha : {};
  const pinned = isObject(code.pinnedSha) ? code.pinnedSha : {};
  const mode = file.mode;
  if (mode !== "release" && mode !== "rollback" && mode !== "adoption") throw new StageError("REFUSED", "the manifest has no mode");
  const stages: Manifest["stages"] = {};
  const rawStages = isObject(file.stages) ? file.stages : {};
  for (const env of ["beta", "production"] as const) {
    const stage = rawStages[env];
    if (stage === undefined) continue;
    if (!isObject(stage)) throw new StageError("REFUSED", `the manifest's ${env} stage is not an object`);
    stages[env] = {
      env,
      startedAt: need(stage.startedAt, `${env}.startedAt`),
      skipped: text(stage.skipped),
      dryRun: typeof stage.dryRun === "boolean" ? stage.dryRun : null,
      account: text(stage.account),
      completed: Array.isArray(stage.completed) ? (stage.completed.filter((step) => typeof step === "string") as StepName[]) : [],
      gates: Array.isArray(stage.gates) ? (stage.gates as StageRecord["gates"]) : [],
      changeSets: Array.isArray(stage.changeSets) ? (stage.changeSets as StageRecord["changeSets"]) : [],
      rollback: isObject(stage.rollback) ? (stage.rollback as unknown as StageRecord["rollback"]) : null,
      releaseCheck: isObject(stage.releaseCheck) ? (stage.releaseCheck as unknown as StageRecord["releaseCheck"]) : null,
      summary: isObject(stage.summary) ? (stage.summary as unknown as StageRecord["summary"]) : null,
      warnings: Array.isArray(stage.warnings) ? stage.warnings.filter((w) => typeof w === "string") : [],
    };
  }
  const supersedes = isObject(code.supersedes) && text(code.supersedes.executionId) !== null
    ? { executionId: text(code.supersedes.executionId)!, codeSha: text(code.supersedes.codeSha) }
    : null;
  const codeLive = isObject(code.liveSha) ? code.liveSha : {};
  const source = gateway.source;
  return {
    schema: 1,
    executionId: need(file.executionId, "executionId"),
    exec8: need(file.exec8, "exec8"),
    createdAt: need(file.createdAt, "createdAt"),
    mode,
    cloud: {
      tag: need(cloud.tag, "cloud.tag"),
      sha: need(cloud.sha, "cloud.sha"),
      ref: cloud.ref === "CLOUD_REF" || cloud.ref === "from-trigger" || cloud.ref === "last-good" ? cloud.ref : "latest-tag",
      trunk: need(cloud.trunk, "cloud.trunk"),
      liveSha: { beta: text(live.beta), production: text(live.production) },
    },
    code: {
      sha: text(code.sha),
      release: code.release === "skip" ? "skip" : "run",
      requestedRelease: code.requestedRelease === "skip" ? "skip" : "run",
      pinnedSha: { beta: text(pinned.beta), production: text(pinned.production) },
      supersedes,
      liveSha: { beta: text(codeLive.beta), production: text(codeLive.production) },
      rollbackTarget: text(code.rollbackTarget),
    },
    gateway: {
      digest: text(gateway.digest),
      source: source === "built" || source === "copied" || source === "adopted" || source === "supplied" ? source : null,
      imageTag: text(gateway.imageTag),
      repository: text(gateway.repository),
    },
    stages,
  };
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function stageOf(manifest: Manifest, env: PipelineEnv): StageRecord {
  const stage = manifest.stages[env];
  if (stage === undefined) throw new StageError("REFUSED", `the manifest has no ${env} stage: run ${env} preflight first`);
  return stage;
}

/** A step may run only after its predecessor completed in this execution (preflight has none). */
const PREDECESSOR: Record<StepName, StepName | null> = {
  preflight: null,
  image: "preflight",
  gateway: "image",
  "gateway-check": "gateway",
  "web-app": "gateway-check",
  proof: "web-app",
};

export function requirePredecessor(stage: StageRecord, step: StepName): void {
  const before = PREDECESSOR[step];
  if (before !== null && !stage.completed.includes(before)) throw new StageError("REFUSED", `${step} comes after ${before}, which has not completed in this execution`);
}

export function markCompleted(stage: StageRecord, step: StepName): void {
  if (!stage.completed.includes(step)) stage.completed.push(step);
}

/** The Code commit a Code rollback moves to (L9b), or null when this run has none. */
export const codeTargetOf = (manifest: Readonly<Manifest>): string | null => manifest.code.rollbackTarget ?? null;

/** The Code commit that will be live in an environment once this run is done: the rollback target's pin, the pin of a skipped Code, or the commit this run releases. */
export function codeShaAfterRun(manifest: Readonly<Manifest>, env: PipelineEnv): string | null {
  const target = codeTargetOf(manifest);
  if (manifest.mode === "rollback" && target !== null) return manifest.code.pinnedSha[env] ?? target;
  return manifest.code.release === "skip" ? manifest.code.pinnedSha[env] : manifest.code.sha;
}
