// Design review stage, the final fix round (DR-REVIEW-final.md, A): with the stage off for a project, three things the stage touched behave exactly as they did before it existed.
//   A1  the Slack and Linear `design first:` prefix is read only while `dr` is on AND the company allows design review; otherwise the text is not looked at (no stripping, no marker, no skipped Quick/Full question);
//   A2  a spec write adds no read of its own: a transient read error cannot fail an OFF spec write;
//   (A3, the playbook, is pinned in design-review-playbook.test.ts.)
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgId } from "@agentx/contracts";
import type * as IntentModule from "../../packages/broker/src/rovara-code/intent.js";
import { intakePortsOf, type IntakeWiring } from "../../packages/broker/src/intake/wiring.js";
import { specEndEnvironmentOf } from "../../packages/broker/src/aws/broker/spec-wiring.js";
import { parseWorkflowStartRequest } from "../../packages/broker/src/aws/slack-workflow-choice.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { ARJUN, ORG_A, sessionWorld } from "../support/agent-session-world.js";
import { seedDesignReviewCompany } from "../support/design-review-company.js";
import { TEST_ORG } from "../support/orgs.js";

// Real by default; the intake test takes the start over (the request it is handed is what it looks at).
const intent = vi.hoisted(() => ({ start: undefined as undefined | ((...args: unknown[]) => Promise<unknown>) }));
vi.mock("../../packages/broker/src/rovara-code/intent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof IntentModule>();
  return { ...actual, startCodeIntent: (...args: Parameters<typeof actual.startCodeIntent>) => (intent.start ?? actual.startCodeIntent)(...args) };
});

const SLACK_THREAD = { teamId: "T0BSHLLUGBD", channelId: "C0123456789" };
const PREFIXED = "design first: Add a retry to payments";

beforeEach(() => { vi.unstubAllEnvs(); });
afterEach(() => { vi.unstubAllEnvs(); intent.start = undefined; });

describe("A1: the Slack ingress never reads the prefix (it cannot know the project's switch)", () => {
  it("leaves the text exactly as typed, so an install with the stage off asks Quick or Full as it always did", () => {
    expect(parseWorkflowStartRequest(PREFIXED)).toEqual({ kind: "start", instructions: PREFIXED });
    expect(parseWorkflowStartRequest("design first: quick: add a retry")).toEqual({ kind: "start", instructions: "design first: quick: add a retry" });
  });
});

describe("A1: a Slack-started task", () => {
  const start = async (env: Record<string, string>, threadTs: string, company = false) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const harness = await createSingleAnswerPlanBroker();
    if (company) seedDesignReviewCompany(harness.db, TEST_ORG);
    const started = await harness.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: { ...SLACK_THREAD, threadTs }, userId: MAYA.slackUserId, instructions: PREFIXED, workflowPath: "QUICK", requestId: randomUUID() });
    expect(started.statusCode).toBe(200);
    const taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
    return harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown>;
  };

  it("with the stage OFF (dr off, or the company not allowing it) keeps the prefix in the request and records no marker", async () => {
    for (const [index, env] of [{ DESIGN_REVIEW_ENABLED: "0", DESIGN_REVIEW_PROJECTS: "payments" }, { DESIGN_REVIEW_ENABLED: "1", DESIGN_REVIEW_PROJECTS: "payments" }, {}].entries()) {
      const task = await start(env, `1695500000.0001${String(index)}0`);
      expect(task["designFirst"], JSON.stringify(env)).toBeUndefined();
      expect(JSON.stringify(task), JSON.stringify(env)).toContain("design first: Add a retry to payments");
    }
  });

  it("positive control: with dr on and the company allowing design review the prefix is read, stripped and recorded for the person who typed it (dp is ignored)", async () => {
    const task = await start({ DESIGN_REVIEW_ENABLED: "1" }, "1695500000.000199", true);
    expect(typeof (task["designFirst"] as { by?: unknown } | undefined)?.by).toBe("string");
    expect(JSON.stringify(task)).not.toContain("design first:");
    expect(JSON.stringify(task)).toContain("Add a retry to payments");
  });
});

