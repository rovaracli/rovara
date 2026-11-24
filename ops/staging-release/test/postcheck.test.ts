/* eslint-disable @typescript-eslint/no-unsafe-member-access -- the tests read the JSON records the scripts write and edit plain JSON documents, which a typed document would not allow */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, runPack, type World } from "./support/harness.ts";
import { BUCKET, EXEC8, EXEC_ID, PARTS, PIPE_ENV, PREV, SHA, SLACK_URI, WORKER_URI, liveParams, stack, writePackage, writePointers, writeRunRecords, writeStacks } from "./support/fixtures.ts";

let w: World;
const world = (): void => {
  const pkg = writePackage(join(w.work, "release"));
  writeRunRecords(w, pkg);
  w.s3Put(BUCKET, `release/${EXEC_ID}/deploy.json`, JSON.stringify({ ok: true, sha: SHA, execution: EXEC_ID, finishedAt: "2026-11-23T12:00:00Z" }));
  writeStacks(w);
  // after the deploy the image parameters carry the run's images
  for (const [part, key, uri] of [["runtime", "WorkerImageUri", WORKER_URI], ["slack", "OrchestratorImageUri", SLACK_URI]] as const) {
    w.answer(`cloudformation.describe-stacks.${stack(part)}.json`, { Stacks: [{ StackStatus: "UPDATE_COMPLETE", Parameters: liveParams(part).map((p) => (p.ParameterKey === key ? { ...p, ParameterValue: uri } : p)), Outputs: [] }] });
  }
  w.answer(`cloudformation.list-stack-resources.${stack("control-plane")}.json`, { StackResourceSummaries: [{ ResourceType: "AWS::Lambda::Function", PhysicalResourceId: "fn-broker" }, { ResourceType: "AWS::SSM::Parameter", PhysicalResourceId: "p" }] });
  w.answer("lambda.get-function-configuration.fn-broker.json", { FunctionName: "fn-broker", State: "Active", LastUpdateStatus: "Successful", Environment: { Variables: { K: "secret-value" } } });
  w.answer("cloudwatch.get-metric-statistics.json", { Datapoints: [] });
  w.answer(`cloudformation.list-stack-resources.${stack("slack")}.json`, { StackResourceSummaries: [{ ResourceType: "AWS::ECS::Service", PhysicalResourceId: "svc" }, { ResourceType: "AWS::ECS::Cluster", PhysicalResourceId: "cl" }] });
  w.answer("ecs.describe-services.json", { services: [{ status: "ACTIVE", desiredCount: 1, runningCount: 1, deployments: [{ rolloutState: "COMPLETED" }] }] });
  writePointers(w);
  w.answer("cloudformation.describe-stack-events.json", { StackEvents: [] });
  writeFileSync(join(w.dir, "curl.code"), "200");
};
const env = (): Record<string, string> => ({ ...PIPE_ENV(w), POSTCHECK_WATCH_MINUTES: "0", POSTCHECK_SLEEP_SECONDS: "0", SLACK_ROLLOUT_WAIT_SECONDS: "0", JWKS_URL: "https://api.example.test/jwks" });
const run = (extra: Record<string, string> = {}) => runPack(w, "postcheck.sh", { ...env(), ...extra });
const puts = (): string[] => w.calls().filter((c) => c.startsWith("ssm put-parameter"));
beforeEach(() => { w = makeWorld(); world(); });
afterEach(() => w.cleanup());

describe("postcheck.sh", () => {
  it("passes a healthy deploy, writes the installed pointer, and prints no Lambda environment", () => {
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("POSTCHECK 0 FAIL");
    const p = puts();
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("--name /rovara-release/staging/code-installed");
    expect(p[0]).toContain(`--value ${SHA}`);
    expect(r.stdout + r.stderr).not.toContain("secret-value");
    expect(JSON.parse(readFileSync(join(w.work, "out/postcheck.json"), "utf8")).settingsRecord).toContain("not written by the pipeline");
  });
  it("an image parameter that is not the run's image fails, sets a HOLD and leaves the pointer alone", () => {
    w.answer(`cloudformation.describe-stacks.${stack("runtime")}.json`, { Stacks: [{ StackStatus: "UPDATE_COMPLETE", Parameters: liveParams("runtime"), Outputs: [] }] });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("[FAIL] WorkerImageUri on runtime");
    const p = puts();
    expect(p).toHaveLength(1);
    expect(p[0]).toContain(`--name /rovara-release/staging/code-hold/postcheck-${EXEC8}`);
    expect(p.some((c) => c.includes("code-installed"))).toBe(false);
  });
  it("Lambda errors after the deploy fail it", () => {
    w.answer("cloudwatch.get-metric-statistics.json", { Datapoints: [{ Sum: 3 }] });
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Lambda Errors = 3");
  });
  it("a Lambda that is not Active/Successful, a failing JWKS, a slack service that is not steady and a stack with a change set left each fail it", () => {
    w.answer("lambda.get-function-configuration.fn-broker.json", { State: "Active", LastUpdateStatus: "Failed" });
    expect(run().stdout).toContain("[FAIL] Lambda fn-broker");
    world();
    writeFileSync(join(w.dir, "curl.code"), "500");
    expect(run().stdout).toContain("[FAIL] public JWKS answered 500");
    world();
    w.answer("ecs.describe-services.json", { services: [{ status: "ACTIVE", desiredCount: 2, runningCount: 1, deployments: [{ rolloutState: "COMPLETED" }] }] });
    expect(run().stdout).toContain("[FAIL] ECS service not steady");
    world();
    w.answer(`cloudformation.list-change-sets.${stack("access")}.json`, { Summaries: [{ ChangeSetName: `rovara-pipeline-${EXEC8}` }] });
    expect(run().stdout).toContain("still has 1 pipeline change set");
  });
  it("an unexpected DELETE_FAILED fails; the expected control-plane leftovers do not", () => {
    const ev = (id: string): object => ({ StackEvents: [{ ResourceType: "AWS::EC2::Subnet", LogicalResourceId: id, ResourceStatus: "DELETE_FAILED" }, { ResourceType: "AWS::CloudFormation::Stack", ResourceStatus: "UPDATE_IN_PROGRESS" }] });
    w.answer(`cloudformation.describe-stack-events.${stack("control-plane")}.json`, ev("EmbedderSubnet1"));
    expect(run().status).toBe(0);
    world();
    w.answer(`cloudformation.describe-stack-events.${stack("control-plane")}.json`, ev("SomethingImportant"));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("unexpected DELETE_FAILED: SomethingImportant");
  });
  it("a moved ApiEndpoint output fails it", () => {
    w.answer(`cloudformation.describe-stacks.${stack("control-plane")}.json`, { Stacks: [{ StackStatus: "UPDATE_COMPLETE", Parameters: liveParams("control-plane"), Outputs: [{ OutputKey: "ApiEndpoint", OutputValue: "https://moved.example.test" }] }] });
    expect(run().stdout).toContain("output ApiEndpoint moved");
  });
  it("does not move the pointer when it changed while this release deployed", () => {
    writePointers(w, "d".repeat(40));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("installed pointer moved");
    expect(puts().some((c) => c.includes("code-installed"))).toBe(false);
  });
  it("refuses without Deploy's ok record for this sha", () => {
    w.s3Put(BUCKET, `release/${EXEC_ID}/deploy.json`, JSON.stringify({ ok: true, sha: "c".repeat(40), finishedAt: "2026-11-23T12:00:00Z" }));
    expect(run().status).toBe(3);
    expect(existsSync(join(w.work, "out/postcheck.json"))).toBe(false);
  });
});
void [PARTS, PREV];
