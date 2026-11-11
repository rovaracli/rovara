// Rovara Code (Plan 6 Task 1, rulings): the tolerant task read says in its type what it does at run time (a stage may be "unknown"), callers handle it, and the
// agent-run route projects a task view for a client that does not read version 2.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import { DeveloperTaskResponseSchema, knownTaskView, type DeveloperTaskClientView, type DeveloperTaskView } from "@agentx/cloud-contracts";
import { type WorkflowStage } from "@rovara-code/contracts";
import { createWorkflowSnapshot } from "../../packages/cloud-contracts/src/task-workflow-node.js";
import { createAgentXMcpServer, type ControlPlaneClient, type ToolContext } from "../../packages/mcp/src/index.js";
import { routeAgentRequest } from "../../packages/broker/src/agents/routes.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const now = "2026-10-24T12:00:00.000Z";
const view = (workflow: Record<string, unknown> | undefined) => ({
  taskId, title: "Add a retry flag", project: "payments", status: "RUNNING", startingRevision: 1, client: "Claude Code", shared: false,
  createdAt: now, updatedAt: now, events: [], ...(workflow === undefined ? {} : { workflow }),
});
const snapshot = (extra: Record<string, unknown> = {}) => ({ ...createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now }), ...extra });
const future = () => view(snapshot({ stage: "CELEBRATE", outcome: "PARTY", definitionVersion: "2.7.0" }));

describe("the type of a tolerant read", () => {
  it("says a stage, an outcome and a path may be unknown", () => {
    const parsed = DeveloperTaskResponseSchema.parse({ task: view(snapshot({ stage: "PLAN_CRITIQUE", definitionVersion: "1.1.0" })) });
    const workflow = parsed.task.workflow;
    expectTypeOf(parsed.task).toEqualTypeOf<DeveloperTaskClientView>();
    expectTypeOf(workflow!.stage).toEqualTypeOf<WorkflowStage | "unknown">();
    expectTypeOf(workflow!.definitionVersion).toEqualTypeOf<string>();
    // The strict server view keeps the closed set.
    expectTypeOf<NonNullable<DeveloperTaskView["workflow"]>["stage"]>().toEqualTypeOf<WorkflowStage>();
    expect(workflow?.stage).toBe("PLAN_CRITIQUE");
  });
});

describe("knownTaskView", () => {
  it("gives the strict view when every stage and outcome is known, and nothing when one is not", () => {
    const known = DeveloperTaskResponseSchema.parse({ task: view(snapshot({ stage: "UNDERSTAND", state: "WAITING", definitionVersion: "1.1.0" })) }).task;
    expect(knownTaskView(known)?.workflow?.stage).toBe("UNDERSTAND");
    const unknown = DeveloperTaskResponseSchema.parse({ task: future() }).task;
    expect(unknown.workflow?.stage).toBe("unknown");
    expect(knownTaskView(unknown)).toBeUndefined();
  });

  it("notices a value the reader could not know deep in the workflow, not only the stage", () => {
    const task = DeveloperTaskResponseSchema.parse({ task: view(snapshot({ reviewPhase: "A_NEW_PHASE" })) }).task;
    expect(task.workflow?.stage).toBe("PLAN");
    expect(knownTaskView(task)).toBeUndefined();
  });

  it("does not take free text or data that is the word unknown for the reader's own marker", () => {
    const task = DeveloperTaskResponseSchema.parse({ task: view(snapshot({ stage: "BLOCKED_NOT", state: "BLOCKED", blockReason: "unknown" })) }).task;
    expect(task.workflow?.stage).toBe("unknown");
    const text = DeveloperTaskResponseSchema.parse({ task: view(snapshot({ state: "BLOCKED", blockReason: "unknown" })) }).task;
    expect(text.workflow?.stage).toBe("PLAN");
    expect(knownTaskView(text)?.workflow?.blockReason).toBe("unknown");
    // A title or a repository named unknown is data too.
    const titled = DeveloperTaskResponseSchema.parse({ task: { ...view(snapshot()), title: "unknown", project: "unknown" } }).task;
    expect(knownTaskView(titled)).toBeDefined();
  });

  it("returns a task with no workflow as it is", () => {
    const plain = DeveloperTaskResponseSchema.parse({ task: view(undefined) }).task;
    expect(knownTaskView(plain)).toEqual(plain);
  });

  it("keeps the plan content and work breakdown digest the page adds to the workflow", () => {
    const task = DeveloperTaskResponseSchema.parse({ task: view({ ...snapshot(), planContent: "# Plan", workBreakdownDigest: "b".repeat(64) }) }).task;
    expect(knownTaskView(task)?.workflow).toMatchObject({ planContent: "# Plan", workBreakdownDigest: "b".repeat(64) });
  });
});

