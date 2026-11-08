// OWNER DECISION 18: the plan panel's and the feedback view's app routes are a live browser's only (as the old pages were): a token is refused before any task is read, so it learns nothing
// about a task (a missing one answers the same), and the browser reaches exactly these shapes through /v1/web. What each route does is in tests/integration/workflow-e2e/10c-plan-panel.test.ts.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAN_PANEL_BROWSER_MESSAGE, PLAN_PANEL_ROUTE, planPanelView } from "../../packages/broker/src/aws/developer-routes/plan-panel.js";
import { webRouteAllowed } from "../../packages/broker/src/aws/web-auth.js";
import { taskPanelLocation } from "../../packages/broker/src/aws/task-web.js";
import type { TaskDocumentView } from "../../packages/broker/src/aws/task-web.js";
import { createDeveloperTaskBroker, MAYA } from "../support/developer-task-broker.js";

const TASK = "11111111-1111-4111-8111-111111111111", COMMENT = "22222222-2222-4222-8222-222222222222";

describe("plan panel routes: a live browser only", () => {
  const switched = process.env.DECISION_CARDS_ENABLED;
  beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; });
  afterEach(() => { if (switched === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = switched; });

  it("refuses a token on every route before reading the task: a real task and a missing one answer the same", async () => {
    const harness = await createDeveloperTaskBroker();
    for (const [method, path, body] of [
      ["GET", "documents/plan", undefined], ["POST", "comments", { requestId: randomUUID(), document: "plan", version: 1, target: { kind: "document" }, text: "Hi.", ask: false }],
      ["POST", `comments/${COMMENT}/edit`, { rev: 1, text: "x" }], ["POST", `comments/${COMMENT}/delete`, { rev: 1 }], ["POST", "suggestions", { document: "plan", decisionId: "d1", optionId: "a" }],
      ["GET", "workflow/feedback", undefined], ["POST", "workflow/feedback-decision", {}], ["POST", "workflow/feedback-retry", { reviewDigest: "a".repeat(64) }],
    ] as const) {
      const real = await harness.dev(MAYA, method, `/v1/app/tasks/${TASK}/${path}`, body);
      const missing = await harness.dev(MAYA, method, `/v1/app/tasks/${randomUUID()}/${path}`, body);
      expect(real.status, path).toBe(403);
      expect(JSON.stringify(real.body), path).toContain(PLAN_PANEL_BROWSER_MESSAGE);
      expect([missing.status, missing.body.error], path).toEqual([real.status, real.body.error]);
    }
  });

  it("matches exactly the panel's shapes, and the browser may reach exactly those", () => {
    for (const path of [`documents/plan`, `documents/design`, `documents/requirements`, "comments", `comments/${COMMENT}/edit`, `comments/${COMMENT}/delete`, "suggestions", "workflow/feedback", "workflow/feedback-decision", "workflow/feedback-retry"]) {
      expect(PLAN_PANEL_ROUTE.test(`/v1/app/tasks/${TASK}/${path}`), path).toBe(true);
    }
    for (const path of ["documents/other", "documents/plan/x", `comments/${COMMENT}/remember`, `comments/${COMMENT}`, "suggestions/x", "workflow/feedback-retries", "workflow/retry"]) {
      expect(PLAN_PANEL_ROUTE.test(`/v1/app/tasks/${TASK}/${path}`), path).toBe(false);
    }
    expect(webRouteAllowed("GET", `/v1/web/tasks/${TASK}/documents/plan`)).toBe(true);
    expect(webRouteAllowed("POST", `/v1/web/tasks/${TASK}/documents/plan`)).toBe(false);
    expect(webRouteAllowed("POST", `/v1/web/tasks/${TASK}/comments`)).toBe(true);
    expect(webRouteAllowed("POST", `/v1/web/tasks/${TASK}/comments/${COMMENT}/edit`)).toBe(true);
    expect(webRouteAllowed("POST", `/v1/web/tasks/${TASK}/comments/${COMMENT}/delete`)).toBe(true);
    expect(webRouteAllowed("DELETE", `/v1/web/tasks/${TASK}/comments/${COMMENT}`)).toBe(false);
    expect(webRouteAllowed("POST", `/v1/web/tasks/${TASK}/suggestions`)).toBe(true);
    expect(webRouteAllowed("GET", `/v1/web/tasks/${TASK}/workflow/feedback`)).toBe(true);
    expect(webRouteAllowed("POST", `/v1/web/tasks/${TASK}/workflow/feedback-decision`)).toBe(true);
    expect(webRouteAllowed("POST", `/v1/web/tasks/${TASK}/workflow/feedback-retry`)).toBe(true);
    expect(webRouteAllowed("GET", `/v1/web/tasks/${TASK}/workflow/feedback-retry`)).toBe(false);
  });

  it("an old link forwards only to a task page of the fixed shape, with a document from the fixed list", () => {
    expect(taskPanelLocation("/app/sessions/ses_0123456789abcdefghij", "coding-plan")).toBe("/app/sessions/ses_0123456789abcdefghij?doc=plan");
    expect(taskPanelLocation("/app/sessions/ses_0123456789abcdefghij", undefined)).toBe("/app/sessions/ses_0123456789abcdefghij?doc=plan");
    expect(taskPanelLocation("/app/sessions/ses_0123456789abcdefghij", "requirements")).toBe("/app/sessions/ses_0123456789abcdefghij?doc=requirements");
    for (const bad of [undefined, "/app/projects/demo", "https://evil.example/app/sessions/ses_0123456789abcdefghij", "/app/sessions/ses_0123456789abcdefghij/../x"]) {
      expect(taskPanelLocation(bad, "design"), String(bad)).toBeUndefined();
    }
  });

  it("the panel's view of a document redacts and flattens the model's text and keeps only this document's checks", () => {
    const view = {
      taskId: TASK, title: "t", status: "s", nextStep: "n", path: "QUICK", stage: "Coding plan", role: "owner", findings: [], pullRequests: [], history: [],
      checks: [{ id: "unit", label: "Unit‮tests", passed: undefined }, { label: "No id", passed: undefined }],
      access: { role: "owner", canComment: true, canSuggest: false, canDecide: true, canAsk: true }, askAvailable: false,
      waiting: { kind: "coding plan", version: 1, artifactDigest: "a".repeat(64) },
      documents: [{ kind: "coding plan", version: 1, approved: false, current: true, format: "structured", plan: {
        schemaVersion: 1, title: "Fix\u0000 it", why: [{ text: "Because.", author: "Maya" }], claims: [{ id: "1", text: "Line one\nline two" }], notChanging: [], risks: [], decisions: [],
      } }],
    } as unknown as TaskDocumentView;
    const plan = planPanelView(view, "plan");
    expect(plan).toMatchObject({ waiting: true, checks: [{ id: "unit", label: "Unit tests" }], access: { canAsk: false, canDecide: true }, current: { title: "Fix it", claims: [{ id: "1", text: "Line one line two" }] } });
    expect(planPanelView(view, "design")).toMatchObject({ waiting: false, checks: [], versions: [] });
  });

  it("an older version of a document reads whole but read-only: its own text, no checks, nothing to decide, and a missing version is refused", () => {
    const entry = (version: number, current: boolean, title: string) => ({ kind: "coding plan", version, approved: version === 1, current, format: "structured",
      plan: { schemaVersion: 1, title, why: [], claims: [{ id: "1", text: "Claim " + String(version) }], notChanging: [], risks: [], decisions: [] } });
    const view = { taskId: TASK, title: "t", status: "s", nextStep: "n", path: "QUICK", stage: "Coding plan", role: "owner", findings: [], pullRequests: [], history: [],
      checks: [{ id: "unit", label: "Unit tests", passed: undefined }], access: { role: "owner", canComment: true, canSuggest: true, canDecide: true, canAsk: true }, askAvailable: true,
      waiting: { kind: "coding plan", version: 2, artifactDigest: "a".repeat(64) }, documents: [entry(1, false, "First"), entry(2, true, "Second")] } as unknown as TaskDocumentView;
    const older = planPanelView(view, "plan", 1);
    expect(older).toMatchObject({ older: { currentVersion: 2 }, current: { version: 1, approved: true, title: "First", claims: [{ id: "1", text: "Claim 1" }] }, checks: [], waiting: false,
      access: { canComment: false, canSuggest: false, canDecide: false, canAsk: false }, versions: [{ version: 1, current: false }, { version: 2, current: true }] });
    // Asking for the current version, or for none, is the ordinary current view.
    for (const same of [planPanelView(view, "plan"), planPanelView(view, "plan", 2)]) {
      expect(same).toMatchObject({ current: { version: 2, title: "Second" }, waiting: true, checks: [{ id: "unit" }], access: { canDecide: true } });
      expect(same.older).toBeUndefined();
    }
    expect(() => planPanelView(view, "plan", 7)).toThrow("That version isn't available.");
    expect(() => planPanelView(view, "design", 1)).toThrow("That version isn't available.");
  });
});
