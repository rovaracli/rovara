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
  it("refuses a change the edition does not offer or the company ceiling forbids, with a fixed reason", () => {
    expect(checkRetentionChange({ edition: "public", source: "slack", from: "A", to: "C" })).toEqual({ ok: false, refusal: "RETENTION_NOT_OFFERED" });
    expect(checkRetentionChange({ edition: "enterprise", source: "github", from: "C", to: "D", locks: { retentionCeiling: { default: "C" } } })).toEqual({ ok: false, refusal: "RETENTION_ABOVE_COMPANY_CEILING" });
    expect(checkRetentionChange({ edition: "enterprise", source: "nope", from: "C", to: "C" })).toEqual({ ok: false, refusal: "SOURCE_UNKNOWN" });
    expect(checkRetentionChange({ edition: "enterprise", source: "github", from: "C", to: "Q" })).toEqual({ ok: false, refusal: "RETENTION_NOT_OFFERED" });
  });
  it("needs a second person to raise retention in Enterprise, and not to lower it or in Public", () => {
    expect(checkRetentionChange({ edition: "enterprise", source: "github", from: "B", to: "C" })).toEqual({ ok: true, needsSecondPerson: true });
    expect(checkRetentionChange({ edition: "enterprise", source: "github", from: "D", to: "C" })).toEqual({ ok: true, needsSecondPerson: false });
    expect(checkRetentionChange({ edition: "public", source: "github", from: "C", to: "D" })).toEqual({ ok: true, needsSecondPerson: false });
  });
});

describe("slack scopes", () => {
  it("never Slack Connect; DMs only in Enterprise and only when added; private channels only when added", () => {
    expect(slackScopeAllowed("public", "slack_connect").allowed).toBe(false);
    expect(slackScopeAllowed("enterprise", "slack_connect").allowed).toBe(false);
    expect(slackScopeAllowed("public", "dm").allowed).toBe(false);
    expect(slackScopeAllowed("public", "mpim").allowed).toBe(false);
    expect(slackScopeAllowed("enterprise", "dm")).toEqual({ allowed: true, explicitOnly: true });
    expect(slackScopeAllowed("public", "private_channel")).toEqual({ allowed: true, explicitOnly: true });
    expect(slackScopeAllowed("public", "public_channel")).toEqual({ allowed: true, explicitOnly: false });
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
