// Customer test AWS account, lane TA2: the polling fallback. Every 10 seconds for 30 minutes, one AssumeRole with the stored external id and nothing else.
import { describe, expect, it } from "vitest";
import { connectionExternalId } from "@agentx/cloud-contracts";
import { AssumeFailureError } from "../../packages/broker/src/test-access/aws-port.js";
import { POLL_INTERVAL_MS, POLL_WINDOW_MS, startConnection, submitAccountId } from "../../packages/broker/src/test-access/connect.js";
import { POLL_SESSION_NAME, pollDue } from "../../packages/broker/src/test-access/poll.js";
import { ACCOUNT, OTHER_ACCOUNT, ORG, PROJECT, REGION, caller, connectionExternalIdOfLast, world, type Fixture } from "../support/test-access-fixtures.js";

async function polling(w: Fixture, accountId = ACCOUNT) {
  const started = await startConnection(w.connectDeps, caller(), { projectId: PROJECT, region: REGION });
  connectionExternalIdOfLast.value = connectionExternalId(ORG, started.connection.connectionId);
  await submitAccountId(w.connectDeps, caller(), started.connection.connectionId, { accountId });
  return started.connection.connectionId;
}
const rec = (w: Fixture, id: string) => w.store.connections.get(`${ORG}#${id}`)!;
const refuse = (): never => { throw new AssumeFailureError("refused"); };

