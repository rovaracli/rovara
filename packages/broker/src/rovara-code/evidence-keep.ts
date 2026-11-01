// Proof and evidence (wire-proof): where the broker assembles the evidence pack for a task and keeps it, and where it reads it back. Assembly runs ONCE per verification (CHECKS) run, when its result is accepted
// (aws/broker/workflow-items.ts, after the verification is recorded), and only while the proof switch is on:
//   1. read the worker's `evidence-raw.json` of that operation (an object under the operation's own key prefix, bounded);
//   2. the data guard drops every check part that holds personal data, a credential or production data (evidence-guard.ts), BEFORE the builder sees it;
//   3. `buildEvidencePack` binds it to the candidate digest and checks every count against the broker's own check report;
//   4. the data guard looks at the built pack and its output tails again, because the builder adds labels and paths of its own;
//   5. the output tails are stored (content addressed, tagged for retention, under the task), then the pack is stored at a key that names the task and the candidate digest.
// Informational: a fault anywhere only means there is no pack for this code, and the pull request and the page say what they always said. Nothing here can change a verdict, block a publication or hold a callback
// past its bound. Video, trace, screenshots and API samples are not gathered by this path (their capture lane is separate): the builder is given no media gate, so none is ever kept.
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  EVIDENCE_NOT_TESTED_MAX, EVIDENCE_RAW_ARTIFACT, EVIDENCE_RAW_MAX_BYTES, EvidencePackSchema, EvidenceRawSchema, evidenceIsFor,
  type CheckEntry, type CheckKind, type EvidenceEnvironment, type EvidenceNotTested, type EvidencePack, type EvidenceRaw, type TestEnvProdDeny,
} from "@agentx/contracts";
import type { TestProofActions } from "../developer/test-proof-lines.js";
import { storeEvidenceArtifacts, type EvidenceArtifactStore } from "../aws/evidence-artifacts.js";
import { buildEvidencePack, type EvidenceProblem } from "./evidence-pack.js";
import { NO_PROD_DENY, guardPack, guardRaw } from "./evidence-guard.js";
import { kindOfRawCheck } from "./evidence-risk.js";

export interface EvidenceTask { ownerKey: string; workspaceId: string; taskId: string }

/** The pack is kept at a key that names its task and the exact code it is for; a reader asks for the current candidate's digest only. */
export const evidencePackKey = (task: EvidenceTask, candidateDigest: string): string => `private/${task.ownerKey}/${task.workspaceId}/evidence-pack/${task.taskId}/${candidateDigest}.json`;
const DIGEST = /^[a-f0-9]{64}$/u;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const PACK_READ_BYTES = 4 * 1_048_576;

/** What the sandbox without an approved test environment is: the project's own checks in the task's sandbox. Test environments are a later lane; this says so in the pack instead of claiming a setup. */
export const DEFAULT_EVIDENCE_ENVIRONMENT: EvidenceEnvironment = { tier: "sandbox", envRevision: 0, services: [], data: "synthetic", accounts: [] };
const NO_ENVIRONMENT_ITEM: EvidenceNotTested = { kind: "environment", id: "test_environment", text: "No approved test environment: the project's own test setup was used", reason: "not set up" };
const WITHHELD_ITEM: EvidenceNotTested = { kind: "environment", id: "data_guard", text: "Some test details were left out", reason: "personal or production data found" };

export interface KeepEvidenceInput {
  task: EvidenceTask;
  operationId: string;
  candidateDigest: string;
  /** The broker's own check entries for this code (the truth for labels and outcomes). */
  checks: readonly CheckEntry[];
  /** Each check's kind from the approved policy, by `readiness:<index>`. */
  policyKinds?: ReadonlyMap<string, CheckKind> | undefined;
  environment?: EvidenceEnvironment | undefined;
  deny?: TestEnvProdDeny | undefined;
}

