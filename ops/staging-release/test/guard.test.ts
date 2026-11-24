import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, runPack, type World } from "./support/harness.ts";
import { BUCKET, EXEC_ID, PIPE_ENV, SHA, sha256, writePackage, writePointers, writeRunRecords } from "./support/fixtures.ts";

let w: World;
const PIN = "9".repeat(64);
const AUTO_ROLE = "arn:aws:sts::111111111111:assumed-role/rovara-staging-code-rel-auto-approver/AWSCodeBuild-1";
const HUMAN_ROLE = "arn:aws:sts::111111111111:assumed-role/rovara-staging-code-rel-approver/controller";
const decisionFile = (): string => join(w.dir, "s3", BUCKET, `decide/${EXEC_ID}/decision.json`);
const approval = (by: string | undefined, summary: string | undefined, status = "Succeeded"): void =>
  w.answer("codepipeline.list-action-executions.rovara-staging-code-release.json", {
    actionExecutionDetails: [{ stageName: "Approve", actionName: "ApproveDeploy", status, updatedBy: by, output: { executionResult: { externalExecutionSummary: summary } } }],
  });
const execution = (type = "STANDARD"): void => w.answer("codepipeline.get-pipeline-execution.rovara-staging-code-release.json", { pipelineExecution: { executionType: type } });
const guard = (): ReturnType<typeof runPack> => runPack(w, "guard.sh", PIPE_ENV(w));
const autoSummary = (): string => `AUTO ${SHA} policy=${PIN} decision=${sha256(readFileSync(decisionFile()))}`;

beforeEach(() => {
  w = makeWorld();
  const pkg = writePackage(join(w.work, "release"));
  writeRunRecords(w, pkg, { verdict: "AUTO" });
  writePointers(w);
  w.answer("ssm.get-parameter._rovara-release_staging_policy-pin.json", { Parameter: { Value: PIN } });
  execution();
  approval(AUTO_ROLE, undefined);
  approval(AUTO_ROLE, autoSummary());
});
afterEach(() => w.cleanup());

