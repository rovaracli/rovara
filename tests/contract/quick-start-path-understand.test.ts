// Staging finding on 0.5.15 (decision 134): a clear small Slack request auto-started, but the task ran Full (path FULL,
// intent ready/FULL, pathFrom "request", design review "estimating"). The start was Quick; after Understand, the design
// review stage switched the review on because the project reviews every design (mode "always"), which forces the Full
// path even for an explicit Quick (design-review/understand-mode.ts, mode.ts). Fix: the broker starts a change on its own
// only when it will run Quick; under "always" (or `design first:`) it refuses, and the card is posted instead.
// This runs the real broker, Understand included (Rovara Code v2), from the ingress's intake record through the quick
// start route, the setup result and Understand's ready answer.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNDERSTAND_ARTIFACT_NAME, builtinSettingsKey, slackThreadSubject, type IntentAssessment } from "@rovara-code/contracts";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import { seedDesignReviewCompany } from "../support/design-review-company.js";
import { call, orchestratorPrincipal, orchestratorRoleArn } from "../support/slack-broker.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const THREAD = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1698100000.000001" };
const READY_QUICK: IntentAssessment = { kind: "ready", path: "QUICK", restatement: "Fix the README typo.", assumptions: [] };

beforeEach(() => { vi.stubEnv("DESIGN_REVIEW_ENABLED", "1"); });
afterEach(() => { vi.unstubAllEnvs(); });

async function autoStarted(mode: "auto" | "always") {
  const access = fakeModelAccess();
  const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: { rovaraCodeV2Live: true }, modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true,
    slack: { orchestratorRoleArn, memberWorkspaceLimit: 3, organizationWorkspaceLimit: 10 } } });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  seedDesignReviewCompany(h.db, TEST_ORG, { project: { name: "payments", mode } });
  await new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now }).ensureBuiltinSettings(TEST_ORG, "rovara-code");
  h.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: "2026-10-26T12:00:00.000Z" });
  // The ingress's record of the routed message, then the Slack service's ask.
  const choiceId = randomUUID();
  const recorded = await h.handler({ source: "agentx.slack-ingress", action: "intake-record", choiceId, thread: THREAD, userId: MAYA.slackUserId, text: "fix the typo in README" });
  expect(recorded.statusCode).toBe(200);
  const asked = await call(h.handler, { method: "POST", path: "/v1/service/workflows/quick-start", body: { requestId: choiceId },
    service: { principal: orchestratorPrincipal, thread: slackThreadSubject(THREAD), slackUser: String(MAYA.slackUserId) } });
  return { h, asked };
}

describe("an auto-started clear small change runs Quick through Understand (staging finding)", () => {
  it("starts Quick, and after setup and Understand's ready answer it is still Quick with no design review estimate", async () => {
    const { h, asked } = await autoStarted("auto");
    expect(asked.body).toMatchObject({ started: true });
    const taskId = String(asked.body.taskId);
    const meta = () => h.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; workflow: Record<string, unknown> };
    expect(meta().workflow).toMatchObject({ path: "QUICK", stage: "UNDERSTAND", intent: { pathFrom: "request" } });
    const workspaceId = meta().workspaceId;
    const operations = () => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
    await h.finish(workspaceId, String(operations().find((item) => item.kind === "prepare")!.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } });
    const understand = operations().find((item) => item.workflowMode === "UNDERSTAND")!;
    await h.artifact(workspaceId, String(understand.id), UNDERSTAND_ARTIFACT_NAME, JSON.stringify(READY_QUICK));
    await h.finish(workspaceId, String(understand.id), "SUCCEEDED", { result: { workflowMode: "UNDERSTAND" } });
    expect(meta().workflow).toMatchObject({ path: "QUICK", stage: "PLAN" });
    expect(meta().workflow).not.toHaveProperty("designReview");
    expect(meta().workflow).not.toHaveProperty("reviewPhase");
  });

  it("does not start on its own where the project reviews every design: that start would run Full", async () => {
    const { h, asked } = await autoStarted("always");
    expect(asked.body).toMatchObject({ started: false, reason: "design_review" });
    expect(h.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META")).toEqual([]);
  });
});