export interface KeepEvidenceDeps {
  actions: Pick<TestProofActions, "artifacts" | "readArtifact">;
  store: EvidenceArtifactStore;
  /** An abandoned call (its time has run out) writes nothing more. */
  late?: (() => boolean) | undefined;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

export type KeepEvidenceResult =
  | { kept: true; problems: EvidenceProblem[]; guardedParts: number }
  | { kept: false; reason: "no_raw" | "not_bound" | "withheld" | "invalid" | "fault" };

/** The raw file's text for this operation, or undefined (none, not under the operation's own prefix, unreadable). Over the cap it returns the cap plus one byte, which the builder refuses whole. */
async function readRaw(deps: KeepEvidenceDeps, input: KeepEvidenceInput): Promise<string | undefined> {
  const artifact = (await deps.actions.artifacts(input.task.workspaceId, input.operationId)).find((entry) => entry.name === EVIDENCE_RAW_ARTIFACT);
  const prefix = `private/${input.task.ownerKey}/${input.task.workspaceId}/${input.operationId}/`;
  if (artifact === undefined || !artifact.objectKey.startsWith(prefix)) return undefined;
  return deps.actions.readArtifact(artifact.objectKey, EVIDENCE_RAW_MAX_BYTES + 1);
}

/** Assembles and keeps the pack for a verification run. Never throws. */
export async function keepEvidence(deps: KeepEvidenceDeps, input: KeepEvidenceInput): Promise<KeepEvidenceResult> {
  try {
    if (!DIGEST.test(input.candidateDigest) || !TASK_ID.test(input.task.taskId)) return { kept: false, reason: "invalid" };
    const deny = input.deny ?? NO_PROD_DENY;
    let rawText = await readRaw(deps, input);
    let guarded = 0;
    if (rawText === undefined) return { kept: false, reason: "no_raw" };
    // The guard works on a raw file that parses (a file that does not is refused whole by the builder: it would never have been used).
    let parsedRaw: EvidenceRaw | undefined;
    try { const parsed = EvidenceRawSchema.safeParse(JSON.parse(rawText)); parsedRaw = parsed.success ? parsed.data : undefined; } catch { parsedRaw = undefined; }
    if (parsedRaw !== undefined && parsedRaw.candidateDigest !== input.candidateDigest) return { kept: false, reason: "not_bound" };
    if (parsedRaw !== undefined) {
      const guard = guardRaw(parsedRaw, deny);
      guarded += guard.dropped.parts;
      rawText = JSON.stringify(guard.raw);
      parsedRaw = guard.raw;
    }
    // A check whose raw part carries a test report is a test check; the approved policy's kind wins where it names one.
    const kinds = new Map<string, CheckKind>(input.policyKinds ?? []);
    for (const entry of parsedRaw?.checks ?? []) if (entry.tests !== undefined && !kinds.has(entry.checkId)) kinds.set(entry.checkId, "test");
    // P4: migration evidence marks a migration check, and findings mark a security scan (a known scanner) or a lint check; the approved policy's kind still wins.
    for (const entry of parsedRaw?.checks ?? []) { const kind = kindOfRawCheck(entry); if (kind !== undefined && !kinds.has(entry.checkId)) kinds.set(entry.checkId, kind); }
    const environment = input.environment ?? DEFAULT_EVIDENCE_ENVIRONMENT;
    const built = buildEvidencePack({
      candidateDigest: input.candidateDigest, rawText, checks: input.checks, checkKinds: kinds, environment,
      notTested: [...(environment.envRevision === 0 ? [NO_ENVIRONMENT_ITEM] : []), ...(guarded > 0 ? [WITHHELD_ITEM] : [])], storedArtifacts: new Map(),
    });
    if (built.pack === undefined) return { kept: false, reason: "invalid" };
    const guardedPack = guardPack(built.pack, built.newArtifacts, deny);
    guarded += guardedPack.dropped.parts;
    if (guardedPack.pack === undefined) return { kept: false, reason: "withheld" };
    let pack = guardedPack.pack;
    if (guardedPack.dropped.parts > 0 && !pack.notTested.some((item) => item.id === WITHHELD_ITEM.id)) {
      pack = { ...pack, notTested: [...pack.notTested, WITHHELD_ITEM].slice(0, EVIDENCE_NOT_TESTED_MAX) };
    }
    if (deps.late?.() === true) return { kept: false, reason: "fault" };
    // The tails are stored first: a pack never names a file the store does not hold.
    const owner = { ownerKey: input.task.ownerKey, workspaceId: input.task.workspaceId, taskId: input.task.taskId };
    const stored = await storeEvidenceArtifacts(deps.store, owner, guardedPack.newArtifacts.map((artifact) => ({ kind: "log_txt" as const, bytes: Buffer.from(artifact.text, "utf8"), sha256: artifact.ref.sha256 })));
    pack = { ...pack, checks: pack.checks.map((check) => {
      if (check.outputTailRef === undefined || stored.has(check.outputTailRef.sha256)) return check;
      const { outputTailRef: _lost, ...withoutTail } = check;
      void _lost;
      return withoutTail;
    }) };
    const checked = EvidencePackSchema.safeParse(pack);
    if (!checked.success) return { kept: false, reason: "invalid" };
    if (deps.late?.() === true) return { kept: false, reason: "fault" };
    await deps.store.s3.send(new PutObjectCommand({ Bucket: deps.store.artifactBucketName, Key: evidencePackKey(input.task, input.candidateDigest), Body: JSON.stringify(checked.data), ContentType: "application/json", Metadata: { kind: "evidence-pack" } }));
    return { kept: true, problems: built.problems, guardedParts: guarded };
  } catch (error) {
    deps.log?.("evidence.keep_failed", { error: error instanceof Error ? error.name : "unknown" });
    return { kept: false, reason: "fault" };
  }
}

/** The pack kept for exactly this code of this task; undefined when there is none, it does not parse or is for other code. Never throws. */
export async function loadEvidencePack(actions: Pick<TestProofActions, "readArtifact">, task: EvidenceTask, candidateDigest: string | undefined): Promise<EvidencePack | undefined> {
  if (candidateDigest === undefined || !DIGEST.test(candidateDigest) || !TASK_ID.test(task.taskId)) return undefined;
  try {
    const parsed = EvidencePackSchema.safeParse(JSON.parse(await actions.readArtifact(evidencePackKey(task, candidateDigest), PACK_READ_BYTES)) as unknown);
    return parsed.success && evidenceIsFor(parsed.data, candidateDigest) ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The kinds the approved check policy names, by the id the worker reports (`readiness:<index>`, in selected order). */
export function policyKindsOf(selected: ReadonlyArray<{ kind?: CheckKind | undefined }>): Map<string, CheckKind> {
  const kinds = new Map<string, CheckKind>();
  selected.forEach((check, index) => { if (check.kind !== undefined) kinds.set(`readiness:${String(index)}`, check.kind); });
  return kinds;
}