describe("guard.sh", () => {
  it("passes an AUTO decision approved by the auto-approver with the exact summary, and writes its record", () => {
    const r = guard();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(w.work, "out/guard.json"), "utf8"))).toMatchObject({ ok: true, sha: SHA, execution: EXEC_ID, verdict: "AUTO" });
  });
  const manual = (result: string | undefined): void => {
    w.s3Put(BUCKET, `decide/${EXEC_ID}/decision.json`, JSON.stringify({ ...JSON.parse(readFileSync(decisionFile(), "utf8")), verdict: "MANUAL" }));
    if (result !== undefined) w.s3Put(BUCKET, `89/${EXEC_ID}/RESULT.md`, result);
  };
  const READY = `Checker notes\nREADY ${SHA}\n`;
  it("passes a MANUAL decision approved by the human approver when the summary carries the hash of the uploaded 89 RESULT, and records that hash", () => {
    manual(READY);
    approval(HUMAN_ROLE, `READY ${SHA} sha256=${sha256(READY)}`);
    const r = guard();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(w.work, "out/guard.json"), "utf8"))).toMatchObject({ verdict: "MANUAL", resultSha256: sha256(READY) });
  });
  it("S10: a MANUAL approval is refused without the uploaded RESULT, with a RESULT that does not say READY for this sha, with the wrong hash, or with a summary that has no hash", () => {
    manual(undefined);
    approval(HUMAN_ROLE, `READY ${SHA} sha256=${sha256(READY)}`);
    expect(guard().status).toBe(3);
    manual(`notes\nREADY ${"c".repeat(40)}\n`);
    approval(HUMAN_ROLE, `READY ${SHA} sha256=${sha256(`notes\nREADY ${"c".repeat(40)}\n`)}`);
    expect(guard().status).toBe(3);
    manual(`NOT READY ${SHA}\n`);
    approval(HUMAN_ROLE, `READY ${SHA} sha256=${sha256(`NOT READY ${SHA}\n`)}`);
    expect(guard().status).toBe(3);
    manual(READY);
    approval(HUMAN_ROLE, `READY ${SHA} sha256=${"0".repeat(64)}`);
    expect(guard().status).toBe(3);
    approval(HUMAN_ROLE, `READY ${SHA}`);
    const r = guard();
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("sha256");
    expect(existsSync(join(w.work, "out/guard.json"))).toBe(false);
  });
  it("refuses an AUTO decision approved by a human, a MANUAL decision approved by the auto-approver, and a wrong summary", () => {
    approval(HUMAN_ROLE, autoSummary());
    expect(guard().status).toBe(3);
    w.s3Put(BUCKET, `decide/${EXEC_ID}/decision.json`, JSON.stringify({ ...JSON.parse(readFileSync(decisionFile(), "utf8")), verdict: "MANUAL" }));
    w.s3Put(BUCKET, `89/${EXEC_ID}/RESULT.md`, `READY ${SHA}\n`);
    approval(AUTO_ROLE, `READY ${SHA} sha256=${sha256(`READY ${SHA}\n`)}`);
    expect(guard().status).toBe(3);
    approval(HUMAN_ROLE, `READY ${"c".repeat(40)} sha256=${sha256(`READY ${SHA}\n`)}`);
    expect(guard().status).toBe(3);
    expect(existsSync(join(w.work, "out/guard.json"))).toBe(false);
  });
  it("refuses an AUTO summary for another decision hash or another pin", () => {
    approval(AUTO_ROLE, `AUTO ${SHA} policy=${PIN} decision=${"0".repeat(64)}`);
    expect(guard().status).toBe(3);
    approval(AUTO_ROLE, `AUTO ${SHA} policy=${"8".repeat(64)} decision=${sha256(readFileSync(decisionFile()))}`);
    expect(guard().status).toBe(3);
  });
  it("fails closed when the approval is missing, not succeeded, or carries no approver or summary", () => {
    w.answer("codepipeline.list-action-executions.rovara-staging-code-release.json", { actionExecutionDetails: [] });
    expect(guard().status).toBe(3);
    approval(AUTO_ROLE, autoSummary(), "InProgress");
    expect(guard().status).toBe(3);
    approval(undefined, autoSummary());
    expect(guard().status).toBe(3);
    approval(AUTO_ROLE, undefined);
    expect(guard().status).toBe(3);
  });
  it("refuses a rollback-type execution (P9 owns the rollback rules)", () => {
    execution("ROLLBACK");
    const r = guard();
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("rollback");
  });
  it("F5: an unreadable installed pointer is not 'none': a throttled or denied read refuses even when Check saw no pointer", () => {
    w.s3Put(BUCKET, `check/${EXEC_ID}/check.json`, JSON.stringify({ installed: "none", mode: "auto-eligible" }));
    w.answer("ssm.get-parameter._rovara-release_staging_code-installed.json", { __error: "ThrottlingException", message: "Rate exceeded" });
    const r = guard();
    expect(r.status).not.toBe(0);
    expect(existsSync(join(w.work, "out/guard.json"))).toBe(false);
    w.answer("ssm.get-parameter._rovara-release_staging_code-installed.json", { __error: "ParameterNotFound", message: "x" });
    expect(guard().status, "a plain not-found with Check also seeing none passes").toBe(0);
  });
  it("F6: a hold at any depth, or a bare code-hold parameter, is a HOLD; an unreadable hold list is a HOLD", () => {
    w.answer("ssm.get-parameters-by-path.json", { Parameters: [{ Name: "/rovara-release/staging/code-hold/deep/er/x" }] });
    expect(guard().status).toBe(3);
    expect(w.calls().find((c) => c.startsWith("ssm get-parameters-by-path"))).toContain("--recursive");
    w.answer("ssm.get-parameters-by-path.json", { Parameters: [] });
    w.answer("ssm.get-parameter._rovara-release_staging_code-hold.json", { Parameter: { Name: "/rovara-release/staging/code-hold", Value: "x" } });
    expect(guard().status).toBe(3);
    w.answer("ssm.get-parameter._rovara-release_staging_code-hold.json", { __error: "AccessDeniedException", message: "no" });
    expect(guard().status).toBe(3);
    w.answer("ssm.get-parameter._rovara-release_staging_code-hold.json", { __error: "ParameterNotFound", message: "x" });
    w.answer("ssm.get-parameters-by-path.json", { __error: "ThrottlingException", message: "x" });
    expect(guard().status).toBe(3);
  });
  it("refuses with a HOLD set, when the pointer moved, and when Decide judged another sha", () => {
    w.answer("ssm.get-parameters-by-path.json", { Parameters: [{ Name: "/rovara-release/staging/code-hold/x" }] });
    expect(guard().status).toBe(3);
    w.answer("ssm.get-parameters-by-path.json", { Parameters: [] });
    writePointers(w, "d".repeat(40));
    expect(guard().status).toBe(3);
    writePointers(w);
    w.s3Put(BUCKET, `decide/${EXEC_ID}/decision.json`, JSON.stringify({ verdict: "AUTO", record: { sha: "c".repeat(40), execution: EXEC_ID } }));
    expect(guard().status).toBe(3);
  });
});
