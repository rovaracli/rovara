// Proof and evidence (wire-proof): what a CHECKS run writes as `evidence-raw.json`, the worker's half of the evidence. For each project check whose own command already writes a test report (a vitest/jest JSON
// or a JUnit XML file at a path its arguments name: the same rule as TESTPROOF, AgentX never alters a customer's command) the report is read in the workspace and turned into totals, test names and the tests
// the change added or changed (`parseTestReport`, `evidenceTests`); a failed check also keeps the end of its output. Nothing else is claimed: no coverage, findings or migrations (those parsers are not built),
// and the selection is "the whole check command ran" only for a run that read at least one report.
//
// The file is UNTRUSTED by the broker, which binds it to the candidate's digest, checks every count against the check report it holds itself and the data guard before anything is kept
// (broker/src/rovara-code/evidence-keep.ts). This module only has to be bounded and never throw: a fault leaves the file out, and the round goes on as it would have.
import { EVIDENCE_ARTIFACT_MAX_BYTES, EVIDENCE_RAW_ARTIFACT, EVIDENCE_RAW_MAX_BYTES, EvidenceRawSchema, createCandidateManifest, redactText, type CandidateRepository, type CheckEntry, type EvidenceRaw, type ProjectCommand } from "@agentx/contracts";
import type { ArtifactSink } from "../artifacts.js";
import type { CheckPlan } from "./checks.js";
import { changedTestFiles, readCheckReport, type TestProofRepository } from "./test-proof.js";
import { evidenceTests, parseTestReport } from "./test-report.js";

export interface CollectEvidenceInput {
  /** The workspace root, where a check's report path is resolved from its cwd. */
  rootPath: string;
  /** The project checks that were run, in order: check `readiness:<index>` is `commands[index]`. */
  commands: readonly ProjectCommand[];
  /** The round's entries on the candidate. */
  entries: readonly CheckEntry[];
  /** The digest of the candidate the checks ran on (the broker discards a file for any other). */
  candidateDigest: string;
  /** Where the task started, for the tests the change added or changed. A repository that cannot be read leaves its tests out of "new". */
  repositories: readonly TestProofRepository[];
  /** What test selection decided (test environment, wire-testenv): used as it is when it ran fewer tests than the whole, otherwise only its fallback reason is kept and the counts are what the reports measured. */
  selection?: EvidenceSelection | undefined;
}

type EvidenceSelection = NonNullable<EvidenceRaw["selection"]>;
/** The selection the raw file reports: the plan's when it narrowed the tests, the whole check (counted by the reports) with the plan's reason when it fell back, and the whole check when nothing was planned. */
function selectionOf(planned: EvidenceSelection | undefined, measured: number): EvidenceSelection | undefined {
  if (planned !== undefined && planned.selected < planned.total) return planned;
  if (measured <= 0) return undefined;
  return { method: "full", selected: measured, total: measured, ...(planned?.fallbackReason === undefined ? {} : { fallbackReason: planned.fallbackReason }) };
}

const OUTPUT_TAIL_BYTES = Math.min(EVIDENCE_ARTIFACT_MAX_BYTES.log_txt, 16 * 1024);

/** The end of an output, cut from its start until it fits, redacted again; a cut in the middle of a surrogate pair drops the lone half. */
export function outputTailOf(output: string, maxBytes = OUTPUT_TAIL_BYTES): string | undefined {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is taken out of a tail
  let tail = redactText(output).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, " ");
  while (Buffer.byteLength(tail, "utf8") > maxBytes) tail = tail.slice(Math.max(1, Math.ceil((Buffer.byteLength(tail, "utf8") - maxBytes) / 4)));
  tail = tail.replace(/^[\uDC00-\uDFFF]/u, "").trim();
  return tail === "" ? undefined : tail;
}

/** The raw evidence, or undefined when there is nothing to say (no check named a readable report and none failed). Never throws. */
export async function collectEvidenceRaw(input: CollectEvidenceInput): Promise<EvidenceRaw | undefined> {
  try {
    const changedTestPaths: string[] = [];
    for (const repository of input.repositories) {
      try { changedTestPaths.push(...(await changedTestFiles(repository)).present); } catch { /* a repository that cannot be read: its tests are not marked new */ }
    }
    const checks: EvidenceRaw["checks"] = [];
    let measured = 0;
    for (const [index, command] of input.commands.entries()) {
      const entry = input.entries.find((candidate) => candidate.id === `readiness:${String(index)}`);
      if (entry === undefined) continue;
      const read = await readCheckReport(input.rootPath, command).catch(() => undefined);
      const parsed = read === undefined ? undefined : parseTestReport(read.text, read.kind);
      const outputTail = entry.after === "failed" ? outputTailOf(entry.output) : undefined;
      if (parsed === undefined && outputTail === undefined) continue;
      if (parsed !== undefined) measured += parsed.total;
      checks.push({
        checkId: entry.id,
        ...(parsed === undefined ? {} : { tests: evidenceTests(parsed, { changedTestPaths }) }),
        ...(outputTail === undefined ? {} : { outputTail }),
      });
    }
    if (checks.length === 0) return undefined;
    const raw: EvidenceRaw = {
      schemaVersion: 1, candidateDigest: input.candidateDigest, checks,
      ...(selectionOf(input.selection, measured) === undefined ? {} : { selection: selectionOf(input.selection, measured)! }),
    };
    const parsed = EvidenceRawSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    return Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > EVIDENCE_RAW_MAX_BYTES ? undefined : parsed.data;
  } catch {
    return undefined;
  }
}

/**
 * The CHECKS run's hook (run-task.ts, only when the invocation carries `evidenceCapture`): reads the reports of the round's project checks BEFORE the test proof runs the original code, and saves the result as
 * `evidence-raw.json`. Informational: a fault or a failed save is only a missing file, never a failed round. The candidate digest is the one the test proof is bound to (the code the checks ran on).
 */
export async function saveEvidenceRaw(input: {
  sink: ArtifactSink; rootPath: string; plan: CheckPlan; entries: readonly CheckEntry[];
  repositories: ReadonlyArray<{ repositoryId: string; directory: string; baseCommitSha?: string | undefined }>; candidateBefore: ReadonlyArray<CandidateRepository>;
  selection?: EvidenceSelection | undefined;
}): Promise<boolean> {
  try {
    if (input.plan.source !== "project" || input.plan.readiness === undefined) return false;
    const raw = await collectEvidenceRaw({
      rootPath: input.rootPath, commands: input.plan.readiness, entries: input.entries, candidateDigest: createCandidateManifest(input.candidateBefore).digest,
      repositories: input.repositories.map((repository) => ({
        repositoryId: repository.repositoryId, directory: repository.directory, startCommit: repository.baseCommitSha ?? "",
        candidateTreeSha: input.candidateBefore.find((entry) => entry.repositoryId === repository.repositoryId)?.treeSha ?? "",
      })).filter((repository) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(repository.startCommit) && repository.candidateTreeSha !== ""),
      selection: input.selection,
    });
    if (raw === undefined) return false;
    await input.sink({ name: EVIDENCE_RAW_ARTIFACT, mediaType: "application/json", content: JSON.stringify(raw) });
    return true;
  } catch {
    return false;
  }
}
