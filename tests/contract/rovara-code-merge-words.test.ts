// Bug G (staging 0.4.11), the words: a Rovara Code task that waits for its merge said "Review and merge it on GitHub" although Merge is pressed in Rovara. These tests read the words
// the task page, the AI tool's task answer and the Slack/session message use for a task whose pull request is ready, and for one that is not. A task that is not tracked (a version 1
// task) keeps merging on GitHub. No MCP tool merges (a person always presses Merge; owner decision 2026-10-22, Plan 6 Task 25).
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { DEVELOPER_TOOLS, createAgentXMcpServer, httpControlPlaneClient, type ToolContext } from "../../packages/mcp/src/index.js";
import { taskPageStage } from "../../packages/broker/src/aws/developer-tasks.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { MERGE_NOT_READY_MESSAGES as M } from "../../packages/cloud-contracts/src/rovara-code.js";
import { WorkflowSnapshotSchema, createWorkflowSnapshot, type WorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { createCandidateManifest } from "@rovara-code/contracts";
import { CELL, MAYA, mergeButtonBroker, type MergeButtonBroker } from "../support/merge-button-broker.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(loadSlackBroker);

const unHtml = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

/** The task's page, as the owner's browser reads it. */
async function pageText(h: MergeButtonBroker): Promise<string> {
  const sessionId = randomUUID();
  h.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: MAYA.developerId, amr: MAYA.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 600 });
  const response = await h.handler({
    version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${h.taskId}/task`, rawQueryString: "",
    headers: { host: new URL(CELL).host, cookie: `__Host-agentx_review_session=${sessionId}; __Host-agentx_review_csrf=csrf` },
    requestContext: { requestId: randomUUID(), http: { method: "GET" } },
  });
  expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
  return unHtml(response.body);
}

/** What an AI tool is told about the task. */
async function toolText(h: MergeButtonBroker): Promise<string> {
  const client = httpControlPlaneClient({
    session: async () => ({ baseUrl: CELL, accessToken: (await h.bearer(MAYA)).replace(/^Bearer /, ""), signInCommand: "npx x login" }), sleep: async () => undefined, tries: 1,
    fetch: async (input, init) => {
      const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const response = await h.handler({
        version: "2.0", rawPath: target.pathname, rawQueryString: target.search.slice(1), headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(typeof init?.body === "string" ? { body: init.body } : {}), requestContext: { requestId: randomUUID(), http: { method: init?.method ?? "GET" } },
      });
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
    },
  });
  const context = (): ToolContext => ({ client, clientName: "claude-code", serverVersion: "0.4.0", adminSignedIn: async () => false, compatibility: async () => ({ env: "staging", apiVersion: "1.2" }), now: () => 0, sleep: async () => undefined, newRequestId: () => randomUUID() });
  const server = createAgentXMcpServer({ version: "0.4.0", context });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "claude-code", version: "1.0.0" });
  await mcp.connect(clientSide);
  const result = await mcp.callTool({ name: "agentx_get_task", arguments: { task_id: h.taskId } });
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

describe("the task page", () => {
  it("says to press Merge in Rovara when the pull request is ready, and not to merge on GitHub", async () => {
    const page = await pageText(await mergeButtonBroker());
    expect(page).toContain("Press Merge in Rovara");
    expect(page).not.toMatch(/merge (it|them) on GitHub/i);
  });

  it("says what is missing, in the control plane's words, and that Merge is pressed in Rovara after", async () => {
    const page = await pageText(await mergeButtonBroker({ tracking: { ci: "failing", failingChecks: ["test"] } }));
    expect(page).toContain(M.checks);
    expect(page).toContain("press Merge in Rovara");
    expect(page).not.toMatch(/merge (it|them) on GitHub/i);
  });
});

describe("the AI tool's task answer", () => {
  it("tells it a person presses Merge in Rovara when ready, and that it can't merge", async () => {
    const text = await toolText(await mergeButtonBroker());
    expect(text).toContain("presses Merge in Rovara");
    expect(text).toContain("one click in the web app");
    expect(text).toContain("can't merge");
    expect(text).not.toMatch(/merge it on GitHub/i);
  });

  it("gives the reason when it is not ready", async () => {
    const text = await toolText(await mergeButtonBroker({ approver: "none" }));
    expect(text).toContain(M.needsOtherApproval("Maya Chen"));
    expect(text).toContain("presses Merge in Rovara");
  });
});

describe("no MCP tool merges", () => {
  it("lists no tool whose name or description presses Merge, changes code settings, restores from the trash or applies a setup draft", () => {
    const names = DEVELOPER_TOOLS.map((tool) => tool.name);
    expect(names.filter((name) => /merge|code_settings|trash|setup_draft/u.test(name))).toEqual([]);
  });
});

const NOW = "2026-10-26T22:00:00.000Z";
/** A task waiting for its merge: one open pull request on a candidate whose checks and reviews passed. */
function waitingWorkflow(definitionVersion: "1.0.0" | "1.1.0"): WorkflowSnapshot {
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: NOW, definitionVersion }), candidate, stage: "WAIT_FOR_MERGE", state: "WAITING",
    verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: "fixture", recordedAt: NOW, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", candidateDigest: candidate.digest, role, provider: "fixture", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: NOW })),
    pullRequests: [{ repositoryId: "demo", number: 7, url: "https://github.com/example/demo/pull/7", headSha: "a".repeat(40), headTreeSha: "b".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" }],
  });
}

describe("taskPageStage", () => {
  it("names Merge in Rovara when the view says it is ready or why not, and keeps GitHub when nothing is tracked", () => {
    expect(taskPageStage(waitingWorkflow("1.1.0"), false, true, undefined, undefined, { ready: true }).nextStep).toBe("Press Merge in Rovara; the task finishes when it's merged.");
    expect(taskPageStage(waitingWorkflow("1.1.0"), false, true, undefined, undefined, { ready: false, message: M.draft }).nextStep).toBe(`${M.draft} Then press Merge in Rovara; the task finishes when it's merged.`);
    expect(taskPageStage(waitingWorkflow("1.1.0"), false, true).nextStep).toBe("Review and merge it on GitHub; the task finishes when it's merged.");
  });
});

describe("the message in the task's thread", () => {
  it("tells a Rovara Code task's owner to press Merge in Rovara once the pull request is approved, and leaves a version 1 task on GitHub", () => {
    const text = workflowMessage({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", workflow: waitingWorkflow("1.1.0"), project: "payments" })!.text;
    expect(text).toContain("Approve the PR on GitHub, then press Merge in Rovara; I'll finish this task when it's merged.");
    expect(text).not.toContain("merge it on GitHub");
    expect(workflowMessage({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", workflow: waitingWorkflow("1.0.0"), project: "payments" })!.text).toContain("merge it on GitHub");
  });
});
