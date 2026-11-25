// Opus reviewer's tests (L6 review, uncommitted): exactly-one RunTask on a real stale run, the refresh must be AFTER the gate began,
// a dry run touches neither ECS nor EventBridge, and gateway-digest-equal on a release dry run (no digest yet) fails rather than passes.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gate as digestEqual } from "../../ops/pipeline/gates/gateway-digest-equal.gate.ts";
import { gate as priceFresh } from "../../ops/pipeline/gates/price-freshness.gate.ts";
import type { GateInput, Manifest } from "../../ops/pipeline/types.ts";
import { DIGEST_A, EXEC8, EXEC_ID, FAKE_ACCOUNT, config, sha, stackFor } from "./pipeline-stage-fakes.ts";
import { REGION, T0, makeHarness } from "./pipeline-image-price-fakes.ts";

const h = makeHarness();
afterAll(() => { h.restorePath(); });
const manifest = (digest: string | null): Manifest => ({
  schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "2026-11-24T12:00:00.000Z", mode: "release",
  cloud: { tag: "v0.13.10", sha: sha("4"), ref: "latest-tag", trunk: "cloud/next", liveSha: { beta: null, production: null } },
  code: { sha: null, release: "run", requestedRelease: "run", pinnedSha: { beta: null, production: null }, supersedes: null },
  gateway: { digest, source: null, imageTag: null, repository: null }, stages: {},
});
const input = (m: Manifest, dryRun?: boolean): GateInput => ({
  env: "beta", phase: "proof", region: REGION, config, manifest: m, changeSets: [], dirs: { pipeline: "/p", cloud: null, out: "/out", work: "/w" }, ports: h.ports("beta"), log: () => undefined, ...(dryRun === true ? { dryRun } : {}),
});
const ARN = `arn:aws:ecs:${REGION}:${FAKE_ACCOUNT}:cluster/Cluster1`;
beforeEach(() => {
  h.scenario = { ...h.scenario, stacks: { [stackFor("beta", "gateway")]: { parameters: { ImageDigest: DIGEST_A } } }, ecr: {}, ecrDigests: {}, logEvents: [], eventsAfterRunTask: [],
    resources: [
      { LogicalResourceId: "ClusterEB0386A7", ResourceType: "AWS::ECS::Cluster", PhysicalResourceId: "Cluster1" },
      { LogicalResourceId: "PriceFetchTask7EDA4B48", ResourceType: "AWS::ECS::TaskDefinition", PhysicalResourceId: "td-arn" },
      { LogicalResourceId: "PriceFetchScheduleAD6AA82A", ResourceType: "AWS::Events::Rule", PhysicalResourceId: "the-rule" },
      { LogicalResourceId: "PriceFetchLogs58DAA624", ResourceType: "AWS::Logs::LogGroup", PhysicalResourceId: "the-log-group" },
    ],
    targets: { Targets: [{ Arn: ARN, EcsParameters: { LaunchType: "FARGATE", NetworkConfiguration: { awsvpcConfiguration: { Subnets: ["s"], SecurityGroups: ["g"], AssignPublicIp: "ENABLED" } } } }] },
    runTask: { tasks: [{ taskArn: "t" }], failures: [] },
    describeTasks: [{ tasks: [{ lastStatus: "STOPPED", containers: [{ exitCode: 0 }] }] }],
  };
  h.write();
  h.reset();
});

describe("L6 review: price-freshness", () => {
  it("a real stale run starts exactly ONE task, and a fetch logged before the gate began does not count as the refresh", async () => {
    h.scenario.logEvents = [T0 - 49 * 3_600_000];
    h.scenario.eventsAfterRunTask = [T0 - 60_000]; // inside 48 h but before this gate began: not proof the one-off fetch worked
    h.write();
    const outcome = await priceFresh.run(input(manifest(DIGEST_A)));
    expect(outcome.result).toBe("fail");
    expect(outcome.failures![0]).toMatch(/exited 0 but no price_fetched event/);
    const lines = h.lines();
    expect(lines.filter((l) => l.startsWith("aws ecs run-task"))).toHaveLength(1);
  });
  it("a dry run with stale prices calls neither ECS nor EventBridge, and is skipped (never pass)", async () => {
    h.scenario.logEvents = [T0 - 49 * 3_600_000];
    h.write();
    const outcome = await priceFresh.run(input(manifest(DIGEST_A), true));
    expect(outcome.result).toBe("skipped");
    expect(h.lines().some((l) => l.startsWith("aws ecs") || l.startsWith("aws events"))).toBe(false);
  });
});

describe("L6 review: gateway-digest-equal on a release dry run", () => {
  it("a dry run (no digest yet, the image step skipped) reports skipped with a clear reason, never a pass and never a failure that blocks the dry run (S4)", async () => {
    const outcome = await digestEqual.run(input(manifest(null), true));
    expect(outcome).toEqual({ result: "skipped", skippedReason: "dry run: no image built" });
  });
});
