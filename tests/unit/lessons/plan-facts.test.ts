// Lessons capture lane: what the loader is told about a task besides its title: a short summary of the approved plan and the files the plan names. Pure, bounded, and made only from the plan's own structure.
import { describe, expect, it } from "vitest";
import type { PlanDocument } from "@agentx/contracts";
import { PLAN_FACTS_MAX_FILES, PLAN_FACTS_SUMMARY_MAX, planLoadFacts } from "../../../packages/broker/src/lessons/plan-facts.js";

const plan = (claims: PlanDocument["claims"], title = "Retry failed HTTP calls"): PlanDocument => ({ schemaVersion: 1, title, why: [], claims, notChanging: [], risks: [], decisions: [] }) as PlanDocument;

describe("planLoadFacts", () => {
  it("the summary is the title and the top-level claims; the files are the cited code and the files named in words, each once", () => {
    const facts = planLoadFacts(plan([
      { id: "1", text: "Wrap the fetch in withRetry in src/http/client.ts", evidence: [{ kind: "code", path: "src/http/client.ts", startLine: 1, endLine: 5 }, { kind: "code", path: "src/http/retry.ts", startLine: 2, endLine: 9 }], children: [{ id: "1.1", text: "Update ./tests/client.test.ts" }] },
      { id: "2", text: "Document the change in docs/retry.md and see https://example.com/a.json" },
    ]));
    expect(facts.summary).toBe("Retry failed HTTP calls\nWrap the fetch in withRetry in src/http/client.ts\nDocument the change in docs/retry.md and see https://example.com/a.json");
    expect(facts.files).toEqual(["src/http/client.ts", "src/http/retry.ts", "tests/client.test.ts", "docs/retry.md"]);
  });

  it("is bounded: a long summary is cut and at most 30 files are listed", () => {
    const claims = Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), text: `Change src/m${i}/index.ts ${"x".repeat(200)}`, evidence: [{ kind: "code" as const, path: `src/m${i}/index.ts`, startLine: 1, endLine: 2 }] }));
    const facts = planLoadFacts(plan(claims));
    expect(facts.summary.length).toBeLessThanOrEqual(PLAN_FACTS_SUMMARY_MAX);
    expect(facts.files).toHaveLength(PLAN_FACTS_MAX_FILES);
  });

  it("a plan that names no file gives none (so no path scope is judged), and a plan that needs no change has a summary only", () => {
    expect(planLoadFacts(plan([{ id: "1", text: "Rename the helper everywhere" }])).files).toEqual([]);
    expect(planLoadFacts({ ...plan([{ id: "1", text: "Nothing to do" }]), noChangeNeeded: { reason: "x" } } as never).files).toEqual([]);
  });

  it("paths that could escape or confuse are not listed", () => {
    const facts = planLoadFacts(plan([{ id: "1", text: "Edit ../../etc/passwd.conf and /abs/path/a.ts and src/ok.ts", evidence: [{ kind: "code", path: "../up.ts", startLine: 1, endLine: 1 }] }]));
    expect(facts.files).toEqual(["src/ok.ts"]);
  });
});

describe("planFactsFor (the broker's read of the plan)", () => {
  const sha = async (text: string) => (await import("node:crypto")).createHash("sha256").update(text, "utf8").digest("hex");
  const artifact = (text: string, over: Record<string, unknown> = {}) => ({ id: "a1", type: "plan", version: 1, producer: "p", objectKey: "plans/x", createdAt: "2026-11-01T00:00:00.000Z", sha256: "", ...over, _text: text });
  async function facts(workflowArtifacts: Array<ReturnType<typeof artifact>>, stored: Record<string, string>) {
    const { planFactsFor } = await import("../../../packages/broker/src/aws/broker/lessons-wiring.js");
    const s3 = { send: async (command: { input: { Key: string } }) => (stored[command.input.Key] === undefined ? Promise.reject(new Error("NoSuchKey")) : { Body: { transformToString: async () => stored[command.input.Key]! } }) };
    const fill = await Promise.all(workflowArtifacts.map(async ({ _text, ...rest }) => ({ ...rest, sha256: await sha(_text) })));
    return planFactsFor({ s3: s3 as never, artifactBucketName: "bucket" })({ taskId: "t", orgId: "o", workflow: { artifacts: fill } });
  }
  it("reads the latest plan: a structured plan gives its summary and files, a Markdown plan its first lines and no files", async () => {
    const { canonicalPlanJson } = await import("@agentx/contracts");
    const full = { ...plan([{ id: "1", text: "Edit src/http/client.ts", evidence: [{ kind: "code", path: "src/http/client.ts", startLine: 1, endLine: 2 }] }]), why: [{ text: "Calls fail", author: "maya" }], notChanging: ["The API"], risks: ["Retries storm"] } as PlanDocument;
    const doc = canonicalPlanJson(full);
    const structured = await facts([artifact(doc, { format: "structured" })], { "plans/x": doc });
    expect(structured).toMatchObject({ files: ["src/http/client.ts"] });
    expect(structured!.summary).toContain("Retry failed HTTP calls");
    const markdown = await facts([artifact("# Plan\nChange src/a.ts"), artifact("# Newer plan\nUse withRetry", { id: "a2", version: 2, objectKey: "plans/y" })], { "plans/x": "# Plan\nChange src/a.ts", "plans/y": "# Newer plan\nUse withRetry" });
    expect(markdown).toEqual({ summary: "# Newer plan\nUse withRetry", files: [] });
  });
  it("gives nothing for no plan, a missing object or a copy that does not match its digest", async () => {
    expect(await facts([], {})).toBeUndefined();
    expect(await facts([artifact("# Plan")], {})).toBeUndefined();
    expect(await facts([artifact("# Plan")], { "plans/x": "tampered" })).toBeUndefined();
  });
});
