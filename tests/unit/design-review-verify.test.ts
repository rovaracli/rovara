// Design review stage, DR4 (design-review-stage.md 3.4 steps 2 to 4): the broker verifies a worker's report against the packet it built.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { READ_ONLY_TOOLS, REVIEWER_VERIFY_FAILURES, ReviewerRunSchema } from "@agentx/contracts";
import { buildReviewerPacket, packetDigestOf, type PacketReaders } from "../../packages/broker/src/design-review/packet.js";
import {
  verifyReviewerReport, verifyRound, runVerdictOf, type FirstCallUsageReader, type UsageCheck, type VerifyReviewerInput,
} from "../../packages/broker/src/design-review/verify.js";

const keyOf = (name: string): string => createHash("sha256").update(name).digest("hex");
const KEY = keyOf("critic-key");
const DIGEST = "d".repeat(64);
const packet = { packetDigest: DIGEST, estimatedInputTokens: 10_000 };
const report = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: "ses_1", packetDigest: DIGEST, firstRequestMessages: 2, filesRead: ["src/a.ts"], tools: ["read", "grep"], ...overrides,
});
const reader = (record: Awaited<ReturnType<FirstCallUsageReader["firstCall"]>> | "throw" | "none" = { firstCallInputTokens: 10_000, calls: 3 }) => {
  const firstCall = vi.fn<FirstCallUsageReader["firstCall"]>(async () => {
    if (record === "throw") throw new Error("proxy down: token sk-SECRET");
    return record === "none" ? undefined : record;
  });
  return { reader: { firstCall } satisfies FirstCallUsageReader, firstCall };
};
const proxy = (r = reader()): UsageCheck => ({ kind: "proxy", reader: r.reader });
const input = (overrides: Partial<VerifyReviewerInput> = {}): VerifyReviewerInput => ({
  packet, report: report(), usedSessionIds: new Set(), modelKey: { keyId: KEY, otherReviewerKeyIds: new Set() }, usage: proxy(), ...overrides,
});

describe("verifyReviewerReport: a clean run", () => {
  it("passes when digest, session, tools, key and first call all hold, and says the proxy confirmed the input", async () => {
    await expect(verifyReviewerReport(input())).resolves.toEqual({ verified: true, sessionId: "ses_1", filesRead: ["src/a.ts"], inputProof: "digest_and_usage", firstCallInputTokens: 10_000 });
  });

  it("accepts every read-only tool the platform defines, and a reviewer that read no files", async () => {
    const result = await verifyReviewerReport(input({ report: report({ tools: [...READ_ONLY_TOOLS], filesRead: [] }) }));
    expect(result.verified).toBe(true);
  });

  it("asks the proxy for the key the broker minted, not a key the worker names", async () => {
    const r = reader();
    await verifyReviewerReport(input({ usage: proxy(r), report: report({ modelKeyId: KEY }) }));
    expect(r.firstCall).toHaveBeenCalledWith(KEY);
  });
});

