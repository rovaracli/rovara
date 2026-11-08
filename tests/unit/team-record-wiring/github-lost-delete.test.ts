// Task 6 item 4: a GitHub delete that every durable path refused answers a retryable 503 (GitHub can redeliver), and nothing else about the delivery changes.
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubWebhookRetryableError, RECORD_TAP_BUDGET_MS, handleGithubWebhook } from "../../../packages/broker/src/aws/github-webhooks.js";
import { createCodeHostTap, repoScope, type CodeHostEvent, type CodeHostRepo } from "../../../packages/broker/src/team-record/sources/codehost.js";
import { createGithubRecordTap } from "../../../packages/broker/src/team-record/sources/github.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { world, WS } from "../../support/team-record-ingest-fakes.js";

afterEach(() => { vi.useRealTimers(); });
const SECRET = "whsec-lost-delete";
const AT = "2026-10-30T10:00:00.000Z";
const repo: CodeHostRepo = { host: "github", id: "77", fullName: "acme/shop", isPrivate: true, workspaceId: WS, project: "shop" };
const alice = { id: "1001", login: "alice", isBot: false };
const deletedComment: CodeHostEvent = { type: "comment", repo, prNumber: 5, id: "41", url: "https://github.com/acme/shop/pull/5#c41", action: "deleted", surface: "review_comment", author: alice, at: AT, version: "deleted:1" };

describe("the tap reports a delete nothing accepted", () => {
  it("removalFailed is set when the removal throws, and not when a put fails", async () => {
    const w = world();
    w.config.set("github", repoScope(repo), { retention: "D" });
    const tap = createCodeHostTap({ sink: w.sink, actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config });
    w.sink.tombstone = async () => { throw new Error("table unavailable"); };
    expect(await tap.handle(deletedComment)).toMatchObject({ failed: 1, removalFailed: true });
    w.sink.failPut = true;
    const put = await tap.handle({ type: "pr", repo, number: 5, url: "https://github.com/acme/shop/pull/5", action: "opened", merged: false, title: "t", author: alice, headSha: "a".repeat(40), baseRef: "main", at: AT, version: "opened:1" });
    expect(put.failed).toBe(1);
    expect(put.removalFailed).toBeUndefined();
  });

  it("the GitHub wrapper keeps the flag across the events of one delivery", async () => {
    const w = world();
    w.sink.tombstone = async () => { throw new Error("table unavailable"); };
    const tap = createGithubRecordTap({ sink: w.sink, actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config, resolveRepo: async () => ({ workspaceId: WS, project: "shop" }) });
    const result = await tap({ eventName: "repository", deliveryId: "d1", payload: { action: "deleted", installation: { id: 1 }, repository: { id: 77, full_name: "acme/shop", private: true } } });
    expect(result).toMatchObject({ failed: 1, removalFailed: true });
  });
});

