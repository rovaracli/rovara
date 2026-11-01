// v1.2 learning loop, B1: the contracts (design §3.1, §3.2, §6.2), the keys (I9) and the guardrails reader-first rollout (§2.5).
import { describe, expect, it } from "vitest";
import { readGuardrailsWithRevision, writeGuardrails } from "../../packages/broker/src/agents/guardrails.js";
import { AgentGuardrailsSchema, AgentGuardrailsWriteSchema, DEFAULT_AGENT_GUARDRAILS } from "../../packages/contracts/src/agent-guardrails.js";
import type { OrgId } from "../../packages/contracts/src/org.js";
import { agentGuardrailsKey, learningWalkKey, projectLearningKey, projectLearningPk, projectPlaybookKey } from "../../packages/contracts/src/org-scoped-keys.js";
import {
  LEARNING_RETENTION_DAYS, LearningAcceptAnswerReaderSchema, LearningAcceptBodySchema, LearningDismissBodySchema, LearningRememberBodySchema, LearningRuleRemoveAnswerReaderSchema,
  LearningSettingsAnswerReaderSchema, LearningSuggestionSchema, LearningTaskPageBodySchema, LearningViewAnswerReaderSchema, LearningWalkKindSchema, LearningCorrectionSchema,
} from "../../packages/contracts/src/project-learning.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const AT = "2026-10-30T10:00:00.000Z";
const uuid = "6f1c6b26-8a5e-4b43-9d0e-2f0d5a1f7c11";

describe("learning keys (I9)", () => {
  it("scope a partition to the org and the project, beside the playbook key", () => {
    expect(projectLearningKey(TEST_ORG, "web", "STATE")).toEqual({ pk: `ORG#${TEST_ORG}#PROJECT_LEARNING#web`, sk: "STATE" });
    expect(projectLearningPk(TEST_ORG, "web")).not.toBe(projectLearningPk(ORG_B, "web"));
    expect(projectLearningPk(TEST_ORG, "web")).not.toBe(projectLearningPk(TEST_ORG, "api"));
    expect(projectLearningPk(TEST_ORG, "web")).not.toBe(projectPlaybookKey(TEST_ORG, "web").pk);
  });
  it("refuse a project name or sort key that could reach another partition", () => {
    expect(() => projectLearningPk(TEST_ORG, "web#evil")).toThrow();
    expect(() => projectLearningPk(TEST_ORG, "")).toThrow();
    expect(() => projectLearningKey(TEST_ORG, "web", "")).toThrow();
    expect(() => projectLearningKey(TEST_ORG, "web", "STATE\u0000")).toThrow();
  });
  it("keep the walk item outside every project partition, per org", () => {
    expect(learningWalkKey(TEST_ORG, "close")).toEqual({ pk: `ORG#${TEST_ORG}#LEARNING_WALK`, sk: "close" });
    expect(learningWalkKey(TEST_ORG, "erase#dev1").pk).not.toContain("PROJECT_LEARNING");
    expect(learningWalkKey(TEST_ORG, "sweep").pk).not.toBe(learningWalkKey(ORG_B, "sweep").pk);
    expect(LearningWalkKindSchema.safeParse("erase#dev1").success).toBe(true);
    expect(LearningWalkKindSchema.safeParse("lock_off").success).toBe(false);
  });
});

describe("learning items", () => {
  const suggestion = { id: "s1", stage: "build", status: "open", correctionIds: ["a", "b"], allFromOnePerson: false, proposedText: "Use the shared retry helper.", signature: ["h1"], lessSafe: false, kinds: [], overlaps: [], revision: 0, createdAt: AT, projectCreatedAt: AT };
  it("keep proposedText and dismissNote only while a suggestion is not terminal, and expire a terminal one", () => {
    expect(LearningSuggestionSchema.safeParse(suggestion).success).toBe(true);
    for (const status of ["accepted", "dismissed", "withdrawn", "expired"]) {
      const terminal = { ...suggestion, status, terminalAt: AT, indexExpiresAt: 1_800_000_000 };
      expect(LearningSuggestionSchema.safeParse({ ...terminal, proposedText: undefined }).success, status).toBe(true);
      expect(LearningSuggestionSchema.safeParse(terminal).success, `${status} with proposedText`).toBe(false);
      expect(LearningSuggestionSchema.safeParse({ ...terminal, proposedText: undefined, dismissNote: "private" }).success, `${status} with dismissNote`).toBe(false);
      expect(LearningSuggestionSchema.safeParse({ ...terminal, proposedText: undefined, indexExpiresAt: undefined }).success, `${status} without expiry`).toBe(false);
    }
    expect(LearningSuggestionSchema.safeParse({ ...suggestion, indexExpiresAt: 1_800_000_000 }).success).toBe(false);
  });
  it("read a stored item that a newer writer added a field to", () => {
    const correction = { id: "c1", stage: "build", source: "comment", sourceRef: { taskId: "t1", commentId: "k1" }, taskId: "t1", text: "x".repeat(30), signature: [], author: "d1", standing: "member", createdAt: AT, projectCreatedAt: AT, indexExpiresAt: 1_800_000_000 };
    expect(LearningCorrectionSchema.safeParse({ ...correction, somethingNew: 1 }).success).toBe(true);
    expect(LearningCorrectionSchema.safeParse({ ...correction, text: "x".repeat(1001) }).success).toBe(false);
  });
  it("keeps 180 days", () => { expect(LEARNING_RETENTION_DAYS).toBe(180); });
});