describe("verifyReviewerReport: each failure voids the run with its own code", () => {
  it("packet digest mismatch", async () => {
    const r = reader();
    await expect(verifyReviewerReport(input({ report: report({ packetDigest: "e".repeat(64) }), usage: proxy(r) }))).resolves.toEqual({ verified: false, failure: "packet_digest_mismatch" });
    expect(r.firstCall).not.toHaveBeenCalled();
  });

  it("a session id already used in this task is refused", async () => {
    await expect(verifyReviewerReport(input({ usedSessionIds: new Set(["ses_0", "ses_1"]) }))).resolves.toEqual({ verified: false, failure: "session_reused" });
  });

  it("any tool outside READ_ONLY_TOOLS is refused, whatever else is on the list", async () => {
    for (const tool of ["bash", "write", "edit", "Read", "mcp__x__y", ""]) {
      const result = await verifyReviewerReport(input({ report: report({ tools: ["read", tool] }) }));
      expect(result, tool).toEqual({ verified: false, failure: tool === "" ? "unreadable_output" : "tool_not_read_only" });
    }
  });

  it("a model key that is another reviewer's is refused", async () => {
    await expect(verifyReviewerReport(input({ modelKey: { keyId: KEY, otherReviewerKeyIds: new Set([KEY]) } }))).resolves.toEqual({ verified: false, failure: "model_key_mismatch" });
  });

  it("a worker that names a different key than the one minted is refused", async () => {
    await expect(verifyReviewerReport(input({ report: report({ modelKeyId: keyOf("other") }) }))).resolves.toEqual({ verified: false, failure: "model_key_mismatch" });
  });

  it("a key id that is not a proxy token id is refused", async () => {
    await expect(verifyReviewerReport(input({ modelKey: { keyId: "key_1", otherReviewerKeyIds: new Set() } }))).resolves.toEqual({ verified: false, failure: "model_key_mismatch" });
  });

  it("a first request with history (more than system + one user message) does not match the packet", async () => {
    for (const messages of [1, 3, 20]) {
      await expect(verifyReviewerReport(input({ report: report({ firstRequestMessages: messages }) }))).resolves.toEqual({ verified: false, failure: "first_call_mismatch" });
    }
  });

  it("a first call outside 10% of the estimate, either way, is refused; at the edge it passes", async () => {
    for (const tokens of [8_999, 11_001, 40_000, 1]) {
      await expect(verifyReviewerReport(input({ usage: proxy(reader({ firstCallInputTokens: tokens, calls: 1 })) })), String(tokens)).resolves.toEqual({ verified: false, failure: "first_call_mismatch" });
    }
    for (const tokens of [9_000, 11_000]) {
      await expect(verifyReviewerReport(input({ usage: proxy(reader({ firstCallInputTokens: tokens, calls: 1 })) })), String(tokens)).resolves.toMatchObject({ verified: true });
    }
  });

  it("a key with no usage record is no_usage_record, never a pass; so is a reader that throws or returns nonsense", async () => {
    for (const record of ["none", "throw", { firstCallInputTokens: 0, calls: 1 }, { firstCallInputTokens: Number.NaN, calls: 1 }, { firstCallInputTokens: 10_000, calls: 0 }] as const) {
      await expect(verifyReviewerReport(input({ usage: proxy(reader(record as never)) }))).resolves.toEqual({ verified: false, failure: "no_usage_record" });
    }
  });

  it("an unreadable report is unreadable_output: wrong types, missing fields, extra fields, not an object", async () => {
    for (const bad of [null, "text", 5, [], {}, report({ sessionId: 5 }), report({ filesRead: "a" }), report({ tools: undefined }), { ...report(), extra: true }, report({ firstRequestMessages: "2" }), report({ filesRead: Array.from({ length: 201 }, () => "a") })]) {
      await expect(verifyReviewerReport(input({ report: bad })), JSON.stringify(bad)).resolves.toEqual({ verified: false, failure: "unreadable_output" });
    }
  });

  it("checks run in a fixed order: the digest is judged before the session, tools and key", async () => {
    const result = await verifyReviewerReport(input({
      report: report({ packetDigest: "e".repeat(64), tools: ["bash"] }), usedSessionIds: new Set(["ses_1"]), modelKey: { keyId: KEY, otherReviewerKeyIds: new Set([KEY]) },
    }));
    expect(result).toEqual({ verified: false, failure: "packet_digest_mismatch" });
  });

  it("every failure is one of the contract's fixed codes, and fills a valid ReviewerRun verdict", async () => {
    const result = await verifyReviewerReport(input({ report: report({ tools: ["bash"] }) }));
    if (result.verified) throw new Error("expected a void");
    expect(REVIEWER_VERIFY_FAILURES).toContain(result.failure);
    const run = {
      role: "critic", promptId: "p", promptVersion: 1, promptDigest: DIGEST, model: { provider: "a", modelId: "m" }, sourceId: "s", sessionId: "ses_1", modelKeyId: KEY, packetDigest: DIGEST,
      packet: [], filesRead: [], tokensIn: 0, tokensOut: 0, costUsd: 0, startedAt: "2026-11-03T10:00:00Z", endedAt: "2026-11-03T10:01:00Z", ...runVerdictOf(result),
    };
    expect(ReviewerRunSchema.safeParse(run).success).toBe(true);
    expect(ReviewerRunSchema.safeParse({ ...run, ...runVerdictOf({ verified: true, sessionId: "s", filesRead: [], inputProof: "digest_only" }) }).success).toBe(false);
  });

  it("does not carry any text from the report or the proxy error into the result", async () => {
    const result = await verifyReviewerReport(input({ usage: proxy(reader("throw")) }));
    expect(JSON.stringify(result)).not.toContain("sk-SECRET");
  });
});

describe("verifyReviewerReport: no usage reader installed", () => {
  it("passes on the digest alone and says so, so the card can say so", async () => {
    await expect(verifyReviewerReport(input({ usage: { kind: "unavailable" } }))).resolves.toEqual({ verified: true, sessionId: "ses_1", filesRead: ["src/a.ts"], inputProof: "digest_only" });
  });

  it("still fails the digest, session, tool and key checks", async () => {
    const usage: UsageCheck = { kind: "unavailable" };
    await expect(verifyReviewerReport(input({ usage, report: report({ packetDigest: "e".repeat(64) }) }))).resolves.toMatchObject({ failure: "packet_digest_mismatch" });
    await expect(verifyReviewerReport(input({ usage, usedSessionIds: new Set(["ses_1"]) }))).resolves.toMatchObject({ failure: "session_reused" });
    await expect(verifyReviewerReport(input({ usage, report: report({ tools: ["bash"] }) }))).resolves.toMatchObject({ failure: "tool_not_read_only" });
    await expect(verifyReviewerReport(input({ usage, modelKey: { keyId: KEY, otherReviewerKeyIds: new Set([KEY]) } }))).resolves.toMatchObject({ failure: "model_key_mismatch" });
  });
});