describe("a removal whose repository lookup fails is a lost removal (SRL-5a H2)", () => {
  const envelope = { installation: { id: 1 }, repository: { id: 77, full_name: "acme/shop", private: true } };
  const comment = { id: 41, html_url: "https://github.com/acme/shop/pull/5#c41", body: "x", user: { id: 1001, login: "alice" }, updated_at: AT };
  const tapOf = (resolveRepo: () => Promise<{ workspaceId: string; project?: string } | undefined>) => {
    const w = world();
    return createGithubRecordTap({ sink: w.sink, actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config, resolveRepo });
  };

  it("a removal whose lookup throws is reported lost (removalFailed), for a deleted comment, a deleted repository and a transfer", async () => {
    const tap = tapOf(async () => { throw new Error("State table throttled"); });
    for (const [eventName, payload] of [
      ["issue_comment", { ...envelope, action: "deleted", comment, issue: { number: 5, pull_request: {} } }],
      ["pull_request_review_comment", { ...envelope, action: "deleted", comment, pull_request: { number: 5 } }],
      ["repository", { ...envelope, action: "deleted" }], ["repository", { ...envelope, action: "transferred" }],
    ] as const) {
      expect(await tap({ eventName, deliveryId: "d1", payload }), eventName).toMatchObject({ failed: 1, removalFailed: true });
    }
  });

  it("tells the webhook a removal began BEFORE the lookup, so a lookup that hangs is answered retryable", async () => {
    const order: string[] = [];
    const tap = tapOf(async () => { order.push("lookup"); return undefined; });
    await tap({ eventName: "repository", deliveryId: "d1", payload: { ...envelope, action: "deleted" }, removalStarted: () => order.push("started") });
    expect(order).toEqual(["started", "lookup"]);
  });

  it("a repository the record does not hold is still a plain nothing (a 2xx), and a NON-removal whose lookup throws is unchanged", async () => {
    expect(await tapOf(async () => undefined)({ eventName: "repository", deliveryId: "d1", payload: { ...envelope, action: "deleted" } })).toBeUndefined();
    const throwing = tapOf(async () => { throw new Error("State table throttled"); });
    expect(await throwing({ eventName: "repository", deliveryId: "d1", payload: { ...envelope, action: "renamed" } })).toBeUndefined();
    expect(await throwing({ eventName: "issue_comment", deliveryId: "d1", payload: { ...envelope, action: "created", comment, issue: { number: 5, pull_request: {} } } })).toBeUndefined();
  });

  const SIGNED = (raw: string) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
  const commentPayload = { ...envelope, action: "deleted", comment: { ...comment, created_at: AT, updated_at: AT, pull_request_review_id: null }, issue: { number: 5, pull_request: { url: "https://api.github.com/x" } }, pull_request: { number: 5 } };
  function deliverComment(recordTap: (verified: { eventName: string | undefined; deliveryId: string; payload: unknown; removalStarted?: () => void }) => Promise<unknown>, documentClient = new FakeDynamoDb(), authorize = async () => true) {
    const raw = JSON.stringify(commentPayload);
    return handleGithubWebhook({
      documentClient, tableName: "T", rawBody: raw, secret: SECRET, now: () => AT,
      headers: { "x-hub-signature-256": SIGNED(raw), "x-github-delivery": "6a0b3c52-0000-4000-8000-000000000002", "x-github-event": "issue_comment" },
      authorizeRepository: authorize, process: async () => undefined, recordTap,
    });
  }

  it("a lost removal is a retryable 503 whatever else went wrong with the delivery: a reservation conflict (a refusal), an authorisation that throws", async () => {
    const lost = async () => ({ written: 0, duplicates: 0, refused: 0, failed: 1, removalFailed: true });
    // The same delivery id was stored with other content: the webhook refuses it (403) after the tap ran.
    const stored = new FakeDynamoDb();
    stored.set({ pk: "GITHUB_DELIVERY#6a0b3c52-0000-4000-8000-000000000002", sk: "META", eventHash: "f".repeat(64), installationId: 1, repositoryId: 77, status: "COMPLETED" });
    await expect(deliverComment(lost, stored)).rejects.toBeInstanceOf(GithubWebhookRetryableError);
    // Without the lost removal the same delivery keeps its own answer (a refusal).
    await expect(deliverComment(async () => undefined, stored)).rejects.not.toBeInstanceOf(GithubWebhookRetryableError);
    await expect(deliverComment(lost, new FakeDynamoDb(), async () => { throw new Error("state table down"); })).rejects.toBeInstanceOf(GithubWebhookRetryableError);
  });

  it("a removal whose lookup hangs past the tap budget is a retryable 503 end to end", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const hanging = tapOf(() => new Promise<never>(() => undefined));
    const outcome = deliverComment((verified) => hanging(verified as never)).then((result) => `answered:${result.status}`, (error: unknown) => (error instanceof GithubWebhookRetryableError ? "retryable" : "other"));
    await vi.advanceTimersByTimeAsync(RECORD_TAP_BUDGET_MS + 100);
    expect(await outcome).toBe("retryable");
  });
});

