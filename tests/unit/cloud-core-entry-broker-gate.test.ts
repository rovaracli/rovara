// S3-10: the broker's Lambda entry builds the core's inputs ONLY while the combined switch is on. Off (the default), the clients the entry was given are never touched, no root is built and a scheduled core
// job is not the broker's to answer: the broker is exactly what it was. On, the same entry answers the core's scheduled jobs through the root it built from those clients.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createBroker, loadSlackBroker } from "../support/slack-broker.js";

/** Host resources that record every property read: with the switch off nothing may read them. */
function recordingResources(reads: string[]) {
  return new Proxy({}, { get: (_target, key) => { if (typeof key === "string" && key !== "then") reads.push(key); return undefined; } });
}

const CORE_JOB = { source: "agentx.core-job", job: "dispatch-sweep" };

describe("the broker entry's core gate (S3-10)", () => {
  beforeAll(async () => { await loadSlackBroker(); }, 120_000);
  afterEach(() => { delete process.env.CLOUD_CORE_ENGINE; });

  it("switch off: the core clients are never read, no root is built and a core job is not answered by the core", async () => {
    delete process.env.CLOUD_CORE_ENGINE;
    const reads: string[] = [];
    const { handler, db } = createBroker({ extra: { cloudCoreHost: recordingResources(reads) } });
    const sent = db.sent.length;
    const answer = await (handler as unknown as (event: unknown) => Promise<{ statusCode: number; body: string }>)(CORE_JOB).catch((error: unknown) => ({ statusCode: -1, body: String(error) }));
    // An event no route of the broker knows: refused as an unauthenticated request, as before the core existed.
    expect(answer.statusCode).toBe(401);
    expect(answer.body).not.toContain("\"job\"");
    expect(reads).toEqual([]);
    // Not even the in-use read a root makes before it answers a job.
    expect(db.sent.slice(sent)).not.toContain("QueryCommand");
  });

  it("switch on: the same entry builds the root from those clients and answers the core job", async () => {
    process.env.CLOUD_CORE_ENGINE = "on";
    const reads: string[] = [];
    const { handler } = createBroker({ extra: { cloudCoreHost: recordingResources(reads) } });
    const answer = await (handler as unknown as (event: unknown) => Promise<{ statusCode: number; body: string }>)(CORE_JOB);
    // The root was built and asked for its modules: the deps builder read the clients it was given (and, with no developer API in this harness, refused there: `core_entry.not_configured`).
    expect(answer.statusCode).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ job: "dispatch-sweep" });
    expect(reads.length).toBeGreaterThan(0);
  });
});