describe("verifyRound: a whole round", () => {
  const keys = { a: keyOf("a"), b: keyOf("b"), c: keyOf("c") };
  const reviewer = (name: "a" | "b" | "c", reportOverrides: Record<string, unknown> = {}, keyId = keys[name]) => ({ role: name, packet, report: report({ sessionId: `ses_${name}`, ...reportOverrides }), keyId });
  const round = (reviewers: ReturnType<typeof reviewer>[], extra: { priorSessionIds?: Set<string>; priorKeyIds?: Set<string> } = {}) =>
    verifyRound({ reviewers, priorSessionIds: extra.priorSessionIds ?? new Set(), priorKeyIds: extra.priorKeyIds ?? new Set(), usage: proxy() });

  it("verifies each reviewer on its own report and key, in order (per-case attribution)", async () => {
    const r = reader();
    const results = await verifyRound({ reviewers: [reviewer("a"), reviewer("b", { tools: ["bash"] }), reviewer("c")], priorSessionIds: new Set(), priorKeyIds: new Set(), usage: proxy(r) });
    expect(results.map((result) => (result.verified ? "ok" : result.failure))).toEqual(["ok", "tool_not_read_only", "ok"]);
    expect(results[0]).toMatchObject({ sessionId: "ses_a" });
    expect(results[2]).toMatchObject({ sessionId: "ses_c" });
    expect(r.firstCall.mock.calls.map((call) => call[0])).toEqual([keys.a, keys.c]);
  });

  it("voids both reviewers that report the same session id", async () => {
    const results = await round([reviewer("a", { sessionId: "ses_same" }), reviewer("b", { sessionId: "ses_same" }), reviewer("c")]);
    expect(results.map((result) => (result.verified ? "ok" : result.failure))).toEqual(["session_reused", "session_reused", "ok"]);
  });

  it("refuses a session id used in an earlier round", async () => {
    const results = await round([reviewer("a"), reviewer("b")], { priorSessionIds: new Set(["ses_b"]) });
    expect(results.map((result) => (result.verified ? "ok" : result.failure))).toEqual(["ok", "session_reused"]);
  });

  it("voids every reviewer that shares a model key with another reviewer, or with an earlier run", async () => {
    const shared = await round([reviewer("a"), reviewer("b", {}, keys.a), reviewer("c")]);
    expect(shared.map((result) => (result.verified ? "ok" : result.failure))).toEqual(["model_key_mismatch", "model_key_mismatch", "ok"]);
    const reused = await round([reviewer("a"), reviewer("b")], { priorKeyIds: new Set([keys.b]) });
    expect(reused.map((result) => (result.verified ? "ok" : result.failure))).toEqual(["ok", "model_key_mismatch"]);
  });
});

describe("end to end with a real packet", () => {
  const readers: PacketReaders = { readRepoFile: async () => "code", readMetaFile: async () => "meta", fetchMcpItem: async () => ({ ok: false }) };
  const build = () => buildReviewerPacket({
    role: "critic", rolePrompt: { id: "design-critic", version: 1, text: "rules" }, design: { ref: "design.md", revision: "r1", text: "design" }, requirements: { ref: "requirements.md", revision: "r1", text: "reqs" },
    baseCommits: { api: "a".repeat(40) }, sources: [{ kind: "repo_file", repo: "api", path: "src/a.ts" }],
  }, readers);

  it("passes when the worker recomputes the digest from the packet it was sent", async () => {
    const built = await build();
    const result = await verifyReviewerReport(input({ packet: built, report: report({ packetDigest: packetDigestOf(built) }), usage: proxy(reader({ firstCallInputTokens: built.estimatedInputTokens, calls: 1 })) }));
    expect(result.verified).toBe(true);
  });

  it("voids a worker that sent a different document and recomputed honestly", async () => {
    const built = await build();
    const sent = { ...built, documents: built.documents.map((document, index) => (index === 0 ? { ...document, text: `${document.text} plus the planner's reasoning` } : document)) };
    const result = await verifyReviewerReport(input({ packet: built, report: report({ packetDigest: packetDigestOf(sent) }), usage: { kind: "unavailable" } }));
    expect(result).toEqual({ verified: false, failure: "packet_digest_mismatch" });
  });
});
