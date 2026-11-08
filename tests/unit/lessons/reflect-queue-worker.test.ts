// Lessons in production, lane 2 (WB-4): the queue message holds ids only; the worker claims a reflection once, runs it under a deadline, and answers SQS's partial-batch way.
import { describe, expect, it, vi } from "vitest";
import { LESSONS_REFLECT_MAX_RECEIVES, lessonsReflectDeadLetterName, lessonsReflectQueueName } from "@agentx/contracts";
import { dynamoReflectClaims, reflectClaimKey } from "../../../packages/broker/src/lessons/reflect-claims.js";
import { ReflectMessageSchema, parseReflectMessage, reflectQueueUrlOf, sqsReflectQueue } from "../../../packages/broker/src/lessons/reflect-queue.js";
import { CLAIM_TTL_SECONDS, handleReflectBatch, runReflectMessage, type ClaimStore, type ReflectWorkerDeps } from "../../../packages/broker/src/lessons/reflect-worker.js";
import { learningCallMayStart } from "../../../packages/broker/src/lessons/learning-deadline.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { TEST_ORG } from "../../support/orgs.js";

const message = (over: Record<string, unknown> = {}) => ({ orgId: TEST_ORG, taskId: "task-1", outcome: "merged", requestId: "req-1", ...over });
const body = (over: Record<string, unknown> = {}) => JSON.stringify(message(over));

describe("the message", () => {
  it("is exactly four ids and a fixed outcome word; anything else (extra text, a title, a bad outcome) is not a message", () => {
    expect(parseReflectMessage(body())).toEqual(message());
    for (const bad of [{ title: "Fix the login" }, { outcome: "exploded" }, { orgId: "not-an-org" }, { taskId: "" }, { taskId: "has space and\nnewline" }, { requestId: "x".repeat(300) }]) {
      expect(parseReflectMessage(body(bad)), JSON.stringify(bad)).toBeUndefined();
    }
    expect(parseReflectMessage("not json")).toBeUndefined();
    expect(ReflectMessageSchema.safeParse({ ...message(), text: "a person's words" }).success).toBe(false);
  });
  it("is sent as that JSON to the queue's URL, and the URL is derived from the environment's name, region and account", async () => {
    const sent: Array<{ QueueUrl?: string; MessageBody?: string }> = [];
    const queue = sqsReflectQueue({ send: async (command) => { sent.push((command as { input: { QueueUrl?: string; MessageBody?: string } }).input); } }, "https://queue.example/q");
    await queue.send(message() as never);
    expect(sent).toEqual([{ QueueUrl: "https://queue.example/q", MessageBody: JSON.stringify(message()) }]);
    await expect(queue.send({ ...message(), outcome: "nope" } as never)).rejects.toThrow();
    expect(reflectQueueUrlOf({ AGENTX_ENV: "stg", AWS_REGION: "us-west-2", AGENTX_ACCOUNT_ID: "123456789012" })).toBe(`https://sqs.us-west-2.amazonaws.com/123456789012/${lessonsReflectQueueName("stg")}`);
    expect(reflectQueueUrlOf({ AGENTX_ENV: "stg", AWS_REGION: "us-west-2" })).toBeUndefined();
    expect(lessonsReflectDeadLetterName("stg")).not.toBe(lessonsReflectQueueName("stg"));
    expect(LESSONS_REFLECT_MAX_RECEIVES).toBe(3);
  });
});

function worker(over: Partial<ReflectWorkerDeps> = {}) {
  const claimed = new Set<string>();
  const claims: ClaimStore = { claim: async (m) => { const key = `${m.taskId}#${m.outcome}`; if (claimed.has(key)) return "already"; claimed.add(key); return "claimed"; } };
  const learn = vi.fn(async () => "reflected" as const);
  const logs: string[] = [];
  const deps: ReflectWorkerDeps = { claims, learn, now: () => 1_000_000, deadlineMs: 240_000, log: (event) => logs.push(event), ...over };
  return { deps, learn, logs, claimed };
}

