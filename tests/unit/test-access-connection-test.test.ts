// Customer test AWS account, lane TA2: the connection test, check by check, with a fake AWS that can fail each one.
import { describe, expect, it } from "vitest";
import { connectionExternalId } from "@agentx/cloud-contracts";
import { AssumeFailureError, type AccountCalls } from "../../packages/broker/src/test-access/aws-port.js";
import { runConnectionTest } from "../../packages/broker/src/test-access/connection-test.js";
import type { ConnectionRecord } from "../../packages/broker/src/test-access/store.js";
import { ACCOUNT, NOW, ORG, PROJECT, REGION, ROVARA_ACCOUNT, connectionExternalIdOfLast, makeCalls, world } from "../support/test-access-fixtures.js";

const CONN = "conn_aaaaaaaaaaaaaaaaaaaa";
const record = (over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
  orgId: ORG, connectionId: CONN, projectId: PROJECT, region: REGION, status: "confirmed", version: 3, externalId: connectionExternalId(ORG, CONN), createdBy: "a".repeat(64), createdAt: "2026-11-12T11:00:00.000Z", tokenExpiresAt: "2026-11-12T11:30:00.000Z",
  accountId: ACCOUNT, roleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-test-${CONN}`, cleanupRoleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-cleanup-${CONN}`, ...over,
});

function run(calls: Partial<AccountCalls> = {}, over: Partial<ConnectionRecord> = {}, services?: string[]) {
  const w = world();
  connectionExternalIdOfLast.value = connectionExternalId(ORG, CONN);
  w.aws.calls = makeCalls(calls, w.aws.sent);
  const deps = { aws: w.connectDeps.aws, now: () => NOW, rovaraAccountIds: [ROVARA_ACCOUNT], prodDeny: w.connectDeps.prodDeny, runId: () => "ab12cd34", otherName: () => "rovara-conntest-not-ours-xxxx" };
  return { w, outcome: runConnectionTest(deps, record(over), services) };
}
const statusOf = (result: { checks: Array<{ id: string; status: string; code?: string }> }, id: string) => result.checks.find((check) => check.id === id);

