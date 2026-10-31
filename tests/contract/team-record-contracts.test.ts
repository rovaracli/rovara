import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUDIT_FACT_KEYS, AuditEventInputSchema, ProposalCandidateSchema, RecordEventSchema, RecordFactSchema, RecordSearchResponseSchema, SourceConfigSchema, TRUST_RANK,
  WORKER_INVOCATION_FEATURES, auditEventId, learningModeKey, lessonKey, lessonSetKey, lessonVersionKey, loadManifestKey, memorySnapshotKey, minTrust, orgOfTeamRecordPk,
  recordActorIndexValue, recordDeleteQueueKey, recordDerivationKey, recordScopeIndexValue, learningModeLockKey, MAINTAINERS_GROUP, recordEventKey, recordFactKey, recordSourceIndexValue, recordSourceKey, teamRecordPk, teamRecordSourceHash, teamRecordWorkspacePrefix,
  type AuditAction, type OrgId,
} from "@agentx/contracts";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ID = "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a0001";

function event(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID, workspaceId: ORG_A, project: "web", source: "github", sourceRef: { system: "github", id: "pr/12#c1" }, scope: "github:repo/9", kind: "github.review_comment",
    occurredAt: "2026-10-30T10:00:00.000Z", actor: { sourceId: "123", developerId: "dev-1", trust: "member" }, trust: "member", audience: { kind: "project" },
    text: "Use withRetry here.", links: ["https://github.com/acme/web/pull/12#c1"], retention: "D", hotExpiresAt: 1_800_000_000, indexExpiresAt: 1_800_600_000, ...extra,
  };
}
const parses = (value: unknown) => RecordEventSchema.safeParse(value).success;

describe("trust classes", () => {
  it("rank outsider below system below member below rovara, and a derivation takes the lowest", () => {
    expect(TRUST_RANK.outsider).toBeLessThan(TRUST_RANK.system);
    expect(TRUST_RANK.system).toBeLessThan(TRUST_RANK.member);
    expect(TRUST_RANK.member).toBeLessThan(TRUST_RANK.rovara);
    expect(minTrust("rovara", "member")).toBe("member");
    expect(minTrust("member", "outsider", "rovara")).toBe("outsider");
  });
  it("treat no inputs as an outsider (fail closed)", () => {
    expect(minTrust()).toBe("outsider");
  });
});

describe("record event", () => {
  it("accepts a member review comment kept under retention D", () => {
    expect(parses(event())).toBe(true);
  });
  it("is strict: an unknown field is refused", () => {
    expect(parses(event({ tools: ["shell"] }))).toBe(false);
  });
  it("refuses text under retention A and B (never stored)", () => {
    expect(parses(event({ retention: "A" }))).toBe(false);
    expect(parses(event({ retention: "B" }))).toBe(false);
    expect(parses(event({ retention: "B", text: undefined }))).toBe(true);
    expect(parses(event({ retention: "C", textExpiresAt: 1_700_000_000 }))).toBe(true);
  });
  it("refuses text longer than 8 KB by bytes, not characters", () => {
    expect(parses(event({ text: "é".repeat(4_096) }))).toBe(true);
    expect(parses(event({ text: "é".repeat(4_097) }))).toBe(false);
  });
  it("refuses a text expiry with no text", () => {
    expect(parses(event({ text: undefined, textExpiresAt: 1 }))).toBe(false);
  });
  it("refuses free text on a rovara-trust row", () => {
    expect(parses(event({ trust: "rovara", actor: undefined, source: "rovara", kind: "rovara.merged", sourceRef: { system: "rovara", id: "t1" } }))).toBe(false);
    expect(parses(event({ trust: "rovara", actor: undefined, source: "rovara", kind: "rovara.merged", sourceRef: { system: "rovara", id: "t1" }, text: undefined }))).toBe(true);
  });
  it("never lets a row's trust exceed the actor's", () => {
    expect(parses(event({ trust: "member", actor: { sourceId: "9", trust: "outsider" } }))).toBe(false);
    expect(parses(event({ trust: "outsider", actor: { sourceId: "9", trust: "member" } }))).toBe(true);
  });
  it("needs the place on every row, so the lake can erase by place", () => {
    expect(parses(event({ scope: undefined }))).toBe(false);
    expect(parses(event({ scope: "" }))).toBe(false);
  });
  it("refuses a source that does not fit the kind", () => {
    expect(parses(event({ source: "slack" }))).toBe(false);
    expect(parses(event({ source: "codehost:gitfarm" }))).toBe(true);
    expect(parses(event({ kind: "slack.message", source: "slack", sourceRef: { system: "slack", id: "T1/C1/1.2" } }))).toBe(true);
    expect(parses(event({ kind: "ticket.created", source: "mcp" }))).toBe(true);
    expect(parses(event({ kind: "ticket.created", source: "slack" }))).toBe(false);
    expect(parses(event({ kind: "rovara.send_back", source: "github" }))).toBe(false);
  });
  it("takes a restricted audience only with a snapshot", () => {
    const acl = { source: "github", scope: "github:repo/9", capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "on_read" };
    expect(parses(event({ audience: { kind: "restricted", acl } }))).toBe(true);
    expect(parses(event({ audience: { kind: "restricted" } }))).toBe(false);
    expect(parses(event({ audience: { kind: "restricted", acl: { ...acl, principals: Array.from({ length: 501 }, (_, i) => `u${String(i)}`) } } }))).toBe(false);
  });
  it("refuses an unknown trust class, retention or a malformed workspace id", () => {
    expect(parses(event({ trust: "admin" }))).toBe(false);
    expect(parses(event({ retention: "E" }))).toBe(false);
    expect(parses(event({ workspaceId: "org_x" }))).toBe(false);
  });
});

