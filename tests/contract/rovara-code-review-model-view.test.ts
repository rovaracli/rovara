// Playbook P2: the task view (version 2) carries the reviewer-model lines that A2's `reviewModelLines` gives the pull request's Reviews section, so the Tests tab can show the same words.
// There is one source: the review reports' recorded model and `reviewSameModelOf`; the view only passes the lines on.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DeveloperTaskViewSchema } from "../../packages/contracts/src/developer-tasks.js";
import { createCandidateManifest, type WorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { REVIEW_SAME_MODEL_NOTE, reviewModelLines } from "../../packages/broker/src/rovara-code/review-model-lines.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";

const now = "2026-10-27T12:00:00.000Z";
const CODE = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
const OTHER = createCandidateManifest([{ repositoryId: "demo", commitSha: "f".repeat(40), treeSha: "c".repeat(40), baseCommitSha: "e".repeat(40) }]);
const review = (role: "CRITIC" | "SECURITY", provider: string, version: string, candidateDigest = CODE.digest) => ({ operationId: randomUUID(), candidateDigest, role, provider, version, status: "PASS", findings: [], readOnly: true, recordedAt: now });

async function reviewedTask(options: { reviews?: ReturnType<typeof review>[]; sameModelFor?: string; definitionVersion?: "1.0.0" | "1.1.0" } = {}) {
  const harness = await createSingleAnswerPlanBroker();
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const id = String((started.body.task as { taskId: string }).taskId);
  const record = () => harness.db.get(`DEVTASK#${id}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot };
  harness.db.set({
    ...record(), ...(options.sameModelFor === undefined ? {} : { reviewSameModel: { candidateDigest: options.sameModelFor } }),
    workflow: { ...record().workflow, definitionVersion: options.definitionVersion ?? "1.1.0", candidate: CODE, reviews: options.reviews ?? [review("CRITIC", "anthropic", "claude-opus-4-6"), review("SECURITY", "anthropic", "claude-opus-4-6")] },
  });
  const read = async (headers: Record<string, string> = { "x-agentx-task-view": "2" }) => {
    const response = await harness.dev(MAYA, "GET", `/v1/dev/tasks/${id}`, undefined, headers);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.task as Record<string, unknown>;
  };
  return { harness, id, record, read };
}

describe("the task view's reviewer model lines", () => {
  it("names the model the reviews recorded, in A2's words, with no same-model note when another model reviewed", async () => {
    const { read, record } = await reviewedTask();
    const view = await read();
    expect(view["reviewModelLines"]).toEqual(["Reviewed by anthropic/claude-opus-4-6"]);
    // The one source: exactly what A2's function gives the pull request's Reviews section for this workflow.
    expect(view["reviewModelLines"]).toEqual(reviewModelLines(record().workflow, false));
    expect(DeveloperTaskViewSchema.safeParse(view).success).toBe(true);
  });

  it("adds A2's same-model note, word for word, when the reviews of this code ran on the build's model", async () => {
    const { read, record } = await reviewedTask({ sameModelFor: CODE.digest });
    const view = await read();
    expect(view["reviewModelLines"]).toEqual(["Reviewed by anthropic/claude-opus-4-6", REVIEW_SAME_MODEL_NOTE]);
    expect(view["reviewModelLines"]).toEqual(reviewModelLines(record().workflow, true));
  });

  it("names each role's model when the two reviews ran on different models", async () => {
    const { read } = await reviewedTask({ reviews: [review("CRITIC", "anthropic", "claude-opus-4-6"), review("SECURITY", "openai", "gpt-x")] });
    expect(await read()).toMatchObject({ reviewModelLines: ["Reviewed by code review: anthropic/claude-opus-4-6; security review: openai/gpt-x"] });
  });

  it("does not say the note of an earlier candidate's review about the code now on the task", async () => {
    const { read } = await reviewedTask({ sameModelFor: OTHER.digest });
    expect(await read()).toMatchObject({ reviewModelLines: ["Reviewed by anthropic/claude-opus-4-6"] });
  });

  it("is absent before any review of the current code, for a version 1 task, and for a client that does not ask for the version 2 view", async () => {
    expect(await (await reviewedTask({ reviews: [] })).read()).not.toHaveProperty("reviewModelLines");
    expect(await (await reviewedTask({ reviews: [review("CRITIC", "anthropic", "claude-opus-4-6", OTHER.digest)] })).read()).not.toHaveProperty("reviewModelLines");
    expect(await (await reviewedTask({ definitionVersion: "1.0.0" })).read()).not.toHaveProperty("reviewModelLines");
    expect(await (await reviewedTask()).read({})).not.toHaveProperty("reviewModelLines");
  });

  it("keeps a model name from a report within the field: no markup survives a plain-text reader's escaping (the same name text A2 gives GitHub)", async () => {
    const { read } = await reviewedTask({ reviews: [review("CRITIC", "evil", "x".repeat(500))] });
    const lines = (await read())["reviewModelLines"] as string[];
    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThanOrEqual(200);
  });
});
