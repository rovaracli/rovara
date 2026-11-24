/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- the tests read the JSON records the scripts write and edit plain JSON documents, which a typed document would not allow */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyPack, makeWorld, runPack, type World } from "./support/harness.ts";
import { BUCKET, CS, DEPLOY_ORDER, EXEC_ID, PARTS, PIPE_ENV, PREV, SHA, csId, stack, templateOf, canonSha, writePackage, writePointers, writeRunRecords, writeStacks, writeChangeSets } from "./support/fixtures.ts";

let w: World;
let pkg: string;
const env = (): Record<string, string> => ({ ...PIPE_ENV(w), SYNTH_DIR: pkg });
const key = (stage: string, name: string): string => `${stage}/${EXEC_ID}/${name}`;
const decisionPath = (): string => join(w.dir, "s3", BUCKET, key("decide", "decision.json"));
const editDecision = (fn: (d: any) => void): void => {
  const d = JSON.parse(readFileSync(decisionPath(), "utf8"));
  fn(d);
  writeFileSync(decisionPath(), JSON.stringify(d));
};
const executes = (): string[] => w.calls().filter((c) => c.startsWith("cloudformation execute-change-set"));
const deploy = (extra: Record<string, string> = {}, args: string[] = []) => runPack(w, "deploy.sh", { ...env(), ...extra }, args);

beforeEach(() => {
  w = makeWorld();
  pkg = writePackage(join(w.work, "release"));
  writeStacks(w);
  writeChangeSets(w);
  writeRunRecords(w, pkg);
  writePointers(w);
});
afterEach(() => w.cleanup());