describe("the webhook answer", () => {
  const sign = (raw: string) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
  const payload = { action: "opened", installation: { id: 9 }, repository: { id: 77, full_name: "acme/shop" } };
  function deliver(recordTap: (verified: unknown) => Promise<unknown>, seen: string[]) {
    const raw = JSON.stringify(payload);
    return handleGithubWebhook({
      documentClient: new FakeDynamoDb(), tableName: "T", rawBody: raw, secret: SECRET, now: () => AT,
      headers: { "x-hub-signature-256": sign(raw), "x-github-delivery": "6a0b3c52-0000-4000-8000-000000000001", "x-github-event": "issues" },
      authorizeRepository: async () => false, process: async () => undefined,
      triggerEvents: async () => { seen.push("trigger work ran"); return { events: 1, duplicates: 0 }; },
      recordTap,
    });
  }

  it("is a retryable error when the tap says its delete was lost, after the delivery's other work ran", async () => {
    const seen: string[] = [];
    await expect(deliver(async () => ({ written: 0, duplicates: 0, refused: 0, failed: 1, removalFailed: true }), seen)).rejects.toBeInstanceOf(GithubWebhookRetryableError);
    expect(seen).toEqual(["trigger work ran"]);
  });

  it("is unchanged for a failed put, a tap that throws, and a tap with nothing to say", async () => {
    for (const tap of [async () => ({ written: 0, duplicates: 0, refused: 0, failed: 1 }), async () => { throw new Error("record down"); }, async () => undefined]) {
      const seen: string[] = [];
      expect(await deliver(tap, seen)).toMatchObject({ status: "ACCEPTED", trigger: true });
      expect(seen).toEqual(["trigger work ran"]);
    }
  });

  it("a removal still running at the tap budget is retryable too; a slow put, a finished removal and a tap that never said a removal began are not", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slow = async (tap: (verified: unknown) => Promise<unknown>): Promise<string> => {
      const seen: string[] = [];
      const outcome = deliver(tap, seen).then((result) => `answered:${result.status}`, (error: unknown) => (error instanceof GithubWebhookRetryableError ? "retryable" : "other"));
      await vi.advanceTimersByTimeAsync(RECORD_TAP_BUDGET_MS + 100);
      return outcome;
    };
    const never = () => new Promise<never>(() => undefined);
    expect(await slow((verified) => { (verified as { removalStarted?: () => void }).removalStarted?.(); return never(); })).toBe("retryable");
    expect(await slow(() => never())).toBe("answered:ACCEPTED");
    expect(await slow(async (verified) => { (verified as { removalStarted?: () => void }).removalStarted?.(); return undefined; })).toBe("answered:ACCEPTED");
  });
});

describe("the GitHub tap says when a removal begins", () => {
  it("calls removalStarted before the tombstone, for a deleted comment and a deleted repository only", async () => {
    const w = world();
    const order: string[] = [];
    w.sink.tombstone = async () => { order.push("tombstone"); return { hidden: 1 }; };
    const tap = createGithubRecordTap({ sink: w.sink, actors: w.actors, rovaraPrs: w.prs, mode: w.mode, config: w.config, resolveRepo: async () => ({ workspaceId: WS, project: "shop" }) });
    const envelope = { installation: { id: 1 }, repository: { id: 77, full_name: "acme/shop", private: true } };
    await tap({ eventName: "repository", deliveryId: "d1", payload: { ...envelope, action: "deleted" }, removalStarted: () => order.push("started") });
    await tap({ eventName: "repository", deliveryId: "d2", payload: { ...envelope, action: "created" }, removalStarted: () => order.push("started-wrong") });
    expect(order).toEqual(["started", "tombstone"]);
  });
});
