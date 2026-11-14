// Proof and evidence P3 and P4 ship behind the proof switch (`pe`, off by default). With it off the broker never asks a worker for evidence, so none of the new worker code can run, and the broker has no
// evidence port, so nothing is read, shown or added to the risk. These tests pin that: the new worker modules are reachable only through the evidence hook, which run-task calls only when the broker asked;
// and the description and the risk are byte for byte what they were when no signal exists.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCandidateManifest } from "@rovara-code/contracts";
import { createWorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { rovaraPullRequestBody } from "../../packages/broker/src/rovara-code/pull-request-body.js";

const WORKER = join(__dirname, "../../packages/worker/src");
const files = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
});
const importersOf = (module: string): string[] => files(WORKER).filter((path) => new RegExp(String.raw`from "[./]*(?:verification/)?${module}\.js"`, "u").test(readFileSync(path, "utf8"))).map((path) => path.slice(WORKER.length + 1)).sort();

describe("the worker side is reachable only through the evidence hook", () => {
  it("only the evidence hook and its own modules use the new modules", () => {
    // (env-detect/propose.ts only asks coverageSpecsOf which test checks name no report, for the setup wizard's note: S-2.)
    expect(importersOf("cobertura-lcov-coverage")).toEqual(["env-detect/propose.ts", "verification/evidence-raw.ts", "verification/line-coverage-join.ts", "verification/migration-check.ts", "verification/sarif.ts"]);
    expect(importersOf("sarif")).toEqual(["verification/evidence-raw.ts", "verification/sarif-baseline.ts"]);
    expect(importersOf("sarif-baseline")).toEqual(["verification/evidence-raw.ts"]);
    expect(importersOf("migration-check")).toEqual(["verification/evidence-raw.ts"]);
    // (NH-1: the nightly run reads coverage.py's contexts file through the same contained reader; it is not the evidence path.)
    expect(importersOf("report-file")).toEqual(["nightly-invocation.ts", "verification/cobertura-lcov-coverage.ts", "verification/evidence-raw.ts", "verification/sarif-baseline.ts"]);
    // EV-2 / S-2: the Go and JaCoCo readers take text (the file comes through readContainedReport in readChangedCoverage) and open no file; the join places their files and is reached only from the evidence hook.
    expect(importersOf("line-coverage-join")).toEqual(["verification/evidence-raw.ts"]);
    expect(readFileSync(join(WORKER, "verification/changed-coverage.ts"), "utf8")).not.toMatch(/from "node:fs|from "fs/u);
    expect(readFileSync(join(WORKER, "verification/line-coverage-join.ts"), "utf8")).not.toMatch(/from "node:fs|from "fs/u);
    expect(importersOf("evidence-raw")).toEqual(["run-task.ts"]);
  });

  it("run-task starts it only when the invocation carries evidenceCapture, which the broker sets only while the proof switch is on", () => {
    const source = readFileSync(join(WORKER, "run-task.ts"), "utf8");
    const calls = [...source.matchAll(/saveEvidenceRaw\(/gu)];
    expect(calls).toHaveLength(1);
    const before = source.slice(Math.max(0, calls[0]!.index - 1200), calls[0]!.index); // TE-B1 put the fresh-round report root between the gate and the call
    expect(before).toMatch(/invocation\.payload\.evidenceCapture === true/u);
  });
});

describe("with no evidence signal the description and the risk are what they were", () => {
  const code = createCandidateManifest([{ repositoryId: "payments", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const workflow = { ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-11-04T12:00:00.000Z", definitionVersion: "1.1.0" }), candidate: code };
  const body = (evidenceRisk: { highNewFindings: number } | undefined) => rovaraPullRequestBody({
    summary: ["Score partners."], fallbackTitle: "Score partners", workflow, pageUrl: undefined,
    context: { changedFiles: { files: [{ repository: "payments", path: "src/retry.ts", added: 3, removed: 1 }], complete: true }, ...(evidenceRisk === undefined ? {} : { evidenceRisk }) }, reviewLines: () => ["- No findings."],
  });

  it("is the same description byte for byte without the signal, and names the finding and the High level with it", () => {
    expect(body(undefined)).toBe(body(undefined));
    expect(body({ highNewFindings: 0 })).toBe(body(undefined));
    const raised = body({ highNewFindings: 2 });
    expect(raised).not.toBe(body(undefined));
    expect(raised).toContain("A security scan found 2 new high or critical findings.");
    expect(raised).toMatch(/Risk[^\n]*High/iu);
    expect(body(undefined)).not.toMatch(/security scan found/iu);
  });
});

describe("the broker judges the risk with the evidence where a pull request's risk is judged", () => {
  const BROKER = join(__dirname, "../../packages/broker/src/aws");
  it("the initial publication, a pushed fix and a description rewrite each read the evidence signal through the port (which exists only while the switch is on)", () => {
    const publication = readFileSync(join(BROKER, "developer-tasks/publication.ts"), "utf8");
    expect(publication).toContain("recomputeRisk(workflow, bodyContext?.changedFiles, {}, evidenceRisk)");
    // The last argument says whether the approved check policy has a security check: with it, a pack that cannot be had is "evidence unavailable" and the risk is at least medium (EV-2).
    expect(publication).toContain("evidenceRiskOfTask(deps.evidence, task, workflow.candidate?.digest, securityCheckIdsOf(workflow.checkPolicy))");
    expect(publication).toContain("await evidenceRiskOfTask(deps.evidence, task, started.candidate?.digest, securityCheckIdsOf(workflow.checkPolicy))");
    expect(publication).toMatch(/\.\.\.\(evidenceRisk === undefined \? \{\} : \{ evidenceRisk \}\)/u);
    const reconcile = readFileSync(join(BROKER, "broker/pull-request-reconcile.ts"), "utf8");
    expect(reconcile).toContain("evidenceRiskOfTask(evidenceRouteDependencies(dependencies).evidence, task, candidateDigest, securityCheckIdsOf(workflow.checkPolicy))");
    expect(reconcile).toMatch(/\.\.\.\(evidenceRisk === undefined \? \{\} : \{ evidenceRisk \}\)/u);
  });
});