describe("learning API contract (§6.2)", () => {
  it("refuses unknown fields in every request body", () => {
    expect(LearningTaskPageBodySchema.safeParse({}).success).toBe(true);
    expect(LearningTaskPageBodySchema.safeParse({ standing: "member" }).success).toBe(false);
    expect(LearningRememberBodySchema.safeParse({ requestId: uuid, taskId: "t", commentId: "c" }).success).toBe(true);
    expect(LearningRememberBodySchema.safeParse({ requestId: uuid, taskId: "t", commentId: "c", standing: "member" }).success).toBe(false);
    expect(LearningAcceptBodySchema.safeParse({ requestId: uuid, expectedRevision: 0, stage: "build", text: "Use the helper." }).success).toBe(true);
    expect(LearningAcceptBodySchema.safeParse({ requestId: uuid, expectedRevision: 0, stage: "build", text: "Use the helper.", author: "x" }).success).toBe(false);
    expect(LearningAcceptBodySchema.safeParse({ requestId: uuid, expectedRevision: 0, stage: "Build Stage", text: "x" }).success).toBe(false);
    expect(LearningDismissBodySchema.safeParse({ expectedRevision: 1, dismissKind: "one_off" }).success).toBe(true);
    expect(LearningDismissBodySchema.safeParse({ expectedRevision: 1, dismissKind: "rude" }).success).toBe(false);
  });
  it("lets an old client read an answer from a newer server", () => {
    const published = LearningAcceptAnswerReaderSchema.parse({ outcome: "published", version: 3, extra: true });
    expect(published).toMatchObject({ outcome: "published", version: 3 });
    expect(LearningAcceptAnswerReaderSchema.parse({ outcome: "queued_for_later", etaSeconds: 5 })).toMatchObject({ outcome: "unknown" });
    expect(LearningRuleRemoveAnswerReaderSchema.parse({ outcome: "needs_editor", stage: "build" })).toMatchObject({ outcome: "needs_editor" });
    expect(LearningSettingsAnswerReaderSchema.parse({ applied: false, proposalId: "p1", note: "new" })).toMatchObject({ applied: false, proposalId: "p1" });
    const view = LearningViewAnswerReaderSchema.parse({
      settings: { prComments: "sometimes", locked: false },
      suggestions: [{ id: "s", stage: "build", status: "snoozed", allFromOnePerson: true, lessSafe: false, lessSafeWords: [], overlaps: [], sources: [], revision: 1 }],
      dismissed: [], rules: [], skippedUnlinked: 2, canDecide: false, newField: 1,
    });
    expect(view.settings.prComments).toBe("unknown");
    expect(view.suggestions[0]?.status).toBe("unknown");
  });
});

describe("guardrails: prCommentLearning ships reader-first (§2.5)", () => {
  const stored = { ...structuredClone(DEFAULT_AGENT_GUARDRAILS), prCommentLearning: "locked_off" };
  it("reads a stored prCommentLearning instead of throwing CONFIG_INVALID", async () => {
    const table = new FakeDynamoDb();
    table.set({ ...agentGuardrailsKey(TEST_ORG), revision: 3, guardrails: stored });
    const read = await readGuardrailsWithRevision({ documentClient: table, tableName: "t" }, TEST_ORG);
    expect(read.revision).toBe(3);
    expect(read.guardrails.prCommentLearning).toBe("locked_off");
    expect(AgentGuardrailsSchema.safeParse(DEFAULT_AGENT_GUARDRAILS).success).toBe(true);
    expect(AgentGuardrailsSchema.safeParse({ ...stored, prCommentLearning: "maybe" }).success).toBe(false);
    expect(AgentGuardrailsSchema.safeParse({ ...stored, somethingElse: 1 }).success).toBe(false);
  });
  it("has no writer yet: a write that names the field is refused until B8", async () => {
    expect(AgentGuardrailsWriteSchema.safeParse(stored).success).toBe(false);
    expect(AgentGuardrailsWriteSchema.safeParse(DEFAULT_AGENT_GUARDRAILS).success).toBe(true);
    const deps = { documentClient: new FakeDynamoDb(), tableName: "t", store: { putGuardrails: async () => { throw new Error("must not be reached"); } } };
    await expect(writeGuardrails(deps as never, TEST_ORG, stored as never, "d1", { actor: {} as never, expectedRevision: 0 })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