describe("a path or workflow id a newer server changed", () => {
  it("reads as unknown, as the type says, instead of failing the whole task", () => {
    const task = DeveloperTaskResponseSchema.parse({ task: view(snapshot({ path: "TRIAGE", definitionId: "agentx-other-flow" })) }).task;
    expect(task.workflow?.path).toBe("unknown");
    expect(task.workflow?.definitionId).toBe("unknown");
    expect(knownTaskView(task)).toBeUndefined();
  });

  it("still defaults a missing path to QUICK and keeps known values", () => {
    const withoutPath: Record<string, unknown> = { ...snapshot() };
    delete withoutPath.path;
    const task = DeveloperTaskResponseSchema.parse({ task: view(withoutPath) }).task;
    expect(task.workflow?.path).toBe("QUICK");
    expect(task.workflow?.definitionId).toBe("agentx-task-to-pr");
    expect(DeveloperTaskResponseSchema.parse({ task: view(snapshot({ path: "FULL", reviewPhase: "REQUIREMENTS" })) }).task.workflow?.path).toBe("FULL");
  });
});

describe("a tool shows a task whose stage it does not know", () => {
  async function connect(client: Partial<ControlPlaneClient>) {
    const context = (): ToolContext => ({
      client: client as ControlPlaneClient, clientName: "claude-code", serverVersion: "0.4.0", adminSignedIn: async () => false,
      compatibility: async () => ({ env: "staging", apiVersion: "1.2" }), now: () => 0, sleep: async () => {}, newRequestId: () => "33333333-3333-4333-8333-333333333333",
    });
    const server = createAgentXMcpServer({ version: "0.4.0", context });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: "claude-code", version: "1.0.0" });
    await mcp.connect(clientSide);
    return mcp;
  }

  it("answers with stage unknown and tells the person to upgrade, instead of failing", async () => {
    const task = DeveloperTaskResponseSchema.parse({ task: future() }).task;
    const mcp = await connect({ getTask: async () => task });
    await mcp.listTools();
    const result = await mcp.callTool({ name: "agentx_get_task", arguments: { task_id: taskId } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ task_id: taskId, workflow: { stage: "unknown" } });
    expect(JSON.stringify(result.content)).toMatch(/newer|upgrade/iu);
  });
});

describe("the agent-run route", () => {
  const caller = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64), name: "Ana" };
  const v2Task = () => view(snapshot({ definitionVersion: "1.1.0", stage: "UNDERSTAND", state: "WAITING" }));
  const run = async (headers: Record<string, string>) => {
    const request = {
      method: "POST", path: "/v1/app/agents/rovara-code/runs", headers, requestId: "r1",
      body: JSON.stringify({ requestId: "33333333-3333-4333-8333-333333333333", project: "payments", input: { text: "Add a retry flag" } }),
    };
    const answer = await routeAgentRequest({ startRun: async () => ({ task: v2Task() }) } as never, caller as never, request, new URL(request.path, "https://agentx.invalid"));
    return (answer as { body: { task: { workflow: { stage: string; definitionVersion: string } } } }).body.task.workflow;
  };

  it("serves a client that does not send the header the version 1 projection", async () => {
    expect(await run({})).toMatchObject({ stage: "PLAN", definitionVersion: "1.0.0" });
  });

  it("serves a client that sends x-agentx-task-view: 2 the full view", async () => {
    expect(await run({ "x-agentx-task-view": "2" })).toMatchObject({ stage: "UNDERSTAND", definitionVersion: "1.1.0" });
  });
});
