// Trust fix A2: a reviewer whose model the account cannot call does not fail its operation: Pi turns the refusal into a failed assistant message, the review has no answer, and the report is recorded
// UNKNOWN on an operation that SUCCEEDED. The report therefore carries the failure as a fixed-shape sentence (the model-call monitor's note: a failure class, an allow-listed error token, a status),
// never the provider's text, so the broker can leave that model out of the next review of the task. The model that failed is the report's own provider and version.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { criticModelUnusable } from "../../packages/broker/src/rovara-code/critic.js";

const MODEL = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-fable-5" };
const SECRET_TEXT = "AccessDeniedException: You don't have access to the model with the specified model ID. sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";

const refused = (errorCode: string, status: number) => ({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", provider: "amazon-bedrock", errorMessage: SECRET_TEXT,
  diagnostics: [{ details: { errorCode, status, requestId: "9e7ea41c-1111-2222-3333-444455556666" } }] } });
// An answer that is not the JSON the review asks for: the review is UNKNOWN even though the model answered.
const answeredBadly = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I could not tell." }], stopReason: "stop", provider: "amazon-bedrock" } };
const answered = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ findings: [] }) }], stopReason: "stop", provider: "amazon-bedrock" } };

async function review(events: unknown, options: { mainSession?: boolean } = {}) {
  const rootPath = await mkdtemp(join(tmpdir(), "agentx-worker-review-failure-"));
  try {
    const directory = join(rootPath, "repo/payments");
    await mkdir(directory, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
    git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(directory, "app.ts"), "export const value = 1;\n");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "base");
    const baseCommitSha = git("rev-parse", "HEAD");
    await writeFile(join(directory, "app.ts"), "export const value = 2;\n");
    const now = new Date().toISOString();
    await mkdir(join(rootPath, ".agentx"), { recursive: true });
    await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "payments", projectRevision: 1,
      repositories: [{ name: "payments", path: "repo/payments", defaultBranch: "main", resolvedCommit: baseCommitSha, resolvedAt: now, completedAt: now }],
      completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: now }));
    let created = 0;
    const adapter: PiSessionAdapter = {
      async create(input) {
        const sessionFile = join(input.sessionDirectory, `${input.conversationId}.jsonl`);
        await writeFile(sessionFile, "{}");
        let listener: ((event: unknown) => void) | undefined;
        // The first session is the operation's own (it is prompted first); the reviewers' sessions come after it.
        const own = created === 0;
        created += 1;
        return {
          conversationId: input.conversationId ?? "fixture", sessionFile,
          async prompt() { if (!own || options.mainSession === true) for (const event of Array.isArray(events) ? events : [events]) listener?.(event); }, async abort() {},
          getModel: () => ({ provider: input.model.provider, modelId: input.model.modelId }),
          getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 } as never),
          subscribe(next) { listener = next; return () => undefined; }, dispose() {},
        };
      },
    };
    const result = await runTaskInvocation({
      protocolVersion: 1 as const, kind: "task" as const, operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
      payload: { conversationId: randomUUID(), prompt: "Run the independent read-only reviews.", workflowMode: "REVIEW" as const, model: MODEL, workflowBase: [{ repositoryId: "payments", baseCommitSha }] },
    }, { rootPath, model: MODEL, piAdapter: adapter, eventSink: async () => undefined, artifactSink: async () => undefined });
    return result.workflowReviews ?? [];
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}

describe("a review whose model the account cannot call", () => {
  it("fails the operation itself when the operation's own session is refused first, with the sentence the broker already reads as unusable", async () => {
    await expect(review(refused("AccessDeniedException", 403), { mainSession: true })).rejects.toSatisfy((error: unknown) => criticModelUnusable((error as Error).message));
  });

  it("is reported UNKNOWN with the failure as a fixed sentence the broker reads as unusable, on the model that failed, with none of the provider's text", async () => {
    const reports = await review(refused("AccessDeniedException", 403));
    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report).toMatchObject({ status: "UNKNOWN", provider: MODEL.provider, version: MODEL.modelId });
      const failure = (report as { modelFailure?: string }).modelFailure;
      expect(failure, JSON.stringify(report)).toMatch(/^the model call failed: key-rejected /);
      expect(criticModelUnusable(failure)).toBe(true);
    }
    expect(JSON.stringify(reports)).not.toMatch(/sk-ant|You don't have access/);
  });

  it("says so for a throttled model too, but the broker does not read that as unusable: another model would not change it", async () => {
    const reports = await review(refused("ThrottlingException", 429));
    for (const report of reports) {
      const failure = (report as { modelFailure?: string }).modelFailure;
      expect(failure).toMatch(/^the model call failed: /);
      expect(criticModelUnusable(failure)).toBe(false);
    }
  });

  it("carries no failure when the model answered", async () => {
    const reports = await review(answered);
    expect(reports.map((report) => report.status)).toEqual(["PASS", "PASS"]);
    for (const report of reports) expect(report).not.toHaveProperty("modelFailure");
  });

  it("carries no failure when a later call answered, even if that answer could not be read: the earlier failure is stale", async () => {
    // The positive control: the same failure with no later answer is reported.
    const stale = await review([refused("AccessDeniedException", 403)]);
    for (const report of stale) {
      expect(report.status).toBe("UNKNOWN");
      expect((report as { modelFailure?: string }).modelFailure).toMatch(/^the model call failed: key-rejected /);
    }
    // The call failed, a retry answered, and the answer was not a review: UNKNOWN, but not because of the model call.
    const reports = await review([refused("AccessDeniedException", 403), answeredBadly]);
    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report.status).toBe("UNKNOWN");
      expect(report).not.toHaveProperty("modelFailure");
    }
  });
});
