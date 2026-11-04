// Task 6 item 4: a GitHub delete that every durable path refused answers a retryable 503 (GitHub can redeliver), and nothing else about the delivery changes.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GithubWebhookRetryableError, handleGithubWebhook } from "../../../packages/broker/src/aws/github-webhooks.js";
import { createCodeHostTap, repoScope, type CodeHostEvent, type CodeHostRepo } from "../../../packages/broker/src/team-record/sources/codehost.js";
import { createGithubRecordTap } from "../../../packages/broker/src/team-record/sources/github.js";
import { FakeDynamoDb } from "../../support/fake-dynamodb.js";
import { world, WS } from "../../support/team-record-ingest-fakes.js";

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
});