describe("the poll", () => {
  it("assumes the role the template names with the stored external id, no run tag and no policy, and nothing else, until the role answers", async () => {
    const w = world();
    const id = await polling(w);
    w.aws.assume = refuse;
    expect(await pollDue(w.connectDeps)).toEqual({ polled: 1, found: 0, expired: 0, skipped: 0 });
    expect(w.assumeCalls).toEqual([{ RoleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-test-${id}`, RoleSessionName: POLL_SESSION_NAME, ExternalId: connectionExternalId(ORG, id), DurationSeconds: 900 }]);
    expect(rec(w, id).status).toBe("polling");
  });

  it("when the role answers it records the account as confirmed by the admin's typed id, runs the connection test, and stops polling", async () => {
    const w = world();
    const id = await polling(w);
    w.clock.ms += POLL_INTERVAL_MS;
    expect(await pollDue(w.connectDeps)).toMatchObject({ polled: 1, found: 1 });
    expect(rec(w, id)).toMatchObject({ status: "connected", accountId: ACCOUNT, reportedVia: "account_id", confirmedBy: "a".repeat(64), roleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-test-${id}`, cleanupRoleArn: `arn:aws:iam::${ACCOUNT}:role/rovara-cleanup-${id}` });
    expect(rec(w, id)).not.toHaveProperty("pollAccountId");
    expect(w.store.polling.size).toBe(0);
    expect(w.store.audits.map((event) => event.action)).toEqual(["test_access.connection_started", "test_access.connection_confirmed", "test_access.connection_tested"]);
    expect(w.store.audits[1]).toMatchObject({ actor: { kind: "system" }, facts: { via: "account_id" } });
  });

  it("holds the rate: a driver that ticks often makes at most one attempt per ten seconds", async () => {
    const w = world();
    const id = await polling(w);
    w.aws.assume = refuse;
    await pollDue(w.connectDeps);
    for (let index = 0; index < 5; index += 1) { w.clock.ms += 1_000; expect((await pollDue(w.connectDeps)).polled).toBe(0); }
    w.clock.ms += POLL_INTERVAL_MS;
    expect((await pollDue(w.connectDeps)).polled).toBe(1);
    expect(w.assumeCalls).toHaveLength(2);
    expect(rec(w, id).status).toBe("polling");
  });

  it("ends the connection as failed after the 30-minute window, with the cause, and makes no attempt", async () => {
    const w = world();
    const id = await polling(w);
    w.aws.assume = refuse;
    w.clock.ms += POLL_WINDOW_MS;
    expect(await pollDue(w.connectDeps)).toEqual({ polled: 0, found: 0, expired: 1, skipped: 0 });
    expect(rec(w, id)).toMatchObject({ status: "failed", endCause: "poll_timeout" });
    expect(w.assumeCalls).toHaveLength(0);
    expect(w.store.polling.size).toBe(0);
    expect(w.store.audits.at(-1)).toMatchObject({ action: "test_access.connection_ended", facts: { cause: "poll_timeout" } });
  });

  it("does not accept a role that answers as another role or account, and keeps waiting", async () => {
    for (const assumedRoleArn of [undefined, `arn:aws:sts::${OTHER_ACCOUNT}:assumed-role/rovara-test-conn_x/${POLL_SESSION_NAME}`, `arn:aws:sts::${ACCOUNT}:assumed-role/admin/${POLL_SESSION_NAME}`, `arn:aws:sts::${ACCOUNT}:assumed-role/x/other`]) {
      const w = world();
      const id = await polling(w);
      w.aws.assume = () => ({ credentials: { accessKeyId: "a", secretAccessKey: "b", sessionToken: "c", expiration: new Date(w.clock.ms + 900_000) }, assumedRoleArn });
      w.clock.ms += POLL_INTERVAL_MS;
      expect(await pollDue(w.connectDeps), String(assumedRoleArn)).toMatchObject({ polled: 1, found: 0 });
      expect(rec(w, id).status).toBe("polling");
    }
  });

  it("an outage and an access-denied are the same: wait for the next tick", async () => {
    const w = world();
    const id = await polling(w);
    w.aws.assume = () => { throw new Error("socket hang up"); };
    expect((await pollDue(w.connectDeps)).found).toBe(0);
    expect(rec(w, id).status).toBe("polling");
  });

  it("re-reads the production list, and refuses Rovara's own accounts, before every attempt", async () => {
    const w = world();
    const id = await polling(w);
    w.prodDeny.value = { accountIds: [ACCOUNT], hosts: [], arnPrefixes: [] };
    w.clock.ms += POLL_INTERVAL_MS;
    expect(await pollDue(w.connectDeps)).toMatchObject({ polled: 1, found: 0, skipped: 1 });
    expect(w.assumeCalls).toHaveLength(0);
    expect(rec(w, id).status).toBe("polling");
  });

  it("a production list that cannot be read skips that attempt without an AWS call and without stopping the others", async () => {
    const w = world();
    const first = await polling(w);
    const second = await polling(w);
    w.prodDeny.value = new Error("unavailable");
    w.clock.ms += POLL_INTERVAL_MS;
    expect(await pollDue(w.connectDeps)).toMatchObject({ polled: 2, found: 0, skipped: 2 });
    expect(w.assumeCalls).toHaveLength(0);
    expect([rec(w, first).status, rec(w, second).status]).toEqual(["polling", "polling"]);
  });

  it("two drivers at once make one attempt, and a callback that won the race is not overwritten", async () => {
    const w = world();
    const id = await polling(w);
    w.aws.assume = refuse;
    const [first, second] = await Promise.all([pollDue(w.connectDeps), pollDue(w.connectDeps)]);
    expect(first.polled + second.polled).toBe(1);
    expect(w.assumeCalls).toHaveLength(1);
    // The role answers, but the connection moved (a callback reported it) between the read and the write.
    w.clock.ms += POLL_INTERVAL_MS;
    w.aws.assume = (request) => {
      Object.assign(rec(w, id), { status: "reported", version: rec(w, id).version + 1, accountId: ACCOUNT });
      return { credentials: { accessKeyId: "a", secretAccessKey: "b", sessionToken: "c", expiration: new Date(w.clock.ms + 900_000) }, assumedRoleArn: `arn:aws:sts::${ACCOUNT}:assumed-role/${request.RoleArn.split("/").pop()}/${request.RoleSessionName}` };
    };
    expect((await pollDue(w.connectDeps)).found).toBe(0);
    expect(rec(w, id).status).toBe("reported");
  });

  it("does nothing while the ta switch is off, and skips an index entry whose connection is no longer polling", async () => {
    const w = world();
    const id = await polling(w);
    w.enabled.value = false;
    expect(await pollDue(w.connectDeps)).toEqual({ polled: 0, found: 0, expired: 0, skipped: 0 });
    w.enabled.value = true;
    rec(w, id).status = "suspended";
    expect(await pollDue(w.connectDeps)).toMatchObject({ polled: 0, skipped: 1 });
    expect(w.assumeCalls).toHaveLength(0);
  });
});
