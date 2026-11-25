// The last-good record (L2-STAGE-CLI-INTERFACE.md 6): one SSM String parameter per environment, written after the proof gates passed.
import { lastGoodParameter } from "../config.ts";
import type { PipelineConfig } from "../config.ts";
import { StageError } from "../types.ts";
import type { LastGoodRecord, Manifest, PipelineEnv, Ports } from "../types.ts";

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** Tolerant: extra keys ignored, `previous` and `code.sha` optional. Wrong JSON or schema is an error, never "no record". */
export function parseLastGood(raw: string): LastGoodRecord {
  let file: unknown;
  try { file = JSON.parse(raw); } catch { throw new StageError("REFUSED", "the last-good record is not JSON"); }
  if (!isObject(file) || file.schema !== 1) throw new StageError("REFUSED", "the last-good record has no schema 1");
  const env = file.env === "beta" || file.env === "production" ? file.env : null;
  const mode = file.mode === "release" || file.mode === "rollback" || file.mode === "adoption" ? file.mode : null;
  const cloud = isObject(file.cloud) ? file.cloud : {};
  const gateway = isObject(file.gateway) ? file.gateway : {};
  const code = isObject(file.code) ? file.code : {};
  const previous = isObject(file.previous) && text(file.previous.cloudTag) !== null && text(file.previous.cloudSha) !== null
    ? { cloudTag: text(file.previous.cloudTag)!, cloudSha: text(file.previous.cloudSha)!, gatewayDigest: text(file.previous.gatewayDigest) }
    : null;
  const tag = text(cloud.tag), sha = text(cloud.sha), digest = text(gateway.digest), executionId = text(file.executionId), recordedAt = text(file.recordedAt);
  if (env === null || mode === null || tag === null || sha === null || digest === null || executionId === null || recordedAt === null) throw new StageError("REFUSED", "the last-good record is missing required values");
  return {
    schema: 1, env, recordedAt, executionId, mode,
    cloud: { tag, sha },
    gateway: { digest },
    code: { sha: text(code.sha) },
    proofGates: Array.isArray(file.proofGates) ? file.proofGates.filter((name): name is string => typeof name === "string") : [],
    ...(Array.isArray(file.proofSkipped) ? { proofSkipped: file.proofSkipped.filter((name): name is string => typeof name === "string") } : {}),
    previous,
  };
}

export async function readLastGood(ports: Ports, config: PipelineConfig, env: PipelineEnv): Promise<LastGoodRecord | null> {
  const raw = await ports.ssm.get(lastGoodParameter(config, env));
  return raw === null ? null : parseLastGood(raw);
}

export function buildLastGood(manifest: Manifest, env: PipelineEnv, proofGates: string[], previous: LastGoodRecord | null, now: Date, proofSkipped: string[] = []): LastGoodRecord {
  if (manifest.gateway.digest === null) throw new StageError("REFUSED", "no gateway digest in the manifest: nothing to record as last-good");
  return {
    schema: 1,
    env,
    recordedAt: now.toISOString(),
    executionId: manifest.executionId,
    mode: manifest.mode,
    cloud: { tag: manifest.cloud.tag, sha: manifest.cloud.sha },
    gateway: { digest: manifest.gateway.digest },
    code: { sha: manifest.code.release === "skip" ? manifest.code.pinnedSha[env] : manifest.code.sha },
    proofGates,
    ...(proofSkipped.length === 0 ? {} : { proofSkipped }),
    previous: previous === null ? null : { cloudTag: previous.cloud.tag, cloudSha: previous.cloud.sha, gatewayDigest: previous.gateway.digest },
  };
}

export async function writeLastGood(ports: Ports, config: PipelineConfig, record: LastGoodRecord): Promise<void> {
  const body = JSON.stringify(record);
  // SSM standard parameters hold 4 KB: the record is small by construction, and a bigger one is a bug, not a truncation.
  if (Buffer.byteLength(body) > 4000) throw new StageError("FAILED", "the last-good record is too large for an SSM standard parameter");
  await ports.ssm.put(lastGoodParameter(config, record.env), body);
}

export function renderLastGood(record: LastGoodRecord | null): string {
  if (record === null) return "none\n";
  return `${JSON.stringify(record, null, 2)}\n`;
}
