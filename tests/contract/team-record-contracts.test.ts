import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUDIT_FACT_KEYS, AuditEventInputSchema, ProposalCandidateSchema, RecordEventSchema, RecordFactSchema, RecordSearchResponseSchema, SourceConfigSchema, TRUST_RANK,
  SOURCE_WIDENED_WORDS, SourceWriteBodySchema, SourceWriteReplySchema, SourceWriteReplyReaderSchema, SourcesAdminViewSchema, SourcesAdminViewReaderSchema,
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
  it("reads a stored source row with no revision (written before the source route) and one with a revision, and still refuses unknown fields", () => {
    // Built EXACTLY as putSourceConfig writes today: the parsed config spread into the item, no revision key at all.
    const legacy = { workspaceId: ORG_A, project: "web", source: "slack", scope: "slack:T1/C9", enabled: true, retention: "A", exclude: [], audienceDefault: "maintainers", health: "unknown", addedBy: "dev-1", updatedAt: "2026-10-30T10:00:00.000Z" };
    const parsedLegacy = SourceConfigSchema.safeParse(legacy);
    expect(parsedLegacy.success).toBe(true);
    // A missing revision reads as 0 by the reader's rule; the schema does not invent the key, so an old row stays byte-for-byte what it was.
    expect(parsedLegacy.success && "revision" in parsedLegacy.data).toBe(false);
    expect(SourceConfigSchema.safeParse({ ...legacy, revision: 0 }).success).toBe(true);
    expect(SourceConfigSchema.safeParse({ ...legacy, revision: 7 }).success).toBe(true);
    expect(SourceConfigSchema.safeParse({ ...legacy, revision: -1 }).success).toBe(false);
    expect(SourceConfigSchema.safeParse({ ...legacy, revision: 1.5 }).success).toBe(false);
    expect(SourceConfigSchema.safeParse({ ...legacy, revision: "1" }).success).toBe(false);
    expect(SourceConfigSchema.safeParse({ ...legacy, revisionn: 1 }).success).toBe(false);
    expect(SourceConfigSchema.safeParse({ ...legacy, extra: true }).success).toBe(false);
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
  it("takes the fixed `widened` fact on a source add and change (T9: the words of what a no-approval write widened), and nothing from the client", () => {
    const base = { orgId: ORG_A, actor: { kind: "member", id: "dev-1" }, target: { kind: "record_source", id: "abc" }, occurredAt: "2026-10-30T10:00:00.000Z" };
    const added = { ...base, eventId: auditEventId("record.source_added", "c1"), action: "record.source_added" };
    expect(AuditEventInputSchema.safeParse({ ...added, facts: { source: "slack", retention: "D", restricted: true, widened: "retention_raise,private_channel" } }).success).toBe(true);
    expect(AuditEventInputSchema.safeParse({ ...added, facts: { source: "slack", scope: "slack:T1/C9" } }).success).toBe(false);
    const changed = { ...base, eventId: auditEventId("record.source_changed", "c1"), action: "record.source_changed" };
    expect(AuditEventInputSchema.safeParse({ ...changed, facts: { source: "github", fromRetention: "C", toRetention: "D", enabled: true, widened: "retention_raise" } }).success).toBe(true);
    expect(AuditEventInputSchema.safeParse({ ...changed, facts: { source: "github", changeId: "chg_1" } }).success).toBe(false);
    // `via` (task 12): `slack` when the source was added from a Slack interaction; absent for the web.
    expect(AUDIT_FACT_KEYS["record.source_added"]).toStrictEqual(["source", "retention", "restricted", "widened", "via"]);
    expect(AuditEventInputSchema.safeParse({ ...added, facts: { source: "slack", retention: "C", restricted: false, via: "slack" } }).success).toBe(true);
    expect(AUDIT_FACT_KEYS["record.source_changed"]).toStrictEqual(["source", "fromRetention", "toRetention", "enabled", "widened"]);
    expect(SOURCE_WIDENED_WORDS).toStrictEqual(["retention_raise", "private_channel", "dm", "mpim"]);
  });
  it("has no second-person source actions any more (T9: every editor's change applies at once)", () => {
    expect(Object.keys(AUDIT_FACT_KEYS)).not.toContain("record.source_change_proposed");
    expect(Object.keys(AUDIT_FACT_KEYS)).not.toContain("record.source_change_decided");
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

describe("source row write contracts", () => {
  const REQUEST = "5b8e9f4c-2b1a-4c1e-9a53-3f2d3d1a0002";
  const add = { action: "add", requestId: REQUEST, source: "slack", scope: "slack:T1/C9", retention: "B", audienceDefault: "maintainers", enabled: true };
  const change = { action: "change", requestId: REQUEST, source: "slack", scope: "slack:T1/C9", expectedRevision: 0, retention: "C" };
  const remove = { action: "remove", requestId: REQUEST, source: "slack", scope: "slack:T1/C9", expectedRevision: 2 };
  const body = (value: unknown) => SourceWriteBodySchema.safeParse(value).success;
  const without = (value: Record<string, unknown>, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

  it("takes an add with the exact fields and refuses anything else", () => {
    expect(body(add)).toBe(true);
    expect(body({ ...add, exclude: ["a", "b"], notesOptIn: true })).toBe(true);
    expect(body({ ...add, source: "codehost:gitfarm" })).toBe(true);
    expect(body({ ...add, source: "bitbucket" })).toBe(false);
    expect(body({ ...add, requestId: "not-a-uuid" })).toBe(false);
    expect(body({ ...add, retention: "E" })).toBe(false);
    expect(body({ ...add, audienceDefault: "everyone" })).toBe(false);
    expect(body({ ...add, notesOptIn: false })).toBe(false);
    expect(body({ ...add, notesOptIn: null })).toBe(false);
    expect(body({ ...add, extra: 1 })).toBe(false);
    expect(body({ ...add, workspaceId: ORG_A })).toBe(false); // the org comes only from the session
    expect(body({ ...add, project: "web" })).toBe(false);
    for (const key of ["requestId", "source", "scope", "retention", "audienceDefault", "enabled"]) {
      expect(body(without(add, key)), key).toBe(false);
    }
  });
  it("bounds the scope and refuses control and format characters in it", () => {
    expect(body({ ...add, scope: "x".repeat(300) })).toBe(true);
    expect(body({ ...add, scope: "x".repeat(301) })).toBe(false);
    expect(body({ ...add, scope: "" })).toBe(false);
    for (const bad of ["a\u0000b", "a\nb", "a\u001bb", "a\u200bb", "a\u202eb", "a\u2066b", "a\u007fb"]) {
      expect(body({ ...add, scope: bad }), JSON.stringify(bad)).toBe(false);
      expect(body({ ...change, scope: bad }), JSON.stringify(bad)).toBe(false);
      expect(body({ ...remove, scope: bad }), JSON.stringify(bad)).toBe(false);
    }
  });
  it("bounds the exclude list", () => {
    expect(body({ ...add, exclude: Array.from({ length: 200 }, (_, index) => `e${String(index)}`) })).toBe(true);
    expect(body({ ...add, exclude: Array.from({ length: 201 }, (_, index) => `e${String(index)}`) })).toBe(false);
    expect(body({ ...add, exclude: [""] })).toBe(false);
    expect(body({ ...add, exclude: ["x".repeat(301)] })).toBe(false);
    expect(body({ ...change, exclude: Array.from({ length: 201 }, () => "e") })).toBe(false);
  });
  it("takes a change with a revision and at least one change field", () => {
    expect(body(change)).toBe(true);
    expect(body({ ...change, retention: undefined, audienceDefault: "project" })).toBe(true);
    expect(body({ ...change, retention: undefined, enabled: false })).toBe(true);
    expect(body({ ...change, retention: undefined, exclude: [] })).toBe(true); // clearing the list is a change
    expect(body({ ...change, retention: undefined, notesOptIn: true })).toBe(true);
    expect(body({ ...change, retention: undefined, notesOptIn: null })).toBe(true); // null takes the opt-in away
    const empty = { action: "change", requestId: REQUEST, source: "slack", scope: "slack:T1/C9", expectedRevision: 0 };
    expect(body(empty)).toBe(false);
    expect(body({ ...empty, retention: undefined })).toBe(false);
    expect(body({ ...change, expectedRevision: -1 })).toBe(false);
    expect(body({ ...change, expectedRevision: 1.5 })).toBe(false);
    expect(body(without(change, "expectedRevision"))).toBe(false);
    expect(body({ ...change, notesOptIn: false })).toBe(false);
    expect(body({ ...change, extra: 1 })).toBe(false);
  });
  it("takes a remove with a revision", () => {
    expect(body(remove)).toBe(true);
    expect(body({ ...remove, expectedRevision: 0 })).toBe(true);
    expect(body({ ...remove, expectedRevision: -1 })).toBe(false);
    expect(body(without(remove, "expectedRevision"))).toBe(false);
    expect(body({ ...remove, retention: "A" })).toBe(false);
  });
  it("has no approve or reject action any more: an old body is refused whatever it carries (T9)", () => {
    for (const action of ["approve", "reject"]) {
      expect(body({ action, changeId: "chg_AbC-123" }), action).toBe(false);
      expect(body({ action }), action).toBe(false);
      expect(body({ action, changeId: "chg_1", requestId: REQUEST }), action).toBe(false);
    }
  });
  it("refuses an unknown or missing action", () => {
    expect(body({ ...add, action: "delete" })).toBe(false);
    expect(body({ ...add, action: undefined })).toBe(false);
    expect(body(null)).toBe(false);
    expect(body("add")).toBe(false);
  });

  it("answers a write with one of two fixed replies: saved or removed (T9: nothing waits)", () => {
    const reply = (value: unknown) => SourceWriteReplySchema.safeParse(value).success;
    expect(reply({ status: "saved", revision: 1 })).toBe(true);
    expect(reply({ status: "saved", revision: 0 })).toBe(true);
    expect(reply({ status: "saved" })).toBe(false);
    expect(reply({ status: "saved", revision: -1 })).toBe(false);
    expect(reply({ status: "needs_approval", changeId: "chg_1", expiresAt: "2026-11-11T10:00:00.000Z" })).toBe(false);
    expect(reply({ status: "rejected" })).toBe(false);
    expect(reply({ status: "removed" })).toBe(true);
    expect(reply({ status: "removed", reason: "free text" })).toBe(false);
    expect(reply({ status: "other" })).toBe(false);
    // The reader keeps a field a newer server adds and reads a status it does not know as "unknown".
    expect(SourceWriteReplyReaderSchema.safeParse({ status: "saved", revision: 2, note: "x" }).success).toBe(true);
    expect(SourceWriteReplyReaderSchema.safeParse({ status: "later" }).success).toBe(true);
  });

  const adminRow = { kind: "slack", scope: "slack:T1/C9", enabled: true, retention: "B", health: "ok", audience: "maintainers", excluded: 1, updatedAt: "2026-11-04T10:00:00.000Z", paused: false, revision: 2, addedBy: "dev-1", exclude: ["slack:T1/C1"] };
  const admin = {
    sources: [adminRow, { ...adminRow, scope: "slack:T1/G9", revision: 0, approval: { by: "dev-2", at: "2026-11-04T11:00:00.000Z" } }], otherPaused: 0,
    canEdit: true, offered: { slack: ["A", "B"], github: ["A", "B", "C", "D"] },
  };
  it("shows an editor the rows with their revision and what the edition offers (no waiting changes, no sole approver: T9)", () => {
    const parse = (value: unknown) => SourcesAdminViewSchema.safeParse(value).success;
    expect(parse(admin)).toBe(true);
    expect(parse({ ...admin, offered: {} })).toBe(true);
    expect(parse({ ...admin, canEdit: undefined })).toBe(false);
    expect(parse({ ...admin, offered: { slack: ["E"] } })).toBe(false);
    // The second-person fields are gone from the view (strict): an old shape is refused here, and the web reader still reads it.
    expect(parse({ ...admin, pending: [] })).toBe(false);
    expect(parse({ ...admin, soleApprover: false })).toBe(false);
    // The Public edition's "notes with links" switch is shown only when the server says so.
    expect(parse({ ...admin, notesSwitch: true })).toBe(true);
    expect(parse({ ...admin, notesSwitch: false })).toBe(false);
    expect(SourcesAdminViewReaderSchema.safeParse({ ...admin, pending: [], soleApprover: false }).success).toBe(true);
    expect(parse({ ...admin, sources: [{ ...adminRow, revision: undefined }] })).toBe(false);
    expect(parse({ ...admin, sources: [{ ...adminRow, scope: undefined }] })).toBe(false); // an editor always sees the place
    expect(parse({ ...admin, extra: 1 })).toBe(false);
    // TRW-4: the skipped-for-unlinked-author counts, per source, as the route always gave them to maintainers.
    expect(parse({ ...admin, skippedUnlinked: { jira: 3 } })).toBe(true);
    expect(parse({ ...admin, skippedUnlinked: {} })).toBe(true);
    expect(parse({ ...admin, skippedUnlinked: { jira: -1 } })).toBe(false);
    expect(parse({ ...admin, skippedUnlinked: { jira: 1.5 } })).toBe(false);
    expect(SourcesAdminViewReaderSchema.safeParse({ ...admin, extra: 1 }).success).toBe(true);
  });
});