describe("A1: a Linear or Jira ticket", () => {
  const request = (project: string) => ({ requestId: randomUUID(), project, input: { text: PREFIXED }, source: "linear" }) as never;

  it("passes the text on untouched and records nothing while the stage is off (dr off, or the company has not allowed it); reads the prefix when it is on", async () => {
    const taskId = randomUUID();
    const w = sessionWorld();
    w.db.set({ pk: `DEVTASK#${taskId}`, sk: "META", taskId });
    const sent: string[] = [];
    intent.start = async (_deps, _caller, req) => { sent.push(String((req as { input: { text?: string } }).input.text)); return { task: { taskId } }; };
    const wiring: IntakeWiring = {
      documentClient: w.db, tableName: "state", now: () => w.clock.now,
      starter: { callerFor: async (orgId: OrgId, developerId: string) => ({ developerId, orgId, orgRole: "member", name: "x", sessionId: "s", amr: "oidc" }), projectMembers: w.members, documentClient: w.db, tableName: "state" } as never,
      intentDependenciesFor: () => ({}) as never,
    };
    const intake = intakePortsOf(wiring);
    for (const env of [{ DESIGN_REVIEW_ENABLED: "0", DESIGN_REVIEW_PROJECTS: "web" }, { DESIGN_REVIEW_ENABLED: "1", DESIGN_REVIEW_PROJECTS: "web" }]) {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      await intake.start(ORG_A, ARJUN, request("web"));
      expect(w.db.get(`DEVTASK#${taskId}`, "META")).not.toHaveProperty("designFirst");
    }
    expect(sent).toEqual([PREFIXED, PREFIXED]);
    // Positive control.
    vi.stubEnv("DESIGN_REVIEW_ENABLED", "1");
    seedDesignReviewCompany(w.db, ORG_A);
    await intake.start(ORG_A, ARJUN, request("web"));
    expect(sent.at(-1)).toBe("Add a retry to payments");
    expect(w.db.get(`DEVTASK#${taskId}`, "META")).toMatchObject({ designFirst: { by: ARJUN } });
  });
});

describe("A2: a spec write with design review off adds no read", () => {
  const TASK_ID = "11111111-1111-4111-8111-111111111111";
  const row = { pk: `DEVTASK#${TASK_ID}`, sk: "META", taskId: TASK_ID, orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", workflow: { stage: "PULL_REQUEST", state: "READY", artifacts: [], decisions: [] } };

  it("reads the task once for the plan digest and the design step together; a second read that would fail is never made", async () => {
    const sends: string[] = [];
    const client = { send: vi.fn(async (command: { constructor: { name: string } }) => {
      sends.push(command.constructor.name);
      if (sends.length > 1) throw Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" });
      return { Item: row };
    }) };
    const env = specEndEnvironmentOf({ documentClient: client, tableName: "state" } as never);
    await env.approvedPlanDigest(TASK_ID);
    await expect(env.design!(TASK_ID)).resolves.toEqual({ kind: "off" });
    expect(sends).toEqual(["GetCommand"]);
  });

  it("positive control: the design step does read when it is called without a plan digest read first, and a design-reviewed task waits", async () => {
    const reviewed = { ...row, workflow: { ...row.workflow, designReview: { status: "done", rounds: [] }, artifacts: [], decisions: [] } };
    const client = { send: vi.fn(async () => ({ Item: reviewed })) };
    const env = specEndEnvironmentOf({ documentClient: client, tableName: "state", s3: undefined, artifactBucketName: "b" } as never);
    await expect(env.design!(TASK_ID)).resolves.toEqual({ kind: "wait" });
    expect(client.send).toHaveBeenCalledTimes(1);
  });
});
