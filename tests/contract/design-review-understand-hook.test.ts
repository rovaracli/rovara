// Design review stage, DR7 slice B (DR2/DR8 wiring): the Understand step's `ready` answer meets the design review at one place in the broker's result handling. With the `dr` switch ON, the project's EFFECTIVE setting and
// Understand's reading decide, in code, whether the task's design is reviewed, and a reviewed task is forced onto the Full path. With the switch OFF the setting is never read and the task is exactly what it was.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNDERSTAND_ARTIFACT_NAME, projectPlaybookKey, type IntentAssessment } from "../../packages/contracts/src/index.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { builtinSettingsKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { TEST_ORG } from "../support/orgs.js";
import { seedDesignReviewCompany, type CompanyPolicySeed } from "../support/design-review-company.js";

const PROXY_URL = "http://internal-proxy.example.test:4000";
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
afterEach(() => { vi.unstubAllEnvs(); });

/** `company`: the company's design review policy (default: allowed, default mode Auto; null: the company has none). `dropOrgId`: the task record has no orgId when Understand ends (the type allows it). */
async function understoodAs(assessment: IntentAssessment, options: { switchOn: boolean; playbook?: Record<string, unknown>; company?: CompanyPolicySeed | null; dropOrgId?: boolean; designFirst?: boolean }) {
  if (options.switchOn) vi.stubEnv("DESIGN_REVIEW_ENABLED", "1");
  const access = fakeModelAccess();
  const h = await createSingleAnswerPlanBroker({ brokerExtra: { agents: { rovaraCodeV2Live: true }, modelAccess: { access, proxyUrl: PROXY_URL }, cloud: true } });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  if (options.company !== null) seedDesignReviewCompany(h.db, TEST_ORG, options.company);
  await new AgentStore({ documentClient: h.db, tableName: "state", now: Date.now }).ensureBuiltinSettings(TEST_ORG, "rovara-code");
  h.db.set({ ...builtinSettingsKey(TEST_ORG, "rovara-code"), entityType: "BUILTIN_AGENT_SETTINGS", pinnedVersion: 2, updatedBy: "test", updatedAt: "2026-10-26T12:00:00.000Z" });
  if (options.playbook !== undefined) h.db.set({ ...projectPlaybookKey(TEST_ORG, "payments"), entityType: "PROJECT_PLAYBOOK", ...options.playbook });
  const reads = vi.spyOn(h.db, "send");
  const reply = await h.dev(MAYA, "POST", "/v1/app/projects/payments/code", { requestId: randomUUID(), input: { text: "Add a retry for timed-out payments" } });
  const taskId = String((reply.body.task as { taskId: string }).taskId);
  const workspaceId = (h.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
  const operations = () => h.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
  await h.finish(workspaceId, String(operations().find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
  const understand = operations().find((item) => item.workflowMode === "UNDERSTAND")!;
  await h.artifact(workspaceId, String(understand.id), UNDERSTAND_ARTIFACT_NAME, JSON.stringify(assessment));
  reads.mockClear();
  if (options.dropOrgId === true) {
    const { orgId: _orgId, ...orgless } = h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown>;
    void _orgId;
    h.db.set(orgless);
  }
  // `design first:` typed in the request (Slack or Linear intake) is recorded on the task before Understand ends.
  if (options.designFirst === true) h.db.set({ ...(h.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown>), designFirst: { by: MAYA.developerId, at: "2026-11-03T12:00:00.000Z" } });
  await h.finish(workspaceId, String(understand.id), "SUCCEEDED", { result: { workflowMode: "UNDERSTAND" } });
  const playbookRead = reads.mock.calls.some(([command]) => JSON.stringify((command as { input?: unknown }).input ?? {}).includes("PLAYBOOK"));
  return { workflow: (h.db.get(`DEVTASK#${taskId}`, "META") as { workflow: Record<string, unknown> }).workflow, playbookRead };
}

const needed = (extra: Partial<Extract<IntentAssessment, { kind: "ready" }>> = {}): IntentAssessment => ({
  kind: "ready", path: "QUICK", restatement: "Retry timed-out payments.", assumptions: [], design: { needed: true, reasons: ["new_api"], note: "Adds a public API." }, ...extra,
});

describe("the design review at the Understand step's ready answer", () => {
  it("OFF: the setting is never read and the task is what Understand said, with no design review", async () => {
    const result = await understoodAs(needed(), { switchOn: false });
    expect(result.workflow).toMatchObject({ stage: "PLAN", state: "RUNNING", path: "QUICK" });
    expect(result.workflow).not.toHaveProperty("designReview");
    expect(result.playbookRead).toBe(false);
  });

  it("OFF, a task with no orgId: Understand's ready answer moves it on to PLAN as it always did (B-M1: the org is not required before the switch is checked)", async () => {
    const result = await understoodAs(needed(), { switchOn: false, dropOrgId: true });
    expect(result.workflow).toMatchObject({ stage: "PLAN", state: "RUNNING", path: "QUICK" });
    expect(result.workflow).not.toHaveProperty("designReview");
    expect(result.workflow.blockReason).toBeUndefined();
    // ... and with the switch ON but no org to read a setting for, the same: no review, no block.
    const on = await understoodAs(needed(), { switchOn: true, dropOrgId: true });
    expect(on.workflow).toMatchObject({ stage: "PLAN", state: "RUNNING", path: "QUICK" });
    expect(on.workflow.blockReason).toBeUndefined();
  });

  it("the switch alone runs no project: `dr` on with no company policy, or a company that has not allowed design review, is OFF and the playbook is never read (fail closed)", async () => {
    for (const company of [null, { allowed: false }, { allowed: false, defaultMode: "always" }] as const) {
      const result = await understoodAs(needed(), { switchOn: true, company });
      expect(result.workflow, JSON.stringify(company)).toMatchObject({ stage: "PLAN", state: "RUNNING", path: "QUICK" });
      expect(result.workflow).not.toHaveProperty("designReview");
      expect(result.playbookRead, JSON.stringify(company)).toBe(false);
    }
  });

  it("`dp` decides nothing any more: the old project list is ignored whether or not it names the project", async () => {
    for (const dp of ["billing:payments", "billing", ""]) {
      vi.stubEnv("DESIGN_REVIEW_PROJECTS", dp);
      const result = await understoodAs(needed(), { switchOn: true });
      expect(result.workflow, dp).toMatchObject({ path: "FULL", designReview: { status: "estimating" } });
    }
  });

  it("a project with no setting of its own runs the company's default mode: Off runs nothing, Auto decides from the request, Always reviews every design", async () => {
    const small = needed({ design: { needed: false, reasons: ["small_change"], note: "A one-line fix." } });
    const off = await understoodAs(needed(), { switchOn: true, company: { defaultMode: "never" } });
    expect(off.workflow).toMatchObject({ path: "QUICK" });
    expect(off.workflow).not.toHaveProperty("designReview");
    expect((await understoodAs(small, { switchOn: true, company: { defaultMode: "auto" } })).workflow).not.toHaveProperty("designReview");
    expect((await understoodAs(small, { switchOn: true, company: { defaultMode: "always" } })).workflow).toMatchObject({ path: "FULL", designReview: { decidedBy: "always" } });
  });

  it("a project's own setting beats the company default, and the company lock still clamps it", async () => {
    const own = (mode: string) => ({ revision: 1, defaultProcess: { kind: "builtin" }, designReview: { mode, tier: "standard", allowSkip: true, capUsdPerTask: 10, highRiskApprover: { kind: "maintainers" } } });
    expect((await understoodAs(needed(), { switchOn: true, company: { defaultMode: "never" }, playbook: own("auto") })).workflow).toMatchObject({ path: "FULL", designReview: { decidedBy: "auto" } });
    expect((await understoodAs(needed(), { switchOn: true, company: { defaultMode: "always" }, playbook: own("never") })).workflow).not.toHaveProperty("designReview");
    expect((await understoodAs(needed(), { switchOn: true, company: { defaultMode: "never", lock: { mode: "always" } }, playbook: own("never") })).workflow).toMatchObject({ designReview: { decidedBy: "always" } });
  });

  it("ON, a design that is needed: the effective setting decides, the task is forced onto the Full path at the requirements, and the review is switched on with the project's tier and cap", async () => {
    const result = await understoodAs(needed(), { switchOn: true });
    expect(result.workflow).toMatchObject({ stage: "PLAN", state: "RUNNING", path: "FULL", reviewPhase: "REQUIREMENTS", designReview: { decidedBy: "auto", status: "estimating", tier: "standard", capUsd: 10, reasons: ["new_api"], rounds: [] } });
    expect(result.playbookRead).toBe(true);
  });

  it("ON, a design that is not needed: nothing changes", async () => {
    const result = await understoodAs(needed({ design: { needed: false, reasons: ["small_change"], note: "A one-line fix." } }), { switchOn: true });
    expect(result.workflow).toMatchObject({ stage: "PLAN", state: "RUNNING", path: "QUICK" });
    expect(result.workflow).not.toHaveProperty("designReview");
  });

  it("ON, a project that reviews every design: the review is on whatever Understand read, decided by the setting", async () => {
    const result = await understoodAs(needed({ design: { needed: false, reasons: ["small_change"], note: "A one-line fix." } }), { switchOn: true, playbook: { revision: 1, defaultProcess: { kind: "builtin" }, designReview: { mode: "always", tier: "light", allowSkip: false, capUsdPerTask: 3, highRiskApprover: { kind: "maintainers" } } } });
    expect(result.workflow).toMatchObject({ path: "FULL", designReview: { decidedBy: "always", tier: "light", capUsd: 3 } });
  });

  it("ON, a project that never reviews a design: nothing changes", async () => {
    const result = await understoodAs(needed(), { switchOn: true, playbook: { revision: 1, defaultProcess: { kind: "builtin" }, designReview: { mode: "never", tier: "standard", allowSkip: true, capUsdPerTask: 10, highRiskApprover: { kind: "maintainers" } } } });
    expect(result.workflow).toMatchObject({ path: "QUICK" });
    expect(result.workflow).not.toHaveProperty("designReview");
  });
});

describe("`design first:` typed in the request", () => {
  const never = { revision: 1, defaultProcess: { kind: "builtin" }, designReview: { mode: "never", tier: "standard", allowSkip: true, capUsdPerTask: 5, highRiskApprover: { kind: "maintainers" } }, updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: MAYA.developerId };
  const notNeeded = (): IntentAssessment => ({ kind: "ready", path: "QUICK", restatement: "Fix a typo.", assumptions: [], design: { needed: false, reasons: ["small_change"], note: "A small change." } });

  it("turns the review on even when the project says never and Understand says it is not needed, recorded as the person's ask", async () => {
    const result = await understoodAs(notNeeded(), { switchOn: true, playbook: never, designFirst: true });
    expect(result.workflow).toMatchObject({ path: "FULL", designReview: { decidedBy: "person", startedBy: { actorId: MAYA.developerId }, status: "estimating" } });
  });

  it("without the ask the same task gets no review (positive control)", async () => {
    expect((await understoodAs(notNeeded(), { switchOn: true, playbook: never })).workflow).not.toHaveProperty("designReview");
  });

  it("with the switch off the ask changes nothing", async () => {
    const off = await understoodAs(notNeeded(), { switchOn: false, playbook: never, designFirst: true });
    expect(off.workflow).not.toHaveProperty("designReview");
    expect(off.workflow).toMatchObject({ path: "QUICK" });
  });
});
