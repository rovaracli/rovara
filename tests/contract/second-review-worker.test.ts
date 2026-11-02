// SR-1, the worker side of the second review: the reviewer runs INSIDE the review operation, after the normal reviews, on its own model, in a bounded loop of at most 3 tries (the same model once more, then the next
// candidate). Its report is handed back separately (`onSecondReview`) and is never one of the returned reports, so it cannot be mistaken for the first review's.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SECOND_REVIEWER_FEATURE, SecondReviewerSchema, WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, nextSecondReviewModel, secondReviewTryOutcome, type SecondReviewResult } from "../../packages/contracts/src/index.js";
import { runWorkflowReviews } from "../../packages/worker/src/verification/review.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { secondReviewerRuntimes } from "../../packages/worker/src/task-model.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";

const execFile = promisify(execFileCallback);
const now = "2026-11-02T12:00:00.000Z";
const OPERATION = "11111111-1111-4111-8111-111111111111";

async function repository() {
  const rootPath = await mkdtemp(join(tmpdir(), "rovara-second-review-"));
  const directory = join(rootPath, "repo", "payments");
  await mkdir(directory, { recursive: true });
  const git = async (...args: string[]) => (await execFile("git", ["-C", directory, ...args], { encoding: "utf8" })).stdout.trim();
  await git("init", "--quiet");
  await git("config", "user.email", "review@example.invalid");
  await git("config", "user.name", "Review Test");
  await writeFile(join(directory, "app.ts"), "export const value = 1;\n");
  await git("add", "app.ts");
  await git("commit", "--quiet", "-m", "baseline");
  const baseCommitSha = await git("rev-parse", "HEAD");
  await writeFile(join(directory, "app.ts"), "export const value = 2;\n");
  const { readCandidateRepositories } = await import("../../packages/worker/src/verification/candidate.js");
  const repositories = [{ repositoryId: "payments", directory }];
  const candidate = await readCandidateRepositories([{ ...repositories[0]!, baseCommitSha }]);
  return { rootPath, repositories, candidate };
}

/** A model: `script` is its answers in order ("throw" = the session fails); `prompts` counts what it was asked. */
function model(id: string, script: string[], prompts: string[]): { model: { provider: string; modelId: string }; piAdapter: PiSessionAdapter } {
  let next = 0;
  return {
    model: { provider: "test", modelId: id },
    piAdapter: {
      async create(input) {
        const sessionFile = join(input.sessionDirectory, `${input.conversationId}.jsonl`);
        await writeFile(sessionFile, "{}");
        let listener: ((event: unknown) => void) | undefined;
        return {
          conversationId: input.conversationId ?? "review-session", sessionFile,
          async prompt(text) {
            prompts.push(`${id}:${text.includes("Review role: CODE") ? "CODE" : text.includes("Review role: SECURITY") ? "SECURITY" : "RETRY"}`);
            const answer = script[Math.min(next, script.length - 1)]!;
            next += 1;
            if (answer === "throw") throw new Error("the session failed");
            listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }] } });
          },
          async abort() {},
          getModel: () => ({ provider: "test", modelId: id }),
          getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } as never),
          subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
          dispose() {},
        };
      },
    },
  };
}

const PASS = '{"findings":[]}';
const FINDING = '{"findings":[{"text":"off by one in the loop bound","origin":"INTRODUCED"}]}';

