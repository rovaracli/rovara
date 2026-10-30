import { describe, expect, it } from "vitest";
import { ARCHIVE_GRACE_DAYS, exceedsRetention, lessRetention, retentionPlan, retentionRefusal } from "../../../packages/broker/src/team-record/retention.js";
import { cleanRecordText, cutToBytes, scrubPersonalDetails } from "../../../packages/broker/src/team-record/text.js";
import { deterministicEventId } from "../../../packages/broker/src/team-record/store.js";
import { ORG_A, ORG_B } from "../../support/team-record-core.js";

const DAY = 86_400;
const NOW = 1_800_000_000;

describe("retention plan", () => {
  const plan = (retention: "A" | "B" | "C" | "D", source: "github" | "rovara" = "github", hasText = true) => retentionPlan({ retention, source, hasText, occurredAtSeconds: NOW, nowSeconds: NOW });
  it("A and B store no row for an outside source; B sends its text to the distiller", () => {
    expect(plan("A")).toMatchObject({ store: false, keepText: false, embed: false, distillTransient: false });
    expect(plan("B")).toMatchObject({ store: false, keepText: false, embed: false, distillTransient: true });
    expect(plan("B", "github", false).distillTransient).toBe(false);
  });
  it("A and B keep Rovara's own structured events, without text", () => {
    expect(plan("A", "rovara")).toMatchObject({ store: true, keepText: false, embed: false });
    expect(plan("B", "rovara")).toMatchObject({ store: true, keepText: false });
  });
  it("C is 30 days of text, D is 90 days, and the TTL waits a grace period after", () => {
    expect(plan("C")).toMatchObject({ store: true, keepText: true, embed: true, textExpiresAt: NOW + 30 * DAY, hotExpiresAt: NOW + 30 * DAY, indexExpiresAt: NOW + (30 + ARCHIVE_GRACE_DAYS) * DAY });
    expect(plan("D")).toMatchObject({ keepText: true, hotExpiresAt: NOW + 90 * DAY, indexExpiresAt: NOW + (90 + ARCHIVE_GRACE_DAYS) * DAY });
    expect(plan("D").textExpiresAt).toBeUndefined();
    expect(plan("D", "github", false).embed).toBe(false);
  });
  it("an old item counts from its date but keeps at least a day; a future date counts from now", () => {
    expect(retentionPlan({ retention: "C", source: "github", hasText: true, occurredAtSeconds: NOW - 29 * DAY, nowSeconds: NOW }).hotExpiresAt).toBe(NOW + DAY);
    expect(retentionPlan({ retention: "D", source: "github", hasText: true, occurredAtSeconds: NOW - 10 * DAY, nowSeconds: NOW }).hotExpiresAt).toBe(NOW + 80 * DAY);
    expect(retentionPlan({ retention: "D", source: "github", hasText: true, occurredAtSeconds: NOW + 50 * DAY, nowSeconds: NOW }).hotExpiresAt).toBe(NOW + 90 * DAY);
  });
  it("orders the modes and fixes Public Slack at A or B", () => {
    expect(exceedsRetention("D", "C")).toBe(true);
    expect(exceedsRetention("B", "C")).toBe(false);
    expect(lessRetention("D", "B")).toBe("B");
    expect(retentionRefusal("public", "slack", "C")).toBe("slack_public_fixed_a_b");
    expect(retentionRefusal("public", "slack", "D")).toBe("slack_public_fixed_a_b");
    expect(retentionRefusal("public", "slack", "B")).toBeUndefined();
    expect(retentionRefusal("public", "github", "D")).toBeUndefined();
    expect(retentionRefusal("enterprise", "slack", "D")).toBeUndefined();
  });
});

describe("text hygiene", () => {
  it("removes hidden characters, bidi controls and tag characters, keeps line breaks", () => {
    expect(cleanRecordText("a‮b​c\u{E0041}d\ne\tf")).toBe("abcd\ne\tf");
  });
  it("hidden characters cannot split a secret past the redactor", () => {
    const text = cleanRecordText("token=ghp_​1234567890abcdefghijklmnopqrstuvwx12")!;
    expect(text).not.toContain("1234567890abcdefghij");
  });
  it("replaces fenced code, an unclosed fence takes the rest, and keeps code for a human edit", () => {
    expect(cleanRecordText("before\n```js\nsecret()\n```\nafter")).toBe("before\n[code omitted]\nafter");
    expect(cleanRecordText("before\n```js\nsecret()\nmore")).toBe("before\n[code omitted]");
    expect(cleanRecordText("```diff\n+x\n```", { keepCode: true })).toContain("+x");
  });
  it("scrubs emails, phone numbers and account ids but not dates or short numbers", () => {
    expect(scrubPersonalDetails("a@b.co, +1 (415) 555-0134, 415.555.0134, arn:aws:iam::123456789012:role/x, on 2026-10-30, 12345")).toBe("[email], [phone], [phone], arn:aws:iam::[account-id]:role/x, on 2026-10-30, 12345");
  });
  it("cuts to 8 KB by bytes without splitting a character, and returns undefined for nothing", () => {
    expect(new TextEncoder().encode(cleanRecordText("é".repeat(5_000)) ?? "").byteLength).toBeLessThanOrEqual(8_192);
    expect(cutToBytes("aé", 2)).toBe("a");
    expect(cleanRecordText("  ​ ")).toBeUndefined();
    expect(cleanRecordText(undefined)).toBeUndefined();
  });
});

describe("deterministic event id", () => {
  it("is a valid uuid, the same for the same item version and different for anything else", () => {
    const id = deterministicEventId(ORG_A, "github", "github.com", "c-1", "1");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicEventId(ORG_A, "github", "github.com", "c-1", "1")).toBe(id);
    for (const other of [deterministicEventId(ORG_B, "github", "github.com", "c-1", "1"), deterministicEventId(ORG_A, "github", "github.com", "c-1", "2"), deterministicEventId(ORG_A, "github", "github.com", "c-2", "1"), deterministicEventId(ORG_A, "slack", "github.com", "c-1", "1")]) expect(other).not.toBe(id);
  });
});
