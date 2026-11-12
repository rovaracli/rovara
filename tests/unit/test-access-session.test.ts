// Customer test AWS account, lane TA2: session v2 (what moved over from the old aws-test-account.ts: the session name, the 2,048-character check, the Region condition and the regional hosts) and its refusals.
import { describe, expect, it } from "vitest";
import { connectionExternalId } from "@agentx/cloud-contracts";
import { AssumeFailureError } from "../../packages/broker/src/test-access/aws-port.js";
import { SESSION_POLICY_MAX_CHARS, TEST_ACCESS_SESSION_SECONDS, TestAccessSessionError, connectionHosts, connectionSessionPolicy, openTestAccessSession, sessionErrorMessage, sessionNameOf, type SessionDeps } from "../../packages/broker/src/test-access/session.js";
import type { ConnectionRecord } from "../../packages/broker/src/test-access/store.js";
import { ACCOUNT, OTHER_ORG, ORG, PROJECT, REGION, ROVARA_ACCOUNT, connectionExternalIdOfLast, secretParts, world, type Fixture } from "../support/test-access-fixtures.js";

const CONN = "conn_aaaaaaaaaaaaaaaaaaaa";
const connected = (over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
  orgId: ORG, connectionId: CONN, projectId: PROJECT, region: REGION, status: "connected", version: 4, externalId: connectionExternalId(ORG, CONN), createdBy: "a".repeat(64), createdAt: "2026-11-12T11:00:00.000Z", tokenExpiresAt: "2026-11-12T11:30:00.000Z",
  accountId: ACCOUNT, roleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-test-${CONN}`, cleanupRoleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-cleanup-${CONN}`, ...over,
});
function setup(over: Partial<ConnectionRecord> = {}): { w: Fixture; deps: SessionDeps } {
  const w = world();
  w.store.connections.set(`${ORG}#${CONN}`, connected(over));
  connectionExternalIdOfLast.value = connectionExternalId(ORG, CONN);
  const deps: SessionDeps = { enabled: () => w.enabled.value, store: w.store, aws: w.connectDeps.aws, now: () => w.clock.ms, rovaraAccountIds: [ROVARA_ACCOUNT], prodDeny: w.connectDeps.prodDeny };
  return { w, deps };
}
const open = (deps: SessionDeps, over: Partial<Parameters<typeof openTestAccessSession>[1]> = {}) => openTestAccessSession(deps, { orgId: ORG, connectionId: CONN, taskId: "task-1234abcd-9", runId: "ab12cd34", services: ["sqs", "dynamodb"], ...over });
const refusal = async (call: Promise<unknown>): Promise<TestAccessSessionError> => {
  const error = await call.then(() => { throw new Error("expected a refusal"); }, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(TestAccessSessionError);
  return error as TestAccessSessionError;
};

describe("opening a session", () => {
  it("assumes the stored role for an hour with the stored external id, the run tag, a task session name, and a Region-only session policy", async () => {
    const { w, deps } = setup();
    const session = await open(deps);
    expect(w.assumeCalls).toHaveLength(1);
    const call = w.assumeCalls[0]!;
    expect(call).toMatchObject({ RoleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-test-${CONN}`, ExternalId: connectionExternalId(ORG, CONN), DurationSeconds: 3_600, RoleSessionName: `rovara-task1234abcd9-${ACCOUNT}`, Tags: [{ Key: "rovara-run", Value: "ab12cd34" }] });
    expect(Object.keys(call).sort()).toEqual(["DurationSeconds", "ExternalId", "Policy", "RoleArn", "RoleSessionName", "Tags"]);
    const policy = JSON.parse(call.Policy as string) as { Statement: Array<Record<string, unknown>> };
    expect(policy.Statement[1]).toMatchObject({ Effect: "Deny", Condition: { StringNotEquals: { "aws:RequestedRegion": REGION } } });
    expect(JSON.stringify(policy.Statement[1]!["NotAction"])).toContain("iam:*");
    expect(session).toMatchObject({ region: REGION, accountId: ACCOUNT, runId: "ab12cd34", hosts: [`dynamodb.${REGION}.amazonaws.com`, `sqs.${REGION}.amazonaws.com`, `sts.${REGION}.amazonaws.com`] });
    expect(session.expiresAtMs).toBe(w.clock.ms + TEST_ACCESS_SESSION_SECONDS * 1_000);
    expect(JSON.stringify({ ...session, credentials: undefined })).not.toContain(secretParts().secretAccessKey);
  });

  it("opens the cleanup role for cleanup, also while suspended or needing attention, but never for a run", async () => {
    for (const status of ["suspended", "needs_attention", "connected"] as const) {
      const { w, deps } = setup({ status });
      await open(deps, { purpose: "cleanup" });
      expect(w.assumeCalls[0]!.RoleArn).toBe(`arn:aws:iam::${ACCOUNT}:role/rovara-cleanup-${CONN}`);
    }
    for (const status of ["suspended", "needs_attention", "awaiting", "polling", "reported", "confirmed", "disconnected", "failed"] as const) {
      const { w, deps } = setup({ status });
      expect((await refusal(open(deps))).code, status).toBe("not_usable");
      expect(w.assumeCalls).toHaveLength(0);
    }
    for (const status of ["awaiting", "disconnected", "failed", "reported"] as const) expect((await refusal(open(setup({ status }).deps, { purpose: "cleanup" }))).code, status).toBe("not_usable");
  });

  it("is off with the ta switch: not found, before any read or AWS call", async () => {
    const { w, deps } = setup();
    w.enabled.value = false;
    await expect(open(deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(w.assumeCalls).toHaveLength(0);
  });

  it("another organization's connection is not usable, the same as a missing one, and nothing is sent", async () => {
    const { w, deps } = setup();
    expect((await refusal(open(deps, { orgId: OTHER_ORG }))).code).toBe("not_usable");
    expect((await refusal(open(deps, { connectionId: "conn_zzzzzzzzzzzzzzzzzzzz" }))).code).toBe("not_usable");
    expect(w.assumeCalls).toHaveLength(0);
  });

  it("refuses a stored record that is not what the template makes, before any AWS call, with a fixed word", async () => {
    const wrongName = `arn:aws:iam::${ACCOUNT}:role/admin`;
    const cases: Array<[string, Record<string, unknown>]> = [
      ["bad_role", { roleArn: wrongName }],
      ["bad_role", { roleArn: `arn:aws:iam::${ROVARA_ACCOUNT}:role/rovara-test-${CONN}` }],
      ["bad_role", { accountId: "555566667777" }],
      ["bad_role", { accountId: undefined }],
      ["bad_role", { roleArn: undefined }],
      ["bad_role", { region: "nowhere" }],
      ["external_id", { externalId: connectionExternalId(OTHER_ORG, CONN) }],
      ["external_id", { externalId: "ext-0123456789" }],
      ["external_id", { externalId: connectionExternalId(ORG, "conn_zzzzzzzzzzzzzzzzzzzz") }],
      ["own_account", { accountId: ROVARA_ACCOUNT, roleArn: `arn:aws:iam::${ROVARA_ACCOUNT}:role/rovara-test-${CONN}` }],
      ["production", { accountId: "111122223333", roleArn: `arn:aws:iam::111122223333:role/rovara-test-${CONN}` }],
    ];
    for (const [expected, over] of cases) {
      const { w, deps } = setup(over);
      const error = await refusal(open(deps));
      expect(error.code, JSON.stringify(over)).toBe(expected);
      expect(w.assumeCalls).toHaveLength(0);
      for (const word of [ACCOUNT, ROVARA_ACCOUNT, "arn:", "rovara-org"]) expect(error.message).not.toContain(word);
    }
  });

  it("refuses when the production list cannot be read, and when the deployment's own accounts are unknown", async () => {
    const { w, deps } = setup();
    w.prodDeny.value = new Error("unavailable");
    expect((await refusal(open(deps))).code).toBe("production");
    w.prodDeny.value = { accountIds: [], hosts: [], arnPrefixes: [] };
    expect((await refusal(open({ ...deps, rovaraAccountIds: [] }))).code).toBe("own_account");
    expect(w.assumeCalls).toHaveLength(0);
  });

  it("refuses a bad run id and a service outside the default list", async () => {
    const { w, deps } = setup();
    for (const runId of ["short", "ABCD1234", "ab12cd3!", "ab12cd345", ""]) expect((await refusal(open(deps, { runId }))).code, runId).toBe("bad_run");
    expect((await refusal(open(deps, { services: ["apigateway"] }))).code).toBe("bad_service");
    expect((await refusal(open(deps, { services: ["kms"] }))).code).toBe("bad_service");
    expect(w.assumeCalls).toHaveLength(0);
  });

  it("maps an AWS refusal and an AWS outage to fixed words, and never shows what AWS said", async () => {
    const { w, deps } = setup();
    w.aws.assume = () => { throw new AssumeFailureError("refused"); };
    const refused = await refusal(open(deps));
    expect(refused).toMatchObject({ code: "refused", retryable: false });
    w.aws.assume = () => { throw new Error("AccessDenied: not authorized to perform sts:AssumeRole on arn:aws:iam::222233334444:role/x"); };
    const down = await refusal(open(deps));
    expect(down).toMatchObject({ code: "unreachable", retryable: true });
    expect(down.message).not.toContain("222233334444");
    expect(sessionErrorMessage(new Error("raw"))).toBe(down.message);
  });

  it("refuses credentials that are incomplete, already over, or longer than the hour asked for", async () => {
    const { w, deps } = setup();
    const answer = (over: Record<string, unknown>) => () => ({ credentials: { ...secretParts(), expiration: new Date(w.clock.ms + 3_600_000), ...over }, assumedRoleArn: undefined });
    for (const over of [{ accessKeyId: "" }, { secretAccessKey: "" }, { sessionToken: "" }, { expiration: new Date(w.clock.ms - 1) }, { expiration: new Date(w.clock.ms + 3 * 3_600_000) }, { expiration: new Date(Number.NaN) }, { expiration: "tomorrow" }]) {
      w.aws.assume = answer(over);
      expect((await refusal(open(deps))).code, JSON.stringify(over)).toBe("bad_session");
    }
    w.aws.assume = () => ({ credentials: undefined, assumedRoleArn: undefined }) as never;
    expect((await refusal(open(deps))).code).toBe("bad_session");
  });
});

describe("the pieces that moved over", () => {
  it("the session name is a fixed shape of two stripped identifiers, 64 characters at most, with nothing a person typed", () => {
    expect(sessionNameOf("TASK 12/34\n; drop table", ACCOUNT)).toBe(`rovara-TASK1234droptabl-${ACCOUNT}`);
    expect(sessionNameOf("x".repeat(200), "9".repeat(50)).length).toBeLessThanOrEqual(64);
    expect(sessionNameOf("", "")).toBe("rovara-task-account");
    expect(sessionNameOf("a b", ACCOUNT)).toMatch(/^[\w+=,.@-]{2,64}$/u);
  });

  it("the session policy is checked against 2,048 characters and carries the Region condition", () => {
    const policy = connectionSessionPolicy("ap-southeast-2");
    expect(policy.length).toBeLessThanOrEqual(SESSION_POLICY_MAX_CHARS);
    expect((JSON.parse(policy) as { Statement: Array<{ Condition: unknown }> }).Statement[1]!.Condition).toEqual({ StringNotEquals: { "aws:RequestedRegion": "ap-southeast-2" } });
    expect(() => connectionSessionPolicy("us-west-2\"}")).toThrow(TestAccessSessionError);
    expect(() => connectionSessionPolicy("")).toThrow(TestAccessSessionError);
  });

  it("the hosts are the regional endpoints of exactly the planned services, IAM is global, and nothing is a wildcard", () => {
    expect(connectionHosts("eu-west-1", ["s3", "iam", "tag", "states"])).toEqual(["iam.amazonaws.com", "s3.eu-west-1.amazonaws.com", "states.eu-west-1.amazonaws.com", "sts.eu-west-1.amazonaws.com", "tagging.eu-west-1.amazonaws.com"]);
    expect(connectionHosts("eu-west-1", [])).toEqual(["sts.eu-west-1.amazonaws.com"]);
    for (const host of connectionHosts("us-west-2", ["sqs"])) expect(host).not.toContain("*");
    expect(() => connectionHosts("us-west-2", ["sqs.evil.example.com"])).toThrow(TestAccessSessionError);
    expect(() => connectionHosts("us-west-2", ["*"])).toThrow(TestAccessSessionError);
    expect(() => connectionHosts("evil", ["sqs"])).toThrow(TestAccessSessionError);
  });
});

describe("a stored record with a connection id that Rovara did not make", () => {
  it("is refused as a bad role, with no AWS call, not thrown as a validation error", async () => {
    const { w, deps } = setup({ connectionId: "conn_NOT-A-VALID-ID" });
    w.store.connections.set(`${ORG}#conn_NOT-A-VALID-ID`, connected({ connectionId: "conn_NOT-A-VALID-ID" }));
    const error = await refusal(openTestAccessSession(deps, { orgId: ORG, connectionId: "conn_NOT-A-VALID-ID", taskId: "t", runId: "ab12cd34", services: [] }));
    expect(error.code).toBe("bad_role");
    expect(w.assumeCalls).toHaveLength(0);
  });
});
