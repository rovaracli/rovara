import { describe, expect, it } from "vitest";
import {
  AUDITOR_AUDIT_PREFIXES, allowedRetention, auditorMayRead, checkRetentionChange, customerSqlAllowed, defaultRetention, effectiveLearningMode, effectiveRetention, readEdition, slackScopeAllowed,
} from "../../../packages/broker/src/team-record/edition.js";

describe("edition", () => {
  it("defaults to public and refuses an unknown value", () => {
    expect(readEdition({})).toBe("public");
    expect(readEdition({ ROVARA_EDITION: "" })).toBe("public");
    expect(readEdition({ ROVARA_EDITION: "enterprise" })).toBe("enterprise");
    expect(() => readEdition({ ROVARA_EDITION: "Enterprise " })).toThrow(/enterprise or public/);
  });
  it("fixes Public Slack at A or B, and offers everything else", () => {
    expect(allowedRetention("public", "slack")).toEqual(["A", "B"]);
    expect(allowedRetention("enterprise", "slack")).toEqual(["A", "B", "C", "D"]);
    expect(allowedRetention("public", "github")).toEqual(["A", "B", "C", "D"]);
  });
  it("defaults: Enterprise C everywhere; Public D, with Slack read live only", () => {
    expect(defaultRetention("enterprise", "slack")).toBe("C");
    expect(defaultRetention("enterprise", "rovara")).toBe("C");
    expect(defaultRetention("public", "github")).toBe("D");
    expect(defaultRetention("public", "slack")).toBe("A");
  });
  it("only Enterprise may have customer SQL", () => {
    expect(customerSqlAllowed("enterprise")).toBe(true);
    expect(customerSqlAllowed("public")).toBe(false);
  });
});

describe("company locks", () => {
  it("a locked learning mode wins; an unknown stored mode is off", () => {
    expect(effectiveLearningMode("on", { learningMode: "suggest" })).toBe("suggest");
    expect(effectiveLearningMode("on")).toBe("on");
    expect(effectiveLearningMode(undefined)).toBe("off");
    expect(effectiveLearningMode("everything")).toBe("off");
    expect(effectiveLearningMode("on", { learningMode: "off" })).toBe("off");
  });
  it("lowers a stored retention to the edition and the company ceiling, never raises it", () => {
    expect(effectiveRetention("public", "slack", "D")).toBe("B");
    expect(effectiveRetention("enterprise", "github", "D", { retentionCeiling: { default: "C" } })).toBe("C");
    expect(effectiveRetention("enterprise", "github", "D", { retentionCeiling: { default: "C", github: "D" } })).toBe("D");
    expect(effectiveRetention("enterprise", "github", "B", { retentionCeiling: { default: "C" } })).toBe("B");
    expect(effectiveRetention("enterprise", "github", undefined)).toBe("C");
    expect(effectiveRetention("enterprise", "github", "Z")).toBe("C");
    expect(effectiveRetention("enterprise", "github", undefined, { retentionCeiling: { default: "B" } })).toBe("B");
  });
  it("M-3: a stored ceiling that is not a retention mode counts as A (nothing kept), never as no limit", () => {
    expect(effectiveRetention("enterprise", "github", "D", { retentionCeiling: { default: "Z" as never } })).toBe("A");
    expect(checkRetentionChange({ edition: "enterprise", source: "github", stored: "A", to: "B", locks: { retentionCeiling: { default: "Z" as never } } })).toEqual({ ok: false, refusal: "RETENTION_ABOVE_COMPANY_CEILING" });
  });
  it("M-4: the widening rule starts from the stored value, and a caller cannot lower it by claiming another", () => {
    expect(checkRetentionChange({ edition: "enterprise", source: "github", stored: "B", to: "D" })).toEqual({ ok: true, widens: true });
    expect(checkRetentionChange({ edition: "enterprise", source: "github", stored: undefined, to: "D" })).toEqual({ ok: true, widens: true });
    expect(checkRetentionChange({ edition: "enterprise", source: "github", stored: "D", to: "D", locks: { retentionCeiling: { default: "C" } } })).toEqual({ ok: false, refusal: "RETENTION_ABOVE_COMPANY_CEILING" });
  });
  it("refuses a change the edition does not offer or the company ceiling forbids, with a fixed reason", () => {
    expect(checkRetentionChange({ edition: "public", source: "slack", stored: "A", to: "C" })).toEqual({ ok: false, refusal: "RETENTION_NOT_OFFERED" });
    expect(checkRetentionChange({ edition: "enterprise", source: "github", stored: "C", to: "D", locks: { retentionCeiling: { default: "C" } } })).toEqual({ ok: false, refusal: "RETENTION_ABOVE_COMPANY_CEILING" });
    expect(checkRetentionChange({ edition: "enterprise", source: "nope", stored: "C", to: "C" })).toEqual({ ok: false, refusal: "SOURCE_UNKNOWN" });
    expect(checkRetentionChange({ edition: "enterprise", source: "github", stored: "C", to: "Q" })).toEqual({ ok: false, refusal: "RETENTION_NOT_OFFERED" });
  });
  it("widens what is kept when retention is raised, in both editions, and not when it is lowered (no second person: T9, fix round 1)", () => {
    expect(checkRetentionChange({ edition: "enterprise", source: "github", stored: "B", to: "C" })).toEqual({ ok: true, widens: true });
    expect(checkRetentionChange({ edition: "enterprise", source: "github", stored: "D", to: "C" })).toEqual({ ok: true, widens: false });
    expect(checkRetentionChange({ edition: "public", source: "github", stored: "C", to: "D" })).toEqual({ ok: true, widens: true });
    expect(checkRetentionChange({ edition: "public", source: "slack", stored: "A", to: "B" })).toEqual({ ok: true, widens: true });
    expect(checkRetentionChange({ edition: "public", source: "slack", stored: undefined, to: "A" })).toEqual({ ok: true, widens: false });
  });
});

describe("slack scopes", () => {
  it("never Slack Connect; DMs only in Enterprise and only when added; private channels only when added", () => {
    expect(slackScopeAllowed("public", "slack_connect").allowed).toBe(false);
    expect(slackScopeAllowed("enterprise", "slack_connect").allowed).toBe(false);
    expect(slackScopeAllowed("public", "dm").allowed).toBe(false);
    expect(slackScopeAllowed("public", "mpim").allowed).toBe(false);
    expect(slackScopeAllowed("enterprise", "dm")).toEqual({ allowed: true, explicitOnly: true, widens: true });
    expect(slackScopeAllowed("enterprise", "private_channel")).toEqual({ allowed: true, explicitOnly: true, widens: true });
    expect(slackScopeAllowed("public", "private_channel")).toEqual({ allowed: true, explicitOnly: true, widens: true });
    expect(slackScopeAllowed("public", "public_channel")).toEqual({ allowed: true, explicitOnly: false, widens: false });
  });
});

describe("auditor", () => {
  it("reads record.* and lesson.* audit actions and nothing else", () => {
    expect(AUDITOR_AUDIT_PREFIXES).toEqual(["record.", "lesson."]);
    expect(auditorMayRead("record.tombstoned")).toBe(true);
    expect(auditorMayRead("lesson.refused")).toBe(true);
    expect(auditorMayRead("rule.accepted")).toBe(false);
    expect(auditorMayRead("record.")).toBe(false);
    expect(auditorMayRead("xrecord.a")).toBe(false);
  });
});
