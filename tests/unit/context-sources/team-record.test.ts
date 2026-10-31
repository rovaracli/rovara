import { describe, expect, it } from "vitest";
import { TEAM_SINK_QUEUE_MAX, boundedSink, contextItemToRecordEvent, droppingSink, emptySearch, withoutLiveFacts, type ContextItemSeen } from "../../../packages/broker/src/context-sources/team-record.js";
import type { RecordEventLike } from "../../../packages/broker/src/team-record/shared-types.js";

const item = (over: Partial<ContextItemSeen> = {}): ContextItemSeen => ({
  orgId: "org1", projectId: "proj", taskId: "task1", stage: "PLAN", sourceId: "sim", system: "sim", itemRef: "P1", title: "T", permissionSnapshot: null, fetchedAt: "2026-11-01T10:00:00Z", contentDigest: "a".repeat(64), standing: "outsider", ...over,
});
const never = () => new Promise<void>(() => undefined);

describe("the stand-ins until the Team record lands", () => {
  it("drop events and answer no hits, so this lane ships without it", async () => {
    await expect(droppingSink.seen(item())).resolves.toBeUndefined();
    await expect(emptySearch.search({ orgId: "o", projectId: "p", query: "q", asAgentForTask: "t", limit: 20 })).resolves.toEqual([]);
  });
});

describe("the bounded sink", () => {
  it("returns at once, hands items to the record in order, one org at a time", async () => {
    const seen: string[] = [];
    const sink = boundedSink({ seen: async (entry) => { seen.push(entry.itemRef); } });
    await sink.seen(item({ itemRef: "A" }));
    await sink.seen(item({ itemRef: "B" }));
    await sink.idle();
    expect(seen).toEqual(["A", "B"]);
    expect(sink.pending("org1")).toBe(0);
  });
  it("never waits for a record that never answers", async () => {
    const sink = boundedSink({ seen: never });
    await expect(Promise.race([sink.seen(item()), new Promise((resolve) => setTimeout(() => resolve("blocked"), 200))])).resolves.toBeUndefined();
  });
  it("drops and counts what does not fit, per org, and tells the counter", async () => {
    const drops: Array<[string, string, number]> = [];
    const sink = boundedSink({ seen: never }, { maxPerOrg: 3, onDrop: (org, reason, total) => drops.push([org, reason, total]) });
    for (let index = 0; index < 8; index += 1) await sink.seen(item({ itemRef: `P${index}` }));
    // one is being handed over and never returns; three wait; the rest are dropped
    expect(sink.pending("org1")).toBe(3);
    expect(sink.dropped("org1")).toBe(4);
    expect(drops.at(-1)).toEqual(["org1", "queue_full", 4]);
    // another org is not held up by the first
    await sink.seen(item({ orgId: "org2" }));
    expect(sink.dropped("org2")).toBe(0);
  });
  it("counts a record that fails and goes on to the next item", async () => {
    const seen: string[] = [];
    const drops: string[] = [];
    const sink = boundedSink({ seen: async (entry) => { if (entry.itemRef === "A") throw new Error("down"); seen.push(entry.itemRef); } }, { onDrop: (_org, reason) => drops.push(reason) });
    await sink.seen(item({ itemRef: "A" }));
    await sink.seen(item({ itemRef: "B" }));
    await sink.idle();
    expect(seen).toEqual(["B"]);
    expect(drops).toEqual(["record_failed"]);
  });
  it("survives a counter that throws", async () => {
    const sink = boundedSink({ seen: never }, { maxPerOrg: 1, onDrop: () => { throw new Error("metric down"); } });
    await sink.seen(item());
    await sink.seen(item());
    await expect(sink.seen(item())).resolves.toBeUndefined();
  });
  it("has the design's limit", () => expect(TEAM_SINK_QUEUE_MAX).toBe(1_000));
});

describe("the item as the storage lane's event", () => {
  it("is project-only when the source said nothing about who can see it, and carries no text unless the item had some", () => {
    const event = contextItemToRecordEvent(item(), { workspaceId: "ws1", retention: "C" });
    expect(event.audience).toEqual({ kind: "project" });
    expect(event).not.toHaveProperty("text");
    expect(event).toMatchObject({ source: "mcp", kind: "source.item", scope: "mcp:sim", trust: "outsider", retention: "C", workspaceId: "ws1", project: "proj", sourceRef: { system: "sim", id: "P1" } });
  });
  it("keeps the source's permission snapshot as a restricted audience, and never raises trust above the item's standing", () => {
    const event = contextItemToRecordEvent(item({ standing: "bot", permissionSnapshot: { principals: ["alice"], groups: ["eng"], liveCheck: "on_read" }, url: "https://sim.example.com/P1", content: "body" }), { workspaceId: "ws1", retention: "D" });
    expect(event.audience).toEqual({ kind: "restricted", acl: { source: "mcp", scope: "mcp:sim", capturedAt: "2026-11-01T10:00:00Z", liveCheck: "on_read", principals: ["alice"], groups: ["eng"] } });
    expect(event.trust).toBe("system");
    expect(event.text).toBe("body");
    expect(event.links).toEqual(["https://sim.example.com/P1"]);
    expect(contextItemToRecordEvent(item({ standing: "member" }), { workspaceId: "w", retention: "A" }).trust).toBe("member");
  });
  it("fits the storage lane's RecordEventLike (a compile-time check, and a runtime one on the required fields)", () => {
    const event: Omit<RecordEventLike, "actor" | "structured" | "embeddingRef" | "tombstone"> = contextItemToRecordEvent(item(), { workspaceId: "ws1", retention: "C" });
    expect(event.workspaceId).toBe("ws1");
  });
  it("ignores a permission snapshot of the wrong shape rather than guess", () => {
    const event = contextItemToRecordEvent(item({ permissionSnapshot: { principals: [1, 2], groups: "all" } }), { workspaceId: "ws1", retention: "C" });
    // nothing usable was said about who may see it, so it is restricted to nobody rather than to everybody
    expect(event.audience).toMatchObject({ kind: "restricted", acl: { principals: [] } });
  });
});

describe("live facts are never sent", () => {
  it("removes the named keys at any depth, in any case", () => {
    expect(withoutLiveFacts({ key: "P1", Status: "Open", fields: { assignee: "a", title: "t", nested: [{ priority: 1, body: "b" }] } }, ["status", "assignee", "priority"]))
      .toEqual({ key: "P1", fields: { title: "t", nested: [{ body: "b" }] } });
    expect(withoutLiveFacts({ a: 1 }, [])).toEqual({ a: 1 });
  });
});
