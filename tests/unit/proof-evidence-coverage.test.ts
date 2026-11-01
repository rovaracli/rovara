// Proof and evidence P3, the broker's half: the changed-line coverage the worker read is kept in the pack (after the data guard and the broker's own consistency check) and the pull request shows counts only.
// A worker that sends no coverage (an older worker, or a project with no report) gives a pack without it, and the pull request says "no coverage report" plainly.
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import type { CheckEntry } from "../../packages/contracts/src/index.js";
import { evidenceLines } from "../../packages/broker/src/rovara-code/evidence-lines.js";
import { keepEvidence, loadEvidencePack, type KeepEvidenceDeps } from "../../packages/broker/src/rovara-code/evidence-keep.js";

const DIGEST = "c".repeat(64);
const TASK = { ownerKey: "owner-1", workspaceId: "ws-1", taskId: "task-1" };
const OP = "op-1";
const PREFIX = `private/${TASK.ownerKey}/${TASK.workspaceId}/${OP}/`;
const entry = (id: string, label: string, over: Partial<CheckEntry> = {}): CheckEntry => ({ id, label, source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 700, exitCode: 0, ...over });
const tests = { total: 3, passed: 3, failed: 0, skipped: 0, errored: 0, names: [], newTests: [] };
const rawOf = (checks: unknown[]) => ({ schemaVersion: 1, candidateDigest: DIGEST, checks, selection: { method: "full", selected: 3, total: 3 } });

function world(rawText: string) {
  const objects = new Map<string, string>();
  const s3 = { async send(command: unknown) {
    if (command instanceof PutObjectCommand) { objects.set(command.input.Key!, String(command.input.Body as string)); return {}; }
    if (command instanceof GetObjectCommand) { const found = objects.get(command.input.Key!); if (found === undefined) throw new Error("NoSuchKey"); return { Body: { transformToString: async () => found } }; }
    throw new Error("unexpected command");
  } } as unknown as S3Client;
  const actions: KeepEvidenceDeps["actions"] = {
    async artifacts() { return [{ name: "evidence-raw.json", objectKey: `${PREFIX}evidence-raw.json` }]; },
    async readArtifact(key, max) { return key.startsWith(PREFIX) ? rawText.slice(0, max) : objects.get(key)?.slice(0, max) ?? ""; },
  };
  return { deps: { actions, store: { s3, artifactBucketName: "bucket" } } satisfies KeepEvidenceDeps };
}
const keep = async (checks: unknown[]) => {
  const w = world(JSON.stringify(rawOf(checks)));
  const result = await keepEvidence(w.deps, { task: TASK, operationId: OP, candidateDigest: DIGEST, checks: [entry("readiness:0", "pytest -q")] });
  return { result, pack: await loadEvidencePack(w.deps.actions, TASK, DIGEST) };
};
const prLines = (pack: NonNullable<Awaited<ReturnType<typeof keep>>["pack"]>) => evidenceLines({ pack, mode: "summary" }, DIGEST, 0).lines.join("\n");

describe("changed-line coverage in the evidence", () => {
  it("keeps the coverage the worker read, and the pull request shows the counts", async () => {
    const { result, pack } = await keep([{ checkId: "readiness:0", tests, coverage: { linesChanged: 8, linesCovered: 6, files: [{ path: "src/match.py", uncovered: [14, 15] }] } }]);
    expect(result).toMatchObject({ kept: true });
    expect(pack?.checks[0]?.coverage).toEqual({ linesChanged: 8, linesCovered: 6, files: [{ path: "src/match.py", uncovered: [14, 15] }] });
    expect(prLines(pack!)).toContain("Changed lines covered by tests: 6 of 8 (75%)");
  });

  it("says 'no coverage report' for a pack whose worker sent none (an older worker, or a project that writes no report)", async () => {
    const { pack } = await keep([{ checkId: "readiness:0", tests }]);
    expect(pack?.checks[0]?.coverage).toBeUndefined();
    expect(prLines(pack!)).toContain("Changed lines covered by tests: no coverage report");
    expect(prLines(pack!)).not.toContain("0 of 0");
  });

  it("says so when the report lists none of the changed lines, instead of a bare 0 of 0", async () => {
    const { pack } = await keep([{ checkId: "readiness:0", tests, coverage: { linesChanged: 0, linesCovered: 0, files: [] } }]);
    expect(prLines(pack!)).toContain("the coverage report lists none of the changed lines");
  });

  it("drops coverage whose file lists do not add up (a worker is not taken at its word), keeping the rest of the check", async () => {
    const { pack } = await keep([{ checkId: "readiness:0", tests, coverage: { linesChanged: 4, linesCovered: 4, files: [{ path: "a.py", uncovered: [1, 2] }] } }]);
    expect(pack?.checks[0]?.coverage).toBeUndefined();
    expect(pack?.checks[0]?.tests?.total).toBe(3);
  });

  it("puts only counts on the pull request: a file path written in the repository (markup, a mention) never appears there", async () => {
    const path = "src/[click](http://evil.example)/@everyone.py";
    const { pack } = await keep([{ checkId: "readiness:0", tests, coverage: { linesChanged: 2, linesCovered: 1, files: [{ path, uncovered: [2] }] } }]);
    expect(pack?.checks[0]?.coverage?.files[0]?.path).toBeDefined();
    const text = prLines(pack!);
    expect(text).toContain("1 of 2");
    expect(text).not.toContain("evil.example");
    expect(text).not.toContain("@everyone");
  });

  it("runs coverage through the data guard: a path that holds personal data loses the check's details, not the whole pack", async () => {
    const { result, pack } = await keep([{ checkId: "readiness:0", tests, coverage: { linesChanged: 2, linesCovered: 1, files: [{ path: "fixtures/jane.doe@gmail.com.py", uncovered: [2] }] } }]);
    expect(result).toMatchObject({ kept: true });
    expect(pack?.checks[0]?.coverage).toBeUndefined();
    expect(pack?.checks[0]?.tests).toBeUndefined();
    expect(pack?.notTested.some((item) => item.id === "data_guard")).toBe(true);
  });
});