async function run(options: { first: ReturnType<typeof model>; candidates?: Array<ReturnType<typeof model>>; reviewers?: Array<"CRITIC" | "SECURITY"> }) {
  const { rootPath, repositories, candidate } = await repository();
  let second: SecondReviewResult | undefined;
  try {
    const reports = await runWorkflowReviews({
      ruleFileBaseCommits: [], operationId: OPERATION, rootPath, model: options.first.model, candidate, repositories, piAdapter: options.first.piAdapter, now: () => now,
      ...(options.reviewers === undefined ? {} : { reviewers: options.reviewers }),
      ...(options.candidates === undefined ? {} : { secondReviewer: { candidates: options.candidates }, onSecondReview: (result: SecondReviewResult) => { second = result; } }),
    });
    return { reports, second };
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

describe("the second reviewer inside the review operation", () => {
  it("runs after the normal reviews, on its own model, and its report is returned beside them, never among them", async () => {
    const prompts: string[] = [];
    const first = model("first-v1", [PASS], prompts);
    const a = model("second-a", [FINDING], prompts);
    const { reports, second } = await run({ first, candidates: [a] });
    expect(reports.map((report) => report.role)).toEqual(["CRITIC", "SECURITY"]);
    expect(reports.every((report) => report.version === "first-v1")).toBe(true);
    expect(second).toMatchObject({ tries: 1, report: { role: "CRITIC", provider: "test", version: "second-a", status: "FINDINGS", operationId: OPERATION } });
    // The first model answered the two normal reviews, then the second model the extra one: its own model, after.
    expect(prompts.filter((entry) => entry.startsWith("first-v1:"))).toEqual(["first-v1:CODE", "first-v1:SECURITY"]);
    expect(prompts.indexOf("second-a:CODE")).toBeGreaterThan(prompts.indexOf("first-v1:SECURITY"));
    expect(prompts.filter((entry) => entry.startsWith("second-a:"))).toEqual(["second-a:CODE"]);
  });

  it("retries the same model once, then moves to the next candidate; three tries in all", async () => {
    const prompts: string[] = [];
    const a = model("second-a", ["throw"], prompts);
    const b = model("second-b", [PASS], prompts);
    const { second } = await run({ first: model("first-v1", [PASS], prompts), candidates: [a, b] });
    const order = prompts.filter((entry) => entry.startsWith("second-"));
    expect(order).toEqual(["second-a:CODE", "second-a:CODE", "second-b:CODE"]);
    expect(second).toMatchObject({ tries: 3, report: { version: "second-b", status: "PASS" } });
  });

  it("the injected-diff attack: every try fails, so the loop stops at three tries, the answer is 'no answer', and the first reviews are untouched", async () => {
    const prompts: string[] = [];
    const a = model("second-a", ["throw"], prompts);
    const b = model("second-b", ["throw"], prompts);
    const { reports, second } = await run({ first: model("first-v1", [PASS], prompts), candidates: [a, b] });
    expect(prompts.filter((entry) => entry.startsWith("second-"))).toHaveLength(3);
    expect(second?.tries).toBe(3);
    expect(second?.report).toMatchObject({ status: "UNKNOWN", failureReason: "SESSION_FAILED" });
    expect(secondReviewTryOutcome(second?.report)).toBe("no-answer");
    expect(reports.map((report) => report.status)).toEqual(["PASS", "PASS"]);
  });

  it("stops at the first answer (a model that answers is not asked again)", async () => {
    const prompts: string[] = [];
    const { second } = await run({ first: model("first-v1", [PASS], prompts), candidates: [model("second-a", [PASS], prompts), model("second-b", [PASS], prompts)] });
    expect(second?.tries).toBe(1);
    expect(prompts.some((entry) => entry.startsWith("second-b:"))).toBe(false);
  });

  it("asks for nothing when the invocation names no second reviewer (cr off: the review is exactly as before)", async () => {
    const prompts: string[] = [];
    const { reports, second } = await run({ first: model("first-v1", [PASS], prompts) });
    expect(second).toBeUndefined();
    expect(prompts).toEqual(["first-v1:CODE", "first-v1:SECURITY"]);
    expect(reports).toHaveLength(2);
  });

  it("is not run when the step asks for no code review", async () => {
    const prompts: string[] = [];
    const { second } = await run({ first: model("first-v1", [PASS], prompts), candidates: [model("second-a", [PASS], prompts)], reviewers: ["SECURITY"] });
    expect(second).toBeUndefined();
    expect(prompts.some((entry) => entry.startsWith("second-a:"))).toBe(false);
  });
});

describe("the tries, as a rule", () => {
  const A = { provider: "p", modelId: "a" };
  const B = { provider: "p", modelId: "b" };

  it("same model once more, then the next candidate, at most three in all", () => {
    expect(nextSecondReviewModel([A, B], [])).toEqual(A);
    expect(nextSecondReviewModel([A, B], [{ model: A, outcome: "no-answer" }])).toEqual(A);
    expect(nextSecondReviewModel([A, B], [{ model: A, outcome: "no-answer" }, { model: A, outcome: "no-answer" }])).toEqual(B);
    expect(nextSecondReviewModel([A, B], [{ model: A, outcome: "no-answer" }, { model: A, outcome: "no-answer" }, { model: B, outcome: "no-answer" }])).toBeUndefined();
    expect(nextSecondReviewModel([A, B], [{ model: A, outcome: "answered" }])).toBeUndefined();
  });

  it("a model the account cannot use is left out at once", () => {
    expect(nextSecondReviewModel([A, B], [{ model: A, outcome: "unusable" }])).toEqual(B);
    expect(nextSecondReviewModel([A], [{ model: A, outcome: "unusable" }])).toBeUndefined();
  });

  it("a context-length rejection is no answer, never an unusable model", () => {
    const rejected = { status: "UNKNOWN", modelFailure: "the model call failed: request-rejected ValidationException HTTP 400" };
    expect(secondReviewTryOutcome(rejected)).toBe("no-answer");
    expect(nextSecondReviewModel([A, B], [{ model: A, outcome: secondReviewTryOutcome(rejected) }])).toEqual(A);
    expect(secondReviewTryOutcome({ status: "UNKNOWN", modelFailure: "the model call failed: model-not-found" })).toBe("unusable");
    expect(secondReviewTryOutcome({ status: "PASS" })).toBe("answered");
  });
});

describe("the field and the feature", () => {
  it("is a worker feature that the contracts list and this worker implements", () => {
    expect(WORKER_INVOCATION_FEATURES as readonly string[]).toContain(SECOND_REVIEWER_FEATURE);
    expect(WORKER_IMPLEMENTED_FEATURES as readonly string[]).toContain(SECOND_REVIEWER_FEATURE);
  });

  it("is a review-only, code-review-only field with one or two names", () => {
    const candidate = { model: { provider: "openrouter", modelId: "openai/gpt-5.5" }, modelRoute: { alias: "org-x", api: "openai-responses", catalog: "openai/gpt-5.5" } };
    expect(SecondReviewerSchema.safeParse({ candidates: [candidate] }).success).toBe(true);
    expect(SecondReviewerSchema.safeParse({ candidates: [] }).success).toBe(false);
    expect(SecondReviewerSchema.safeParse({ candidates: [candidate, candidate, candidate] }).success).toBe(false);
    expect(SecondReviewerSchema.safeParse({ candidates: [candidate], extra: 1 }).success).toBe(false);
    const base = { protocolVersion: 1, kind: "task", operationId: OPERATION, workspaceId: "22222222-2222-4222-8222-222222222222", fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64) };
    const task = (payload: Record<string, unknown>) => WorkerInvocationSchema.safeParse({ ...base, payload: { prompt: "x", conversationId: "33333333-3333-4333-8333-333333333333", conversationStarted: false, ...payload } });
    expect(task({ workflowMode: "REVIEW", workflowSecondReviewer: { candidates: [candidate] } }).success).toBe(true);
    expect(task({ workflowMode: "IMPLEMENT", workflowSecondReviewer: { candidates: [candidate] } }).success).toBe(false);
    expect(task({ workflowMode: "REVIEW", workflowReviewers: ["SECURITY"], workflowSecondReviewer: { candidates: [candidate] } }).success).toBe(false);
  });

  it("each candidate is called through its own route; a routed candidate on a worker with no proxy is left out, not run on the task's model", () => {
    const payload = { workflowSecondReviewer: { candidates: [
      { model: { provider: "openrouter", modelId: "openai/gpt-5.5" }, modelRoute: { alias: "org-x", api: "openai-responses" as const, catalog: "openai/gpt-5.5" } },
      { model: { provider: "amazon-bedrock", modelId: "us.amazon.nova-pro-v1:0" } },
    ] } };
    const proxy = { baseUrl: "http://proxy.invalid", source: async () => ({ apiKey: "k", expiresAt: 1 }) } as never;
    const withProxy = secondReviewerRuntimes(payload, proxy, {});
    expect(withProxy).toHaveLength(2);
    expect(withProxy![0]!.model.modelId).toBe("org-x");
    expect(secondReviewerRuntimes(payload, undefined, { AGENTX_MODEL_PROVIDER: "x", AGENTX_MODEL_ID: "y" })!.map((entry) => entry.model.modelId)).toEqual(["us.amazon.nova-pro-v1:0"]);
    expect(secondReviewerRuntimes({}, proxy, {})).toBeUndefined();
  });
});