describe("fact, source and consumer contracts", () => {
  const fact = { id: ID, workspaceId: ORG_A, project: "web", kind: "decision", text: "We retry with withRetry.", links: [], derivedFrom: ["rec-1"], trust: "member", audience: { kind: "project" }, createdAt: "2026-10-30T10:00:00.000Z" };
  it("keeps a fact short and demands a derivation", () => {
    expect(RecordFactSchema.safeParse(fact).success).toBe(true);
    expect(RecordFactSchema.safeParse({ ...fact, text: "x".repeat(401) }).success).toBe(false);
    expect(RecordFactSchema.safeParse({ ...fact, derivedFrom: [] }).success).toBe(false);
  });
  it("holds a source setting with a fixed audience fallback", () => {
    const source = { workspaceId: ORG_A, project: "web", source: "mcp", scope: "mcp:sim/folder/abc", enabled: true, retention: "C", exclude: [], audienceDefault: "maintainers", health: "unknown", addedBy: "dev-1", updatedAt: "2026-10-30T10:00:00.000Z" };
    expect(SourceConfigSchema.safeParse(source).success).toBe(true);
    expect(SourceConfigSchema.safeParse({ ...source, audienceDefault: "everyone" }).success).toBe(false);
  });
  it("flags hidden hits (never counts them) and bounds a search response", () => {
    expect(RecordSearchResponseSchema.safeParse({ hits: [], someHidden: true }).success).toBe(true);
    expect(RecordSearchResponseSchema.safeParse({ hits: [], withheld: 3 }).success).toBe(false); // a count is not allowed: it would let a viewer probe
    expect(RecordSearchResponseSchema.safeParse({ hits: [], someHidden: false, extra: 1 }).success).toBe(false);
  });
  it("needs two evidence items for a proposal", () => {
    const proposal = { id: ID, workspaceId: ORG_A, project: "web", kind: "bug_cluster", title: "t", why: "w", evidence: ["a", "b"], dedupeKey: "k", existingTickets: [], estimateUsd: 4, proposer: { agent: "rovara-scanner", version: "1" }, audience: "project", expiresAt: "2026-11-30T00:00:00.000Z" };
    expect(ProposalCandidateSchema.safeParse(proposal).success).toBe(true);
    expect(ProposalCandidateSchema.safeParse({ ...proposal, evidence: ["a"] }).success).toBe(false);
    expect(ProposalCandidateSchema.safeParse({ ...proposal, audience: "restricted" }).success).toBe(false);
  });
});