describe("the connection test", () => {
  it("passes on a correctly made role, and reports the alias, with the checks in order and the calls it made", async () => {
    const { w, outcome } = run({}, {}, ["sqs", "dynamodb"]);
    const { result, alias } = await outcome;
    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => `${check.id}:${check.status}`)).toEqual(["assumes:pass", "external_id_required:pass", "limits_attached:pass", "services_reachable:pass", "creates_and_deletes_own:pass", "cannot_touch_others:pass", "not_production:pass"]);
    expect(alias).toBe("beta-shared");
    // The run tag names everything the test creates; the other queue's name is not the run's.
    expect(w.aws.sent).toContain(`create:rv-ab12cd34-conntest`);
    expect(w.aws.sent).toContain("delete-name:rovara-conntest-not-ours-xxxx");
    expect(w.assumeCalls[0]).toMatchObject({ ExternalId: connectionExternalId(ORG, CONN), Tags: [{ Key: "rovara-run", Value: "ab12cd34" }] });
    expect(w.assumeCalls[1]).toEqual({ RoleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-test-${CONN}`, RoleSessionName: "rovara-connection-test-noext", DurationSeconds: 900 });
    expect(JSON.stringify(result)).not.toContain(ACCOUNT);
  });

  it("fails when the role can be assumed without the external id (a confused-deputy hole)", async () => {
    const { w, outcome } = run();
    w.aws.assume = (request) => ({ credentials: { accessKeyId: "a", secretAccessKey: "b", sessionToken: "c", expiration: new Date(NOW + 3_600_000) }, assumedRoleArn: `arn:aws:sts::${ACCOUNT}:assumed-role/x/${request.RoleSessionName}` });
    const { result } = await outcome;
    expect(result.passed).toBe(false);
    expect(statusOf(result, "external_id_required")).toMatchObject({ status: "fail", code: "role_open_without_external_id" });
  });

  it("when the role cannot be assumed at all, only that check fails and every other is skipped with no AWS call", async () => {
    const { w, outcome } = run();
    w.aws.assume = () => { throw new AssumeFailureError("refused"); };
    const { result } = await outcome;
    expect(result.passed).toBe(false);
    expect(statusOf(result, "assumes")).toMatchObject({ status: "fail", code: "refused" });
    expect(result.checks.filter((check) => check.status === "skipped")).toHaveLength(6);
    expect(w.aws.sent).toEqual([]);
  });

  it("an unreachable AWS is not a refusal", async () => {
    const { w, outcome } = run();
    w.aws.assume = () => { throw new Error("socket hang up"); };
    expect(statusOf((await outcome).result, "assumes")).toMatchObject({ status: "fail", code: "unreachable" });
  });

  it("fails when either role lacks the permissions boundary", async () => {
    for (const bad of [undefined, `arn:aws:iam::${ACCOUNT}:policy/other`, `arn:aws:iam::${ACCOUNT}:policy/rovara-test-boundary-${connectionExternalId(ORG, "conn_zzzzzzzzzzzzzzzzzzzz")}`]) {
      const { result } = await run({ roleBoundary: (name) => Promise.resolve(name.startsWith("rovara-cleanup") ? bad : `arn:aws:iam::${ACCOUNT}:policy/rovara-test-boundary-${connectionExternalId(ORG, CONN)}`) }).outcome;
      expect(statusOf(result, "limits_attached"), String(bad)).toMatchObject({ status: "fail", code: "boundary_missing" });
    }
    expect(statusOf((await run({ roleBoundary: () => Promise.reject(new Error("x")) }).outcome).result, "limits_attached")?.status).toBe("fail");
  });

  it("a service the account's own policy blocks is a warning that names the service, not a failure; an outage is a failure", async () => {
    const { result } = await run({ probeService: (service) => Promise.resolve(service === "athena" ? "scp_blocked" : service === "ssm" ? "no_access" : "ok") }, {}, ["sqs", "athena", "ssm"]).outcome;
    expect(result.passed).toBe(true);
    expect(statusOf(result, "services_reachable")).toEqual({ id: "services_reachable", status: "warn", code: "blocked", services: ["athena", "ssm"] });
    const down = await run({ probeService: (service) => Promise.resolve(service === "sqs" ? "ok" : "unreachable") }, {}, ["sqs", "dynamodb"]).outcome;
    expect(down.result.passed).toBe(false);
    expect(statusOf(down.result, "services_reachable")).toMatchObject({ status: "fail", code: "unreachable" });
  });

  it("when SQS is blocked the queue checks are skipped, not failed", async () => {
    const { w, outcome } = run({ probeService: (service) => Promise.resolve(service === "sqs" ? "scp_blocked" : "ok") }, {}, ["sqs"]);
    const { result } = await outcome;
    expect(result.passed).toBe(true);
    expect(statusOf(result, "creates_and_deletes_own")).toMatchObject({ status: "skipped", code: "sqs_not_reachable" });
    expect(w.aws.sent.some((line) => line.startsWith("create:"))).toBe(false);
  });

  it("fails when the role cannot create its own queue, and when it cannot delete it, handing the leftover back", async () => {
    const denied = await run({ createQueue: () => Promise.resolve({ ok: false, code: "denied" }) }).outcome;
    expect(statusOf(denied.result, "creates_and_deletes_own")).toMatchObject({ status: "fail", code: "create_denied" });
    const stuck = await run({ deleteQueueByUrl: () => Promise.resolve("denied") }).outcome;
    expect(statusOf(stuck.result, "creates_and_deletes_own")).toMatchObject({ status: "fail", code: "delete_failed" });
    expect(stuck.result.leftover).toBe(`https://sqs.${REGION}.amazonaws.com/${ACCOUNT}/rv-ab12cd34-conntest`);
    const gone = await run({ deleteQueueByUrl: () => Promise.reject(new Error("net")) }).outcome;
    expect(gone.result.leftover).toBeDefined();
  });

  it("fails when the role can delete a queue that is not its run's (IAM let the call through to the service)", async () => {
    for (const answer of ["not_found", "deleted"] as const) {
      const { result } = await run({ deleteQueueByName: () => Promise.resolve(answer) }).outcome;
      expect(statusOf(result, "cannot_touch_others"), answer).toMatchObject({ status: "fail", code: "fence_missing" });
    }
    expect(statusOf((await run({ deleteQueueByName: () => Promise.resolve("error") }).outcome).result, "cannot_touch_others")).toMatchObject({ status: "fail", code: "unreachable" });
  });

  it("an alias that says production fails until the admin's tick is stored", async () => {
    const prod = { listAccountAliases: () => Promise.resolve(["acme-prod"]) };
    expect(statusOf((await run(prod).outcome).result, "not_production")).toMatchObject({ status: "fail", code: "alias_says_production" });
    expect((await run(prod, { notProductionAck: true }).outcome).result.passed).toBe(true);
  });

  it("a refused alias read is no alias, not a failure", async () => {
    const { result, alias } = await run({ listAccountAliases: () => Promise.reject(new Error("denied")) }).outcome;
    expect(result.passed).toBe(true);
    expect(alias).toBeUndefined();
  });

  it("refuses to test a record that is not what the template makes, with no AWS call", async () => {
    const { w, outcome } = run({}, { roleArn: `arn:aws:iam::${ACCOUNT}:role/admin` });
    const { result } = await outcome;
    expect(statusOf(result, "assumes")).toMatchObject({ status: "fail", code: "bad_role" });
    expect(w.assumeCalls).toHaveLength(0);
  });
});