describe("the worker", () => {
  it("claims once: a redelivery of the same task and outcome never runs the model or charges twice, while another outcome of the same task is its own reflection", async () => {
    const w = worker();
    expect(await runReflectMessage(w.deps, body())).toBe("reflected");
    expect(await runReflectMessage(w.deps, body({ requestId: "req-2" }))).toBe("already");
    expect(w.learn).toHaveBeenCalledTimes(1);
    expect(w.learn).toHaveBeenCalledWith({ workspaceId: TEST_ORG, taskId: "task-1", outcome: "merged" });
    expect(await runReflectMessage(w.deps, body({ outcome: "reverted" }))).toBe("reflected");
    expect(w.learn).toHaveBeenCalledTimes(2);
  });
  it("drops a message that is not four ids (one fixed log line, nothing claimed, nothing run)", async () => {
    const w = worker();
    expect(await runReflectMessage(w.deps, body({ extra: "x" }))).toBe("invalid");
    expect(w.learn).not.toHaveBeenCalled();
    expect(w.claimed.size).toBe(0);
    expect(w.logs).toEqual(["lessons_worker.invalid_message"]);
  });
  it("a fault of the claim makes the message come back (a partial-batch answer), while a message that cannot be parsed or was claimed does not", async () => {
    const failing: ClaimStore = { claim: async () => { throw new Error("table down"); } };
    const w = worker({ claims: failing });
    expect(await handleReflectBatch(w.deps, { Records: [{ messageId: "m1", body: body() }, { messageId: "m2", body: "junk" }] })).toEqual({ batchItemFailures: [{ itemIdentifier: "m1" }] });
    expect(w.learn).not.toHaveBeenCalled();
    const ok = worker();
    await runReflectMessage(ok.deps, body());
    expect(await handleReflectBatch(ok.deps, { Records: [{ messageId: "m3", body: body() }] })).toEqual({ batchItemFailures: [] });
  });
  it("once the claim is taken a failing reflection is never retried (a second run is what the claim forbids): the message is answered", async () => {
    const w = worker({ learn: async () => { throw new Error("boom"); } });
    expect(await handleReflectBatch(w.deps, { Records: [{ messageId: "m1", body: body() }] })).toEqual({ batchItemFailures: [] });
    expect(w.logs).toContain("lessons_worker.failed");
    expect(JSON.stringify(w.logs)).not.toContain("boom");
  });
  it("gives up at the deadline, whatever is still running, and starts no model call that could not finish inside it", async () => {
    vi.useFakeTimers();
    try {
      const seen: boolean[] = [];
      let release: () => void = () => undefined;
      const w = worker({
        deadlineMs: 5_000, now: () => Date.now(),
        learn: () => new Promise((resolve) => { seen.push(learningCallMayStart(Date.now(), 1_000), learningCallMayStart(Date.now() + 4_500, 1_000)); release = () => resolve("reflected"); }),
      });
      const running = runReflectMessage(w.deps, body());
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await running).toBe("timed_out");
      expect(w.logs).toContain("lessons_worker.deadline");
      // Inside the work: a call of 1 s may start at the beginning, not 4.5 s in. Outside any worker there is no deadline.
      expect(seen).toEqual([true, false]);
      expect(learningCallMayStart(Date.now() + 10_000_000, 1_000_000)).toBe(true);
      release();
    } finally { vi.useRealTimers(); }
  });
});

describe("the claim in the State table", () => {
  it("is a conditional put of LEARN#<task>#<outcome> that expires in 30 days; the second put finds it taken, and another table fault is thrown", async () => {
    const db = new FakeDynamoDb();
    const claims = dynamoReflectClaims({ documentClient: db, tableName: "state" });
    const now = 1_800_000_000;
    expect(await claims.claim(message() as never, now)).toBe("claimed");
    expect(await claims.claim(message({ requestId: "again" }) as never, now + 5)).toBe("already");
    const item = db.find((row) => row["pk"] === "LEARN#task-1#merged")[0]!;
    expect(item).toMatchObject({ sk: "CLAIM", orgId: TEST_ORG, claimedAt: now, indexExpiresAt: now + CLAIM_TTL_SECONDS });
    expect(CLAIM_TTL_SECONDS).toBe(30 * 86_400);
    expect(Object.keys(item).sort()).toEqual(["claimedAt", "entityType", "indexExpiresAt", "orgId", "pk", "sk"]);
    expect(reflectClaimKey("t", "reverted")).toEqual({ pk: "LEARN#t#reverted", sk: "CLAIM" });
    db.injectFault({ command: "PutCommand", error: { name: "InternalServerError" }, times: 1 });
    await expect(claims.claim(message({ taskId: "task-2" }) as never, now)).rejects.toThrow();
  });
});