describe("deploy.sh guards (each stops a real run before anything executes)", () => {
  it("a differing release package hash is refused", () => {
    writeFileSync(join(pkg, "answers.json"), JSON.stringify({ tampered: true }));
    const r = deploy();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("[FAIL] package-hash");
    expect(r.stdout).toContain("differs from the one Preview recorded");
    expect(executes()).toHaveLength(0);
  });

  it("Preview's own two records of the package hash must agree", () => {
    w.s3Put(BUCKET, key("preview", "release.sha256"), "f".repeat(64) + "\n");
    const r = deploy();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("[FAIL] package-hash");
    expect(executes()).toHaveLength(0);
  });

  it("an unrecorded change set is refused (a stack with no entry in Decide's record)", () => {
    editDecision((d) => { d.record.changeSets = d.record.changeSets.filter((c: any) => c.stack !== stack("slack")); });
    const r = deploy();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("[FAIL] recorded-change-sets");
    expect(r.stdout).toContain("recorded 0 change sets");
    expect(executes()).toHaveLength(0);
  });

  it("a change set that is not the one Decide judged is refused (different id, then a changed template, then a changed name)", () => {
    w.answer(`cloudformation.describe-change-set.${stack("runtime")}.${CS}.json`, { ChangeSetName: CS, ChangeSetId: csId("other"), Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE" });
    let r = deploy();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("different id");
    writeChangeSets(w);
    w.answer(`cloudformation.get-template.${stack("runtime")}.${CS}.json`, { TemplateBody: { ...templateOf("runtime"), Resources: { Evil: { Type: "AWS::IAM::Role" } } } });
    r = deploy();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("template is not the one Decide judged");
    writeChangeSets(w);
    editDecision((d) => { d.record.changeSets.find((c: any) => c.stack === stack("runtime")).changeSetName = "rovara-pipeline-deadbeef"; });
    r = deploy();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("not named");
    expect(executes()).toHaveLength(0);
  });

  it("a record naming a stack outside the deploy order is refused", () => {
    editDecision((d) => { d.record.changeSets.push({ stack: "agentx-staging-secrets", changeSetName: CS, changeSetId: csId("x"), noChanges: false, templateSha256: "0".repeat(64) }); });
    const r = deploy();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("not in the deploy order");
  });

  it("the access stack is never executed: it may sit in the record, but is only ever tidied", () => {
    expect(JSON.parse(readFileSync(decisionPath(), "utf8")).record.changeSets.some((c: any) => c.stack === stack("access"))).toBe(true);
    const r = deploy();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(executes().some((c) => c.includes(stack("access")))).toBe(false);
  });

  it("an order.txt that names the access stack is refused before anything runs", () => {
    const root = copyPack(w);
    writeFileSync(join(root, "order.txt"), "control-plane\naccess\n");
    const r = runPack(w, "deploy.sh", env(), [], w.work, root);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("access");
    expect(executes()).toHaveLength(0);
  });

  it("a symlink anywhere in the pack is refused", () => {
    const root = copyPack(w);
    symlinkSync("/etc/hosts", join(root, "evil-link.sh"));
    const r = runPack(w, "deploy.sh", env(), [], w.work, root);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("symlink");
    expect(executes()).toHaveLength(0);
  });

  it("refuses without the Guard record, and with one for another sha", () => {
    w.cleanup();
    w = makeWorld();
    pkg = writePackage(join(w.work, "release"));
    writeStacks(w); writeChangeSets(w); writePointers(w);
    writeRunRecords(w, pkg);
    writeFileSync(join(w.dir, "s3", BUCKET, key("guard", "guard.json")), JSON.stringify({ ok: true, execution: EXEC_ID, sha: "c".repeat(40) }));
    let r = deploy();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("[FAIL] guard-record");
    writeFileSync(join(w.dir, "s3", BUCKET, key("guard", "guard.json")), JSON.stringify({ ok: false, execution: EXEC_ID, sha: SHA }));
    r = deploy();
    expect(r.status).toBe(3);
    expect(executes()).toHaveLength(0);
  });

  it("refuses a gate that failed, one for another sha, and a skip without a recorded reason", () => {
    const g = (n: string, body: object): void => w.s3Put(BUCKET, key("gates", `gates/${n}.json`), JSON.stringify(body));
    g("25-gate", { name: "25-gate", sha: SHA, writtenAt: "x", result: "fail", failures: ["G5"] });
    expect(deploy().status).toBe(3);
    g("25-gate", { name: "25-gate", sha: "c".repeat(40), writtenAt: "x", result: "pass", failures: [] });
    expect(deploy().status).toBe(3);
    g("25-gate", { name: "25-gate", sha: SHA, writtenAt: "x", result: "skipped", failures: [] });
    const r = deploy();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("[FAIL] gates");
    expect(executes()).toHaveLength(0);
  });

  it("refuses while a HOLD exists and when the installed pointer moved since Check", () => {
    w.answer("ssm.get-parameters-by-path.json", { Parameters: [{ Name: "/rovara-release/staging/code-hold/postcheck-1" }] });
    let r = deploy();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("[FAIL] no-hold");
    w.answer("ssm.get-parameters-by-path.json", { Parameters: [] });
    writePointers(w, "d".repeat(40));
    r = deploy();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("[FAIL] installed-pointer");
  });

  it("refuses an unsettled stack", () => {
    writeStacks(w, { runtime: "UPDATE_IN_PROGRESS" });
    expect(deploy().status).toBe(3);
    writeStacks(w, { slack: "UPDATE_ROLLBACK_COMPLETE" });
    expect(deploy().status).toBe(3);
    writeStacks(w, { "control-plane": "UPDATE_ROLLBACK_COMPLETE" });
    const r = deploy({}, ["--dry-run"]);
    expect(r.stdout, "control-plane may be UPDATE_ROLLBACK_COMPLETE").toContain("[ OK ] stacks-settled");
  });

  it("a real run needs the full records (decision, guard, gates): the same world minus the decision is refused", () => {
    rmSync(decisionPath());
    const r = deploy();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("[FAIL] ready-guard");
  });

  it("refuses a bad flag and the wrong environment", () => {
    expect(deploy({}, ["--go"]).status).toBe(3);
    expect(deploy({ ENVIRONMENT: "production" }).status).toBe(3);
    expect(deploy({ AWS_REGION: "us-east-1" }).status).toBe(3);
  });
});

describe("deploy.sh --dry-run (the Gates stage runs it before Decide and the approval exist)", () => {
  const preDecision = (): void => {
    // what the Gates stage sees: Preview's and Check's records, but no decision, no guard record, no gate markers yet
    w.cleanup();
    w = makeWorld();
    pkg = writePackage(join(w.work, "release"));
    writeStacks(w); writeChangeSets(w); writePointers(w);
    writeRunRecords(w, pkg);
    for (const f of [key("decide", "decision.json"), key("guard", "guard.json"), key("gates", "gates/15-gate.json"), key("gates", "gates/25-gate.json"), key("gates", "gates/45-gate.json"), key("gates", "gates/46-gate.json")]) rmSync(join(w.dir, "s3", BUCKET, f));
  };
  it("a healthy pre-decision world fails ONLY ready-guard (the one name the policy ignores) and executes nothing", () => {
    preDecision();
    const r = deploy({}, ["--dry-run"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout.match(/\[FAIL\] \S+/g)).toEqual(["[FAIL] ready-guard"]);
    for (const g of ["pipeline-identity", "package-hash", "recorded-change-sets", "stacks-settled", "installed-pointer", "no-hold"]) expect(r.stdout).toContain(`[ OK ] ${g}`);
    expect(readFileSync(join(w.work, "out/dry-run-failures.txt"), "utf8").trim()).toBe("ready-guard");
    expect(executes()).toHaveLength(0);
  });
  it("reports every other failing guard too (not only the first)", () => {
    preDecision();
    writeFileSync(join(pkg, "answers.json"), "{}");
    writeStacks(w, { runtime: "UPDATE_IN_PROGRESS" });
    w.answer("ssm.get-parameters-by-path.json", { Parameters: [{ Name: "/rovara-release/staging/code-hold/x" }] });
    const r = deploy({}, ["--dry-run"]);
    expect(r.status).toBe(0);
    for (const g of ["package-hash", "ready-guard", "stacks-settled", "no-hold"]) expect(r.stdout).toContain(`[FAIL] ${g}`);
    expect(r.stdout).toContain("DRY RUN:");
    expect(executes()).toHaveLength(0);
  });
  it("checks the change sets against Preview's record: a changed change set is a failure", () => {
    preDecision();
    w.answer(`cloudformation.describe-change-set.${stack("slack")}.${CS}.json`, { ChangeSetName: CS, ChangeSetId: csId("other"), Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE" });
    const r = deploy({}, ["--dry-run"]);
    expect(r.stdout).toContain("[FAIL] recorded-change-sets");
  });
  it("a dry run always reports ready-guard, even when the real run's records already exist", () => {
    const r = deploy({}, ["--dry-run"]);
    expect(r.stdout).toContain("[FAIL] ready-guard");
  });
});

describe("deploy.sh real run", () => {
  it("executes the recorded change sets by name in order.txt order, never access, then tidies every pipeline change set", () => {
    for (const p of [...PARTS]) {
      w.answer(`cloudformation.list-change-sets.${stack(p)}.json`, { Summaries: [{ ChangeSetName: CS }, { ChangeSetName: "rovara-pipeline-deadbeef" }, { ChangeSetName: "rovara-pipeline-cafe0000" }, { ChangeSetName: "someone-elses" }] });
      // an older run's change set is OBSOLETE once this run executed; a newer run's is still AVAILABLE and must be left alone
      w.answer(`cloudformation.describe-change-set.${stack(p)}.rovara-pipeline-deadbeef.json`, { ChangeSetName: "rovara-pipeline-deadbeef", ExecutionStatus: "OBSOLETE" });
      w.answer(`cloudformation.describe-change-set.${stack(p)}.rovara-pipeline-cafe0000.json`, { ChangeSetName: "rovara-pipeline-cafe0000", ExecutionStatus: "AVAILABLE" });
    }
    const r = deploy();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const ex = executes();
    expect(ex.map((c) => c.match(/--stack-name (\S+)/)?.[1])).toEqual(DEPLOY_ORDER.map(stack));
    for (const c of ex) expect(c).toContain(`--change-set-name ${CS}`);
    const deletes = w.calls().filter((c) => c.startsWith("cloudformation delete-change-set"));
    expect(deletes.some((c) => c.includes(`--stack-name ${stack("access")}`) && c.includes(`--change-set-name ${CS}`))).toBe(true);
    expect(deletes.some((c) => c.includes("rovara-pipeline-deadbeef"))).toBe(true);
    expect(deletes.some((c) => c.includes("someone-elses"))).toBe(false);
    expect(deletes.some((c) => c.includes("rovara-pipeline-cafe0000")), "F8: a change set still AVAILABLE belongs to a newer run").toBe(false);
    const rec = JSON.parse(readFileSync(join(w.work, "out/deploy.json"), "utf8"));
    expect(rec).toMatchObject({ ok: true, sha: SHA, execution: EXEC_ID });
    // plain CLI only: no repository code, no secrets
    expect(w.calls().some((c) => /secretsmanager|get-secret-value|node |npm |agentx /.test(c))).toBe(false);
  });

  it("F3: each change set is re-verified immediately before its own execute: one replaced after the up-front check is never executed", () => {
    // the 2nd read of the runtime change set (the one just before its execute) answers with another id: control-plane has run, runtime must not
    writeFileSync(join(w.dir, `cloudformation.describe-change-set.${stack("runtime")}.${CS}.2.json`), JSON.stringify({ ChangeSetName: CS, ChangeSetId: csId("replaced"), Status: "CREATE_COMPLETE", ExecutionStatus: "AVAILABLE" }));
    const r = deploy();
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("different id");
    expect(executes().map((c) => c.match(/--stack-name (\S+)/)?.[1])).toEqual([stack("control-plane")]);
  });

  it("after an execute, the change set of that name must still be the recorded one: a different id stops the run before later stacks", () => {
    // the 3rd read of the control-plane change set (after its execute) answers with another id
    writeFileSync(join(w.dir, `cloudformation.describe-change-set.${stack("control-plane")}.${CS}.3.json`), JSON.stringify({ ChangeSetName: CS, ChangeSetId: csId("swapped"), Status: "CREATE_COMPLETE", ExecutionStatus: "EXECUTE_COMPLETE" }));
    const r = deploy();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("not the recorded change set");
    expect(executes().map((c) => c.match(/--stack-name (\S+)/)?.[1])).toEqual([stack("control-plane")]);
    expect(w.calls().some((c) => c.startsWith("cloudformation delete-change-set"))).toBe(false);
  });

  it("F3: a HOLD that appears while an earlier stack deploys stops the next stack", () => {
    // the hold list is read by the up-front guard (1st) and again before each execute: from the 2nd read on a hold exists
    writeFileSync(join(w.dir, "ssm.get-parameters-by-path.2.json"), JSON.stringify({ Parameters: [{ Name: "/rovara-release/staging/code-hold/late" }] }));
    const r = deploy();
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("HOLD");
    expect(executes()).toHaveLength(0);
  });

  it("F4/S10: for a MANUAL approval Deploy re-reads the uploaded 89 RESULT: replaced, without READY for this sha, or missing is refused", () => {
    w.s3Put(BUCKET, key("89", "RESULT.md"), `edited after Guard\nREADY ${SHA}\n`);
    let r = deploy();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("changed after Guard read it");
    w.s3Put(BUCKET, key("89", "RESULT.md"), `NOT READY\n`);
    r = deploy();
    expect(r.stdout).toContain("[FAIL] guard-record");
    rmSync(join(w.dir, "s3", BUCKET, key("89", "RESULT.md")));
    r = deploy();
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("no uploaded 89 RESULT");
    expect(executes()).toHaveLength(0);
  });

  it("F9: a stack in CREATE_COMPLETE counts as settled (the same rule as Preview and 45-)", () => {
    writeStacks(w, { identity: "CREATE_COMPLETE" });
    const r = deploy({}, ["--dry-run"]);
    expect(r.stdout).toContain("[ OK ] stacks-settled");
  });

  it("skips a stack whose change set recorded no changes", () => {
    editDecision((d) => { const c = d.record.changeSets.find((x: any) => x.stack === stack("identity")); c.noChanges = true; c.status = "FAILED"; });
    w.answer(`cloudformation.describe-change-set.${stack("identity")}.${CS}.json`, { ChangeSetName: CS, ChangeSetId: csId("identity"), Status: "FAILED", StatusReason: "The submitted information didn't contain changes." });
    const r = deploy();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(executes().some((c) => c.includes(stack("identity")))).toBe(false);
  });

  it("stops at the first stack that does not end UPDATE_COMPLETE: later stacks are never executed", () => {
    writeFileSync(join(w.dir, "exec-result." + stack("runtime")), "UPDATE_ROLLBACK_COMPLETE");
    const r = deploy();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("DEPLOY STOP");
    expect(executes().map((c) => c.match(/--stack-name (\S+)/)?.[1])).toEqual([stack("control-plane"), stack("runtime")]);
    expect(w.calls().some((c) => c.startsWith("cloudformation delete-change-set"))).toBe(false);
  });
});

void [canonSha, mkdirSync, PREV];