describe("team record keys", () => {
  it("put every row in its own workspace and project partition", () => {
    expect(teamRecordPk(ORG_A, "web")).toBe(`WS#${ORG_A}#P#web`);
    expect(teamRecordPk(ORG_A)).toBe(`WS#${ORG_A}#P#_workspace`);
    expect(teamRecordPk(ORG_A, "web")).not.toBe(teamRecordPk(ORG_B, "web"));
    expect(recordEventKey(ORG_A, "web", "2026-10-30T10:00:00Z", ID)).toEqual({ pk: `WS#${ORG_A}#P#web`, sk: `REC#2026-10-30T10:00:00.000Z#${ID}` });
    expect(recordFactKey(ORG_A, "web", ID).sk).toBe(`FACT#${ID}`);
    expect(lessonKey(ORG_A, "web", "les_0123456789abcdef0123").sk).toBe("LESSON#les_0123456789abcdef0123");
    expect(lessonVersionKey(ORG_A, "web", "les_0123456789abcdef0123", 3).sk).toBe("LESSON#les_0123456789abcdef0123#V#000000000003");
    expect(lessonSetKey(ORG_A, "web").sk).toBe("LESSONSET");
    expect(memorySnapshotKey(ORG_A, "web", "snp_0123456789abcdef0123").sk).toBe("SNAPSHOT#snp_0123456789abcdef0123");
    expect(learningModeKey(ORG_A, "web").sk).toBe("MODE");
    expect(teamRecordWorkspacePrefix(ORG_A)).toBe(`WS#${ORG_A}#`);
  });
  it("write an eval run's load manifest under a different key so live counters never see it", () => {
    expect(loadManifestKey(ORG_A, "web", "t1", "PLAN", 2).sk).toBe("LOAD#t1#PLAN#000002");
    expect(loadManifestKey(ORG_A, "web", "t1", "PLAN", 2, true).sk).toBe("EVALLOAD#t1#PLAN#000002");
  });
  it("hash a source's own id so a # in it cannot move a key boundary", () => {
    const hash = teamRecordSourceHash("slack", "T1/C1#evil");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(recordSourceIndexValue(ORG_A, "slack", "T1/C1#evil")).toBe(`WS#${ORG_A}#SRC#slack#${hash}`);
    expect(recordDerivationKey(ORG_A, "web", "slack", "T1/C1#evil", ID).sk).toBe(`DERIV#${hash}#${ID}`);
    expect(recordSourceKey(ORG_A, "web", "slack", "T1/C1").sk).toMatch(/^SOURCE#slack#[0-9a-f]{64}$/);
    expect(recordSourceIndexValue(ORG_A, "slack", "x")).not.toBe(recordSourceIndexValue(ORG_B, "slack", "x"));
    expect(recordSourceIndexValue(ORG_A, "slack", "x")).not.toBe(recordSourceIndexValue(ORG_A, "github", "x"));
    expect(recordActorIndexValue(ORG_A, "dev-1")).toBe(`WS#${ORG_A}#ACTOR#dev-1`);
    expect(recordScopeIndexValue(ORG_A, "slack:T1/C9")).toMatch(new RegExp(`^WS#${ORG_A}#SCOPE#[0-9a-f]{64}$`));
    expect(recordScopeIndexValue(ORG_A, "slack:T1/C9")).not.toBe(recordScopeIndexValue(ORG_B, "slack:T1/C9"));
    expect(teamRecordSourceHash("slack", "T1/C1")).toBe(createHash("sha256").update("slack\u0000T1/C1").digest("hex"));
    expect(learningModeLockKey(ORG_A)).toEqual({ pk: `WS#${ORG_A}#P#_workspace`, sk: "MODE_LOCK" });
    expect(recordDeleteQueueKey(ORG_A, "2026-10-30T10:00:00Z", "r1").sk).toBe("DELQ#2026-10-30T10:00:00.000Z#r1");
    expect(MAINTAINERS_GROUP).toBe("project:maintainers");
  });
  it("refuse a project or id that would break a key", () => {
    expect(() => teamRecordPk(ORG_A, "a#b")).toThrow();
    expect(() => recordFactKey(ORG_A, "web", "a#b")).toThrow();
    expect(() => recordEventKey(ORG_A, "web", "yesterday", ID)).toThrow();
    expect(() => teamRecordPk("org_x", "web")).toThrow();
    expect(() => recordActorIndexValue(ORG_A, "")).toThrow();
  });
  it("read the workspace back from a partition, and nothing from a foreign key", () => {
    expect(orgOfTeamRecordPk(teamRecordPk(ORG_B, "web"))).toBe(ORG_B);
    expect(orgOfTeamRecordPk(`ORG#${ORG_A}#PROJECT#web`)).toBeUndefined();
  });
});

describe("team record audit events and the worker feature", () => {
  const TARGET = { "record.source_added": { kind: "record_source", id: "abc" }, "lesson.proposed": { kind: "lesson", id: "les_1" } } as const;
  it("take the fixed facts of each new action and refuse others", () => {
    const base = { eventId: auditEventId("lesson.proposed", "o1"), orgId: ORG_A, action: "lesson.proposed", actor: { kind: "system", id: "rovara" }, target: TARGET["lesson.proposed"], occurredAt: "2026-10-30T10:00:00.000Z" };
    expect(AuditEventInputSchema.safeParse({ ...base, facts: { lessonType: "pitfall", tier: 1 } }).success).toBe(true);
    expect(AuditEventInputSchema.safeParse({ ...base, facts: { lessonType: "pitfall", title: "x" } }).success).toBe(false);
    const source = { ...base, eventId: auditEventId("record.source_added", "o1"), action: "record.source_added", target: TARGET["record.source_added"] };
    expect(AuditEventInputSchema.safeParse({ ...source, facts: { source: "slack", retention: "B", restricted: false } }).success).toBe(true);
    expect(AuditEventInputSchema.safeParse({ ...source, facts: { channelName: "secret-launch" } }).success).toBe(false);
  });
  it("keep every learning action's fact keys free of free-text slots", () => {
    for (const action of Object.keys(AUDIT_FACT_KEYS).filter((name) => name.startsWith("lesson.") || name.startsWith("record.")) as AuditAction[]) {
      expect(AUDIT_FACT_KEYS[action].some((key) => /text|title|body|message|channel|query/i.test(key)), action).toBe(false);
    }
  });
  it("lists the learned-context worker feature", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain("task.learnedContext.v1");
  });
});
