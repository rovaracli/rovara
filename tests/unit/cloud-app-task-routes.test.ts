// S3 item 7 (rest): Cloud's decide and close for a task the core runs, answered by the core by the task's STAMP, with the switch on or off, and a Cloud task left alone. The core's answers go through the real
// A6 adapters and Code's real gate and flow (the shared rig). The seam in `routeDeveloperTaskRequest` and the three function gates are tested with a stub hook, so a Cloud task provably never reaches it.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { AgentXError, agentXError } from "@rovara-code/contracts";
import type { DeveloperTaskView } from "@agentx/cloud-contracts";
import { createCloudIdentityProvider } from "../../packages/broker/src/cloud/adapters/people/index.js";
import {
  ENGINE_UNAVAILABLE_WORDS, NOT_YOURS_WORDS, NO_CREDENTIAL_WORDS, WORKFLOW_DOCUMENT_KIND, SKIP_REFUSED_WORDS, REVISE_OWNER_ONLY_WORDS, REVISE_NO_SESSION_WORDS,
  coreDecisionRefusal, createCoreTaskRoutes,
} from "../../packages/broker/src/cloud/app/index.js";
import { CLOSE_REFUSED } from "../../packages/broker/src/aws/developer-tasks/close.js";
import { CORE_ACTION_WORDS, CORE_NOT_AVAILABLE_PREFIX, CORE_TASK_ANSWERED_ACTIONS, coreActionWords, CORE_TASK_CLOUD_ACTIONS, installCoreTaskRoutes, type CoreTaskRoutes } from "../../packages/broker/src/rovara-code/task-routes.js";
import { routeDeveloperTaskRequest } from "../../packages/broker/src/aws/developer-tasks.js";
import { decideTaskWorkflow } from "../../packages/broker/src/aws/developer-tasks/decide.js";
import { closeTask } from "../../packages/broker/src/aws/developer-tasks/close.js";
import { cancelTask, cancelTaskFor } from "../../packages/broker/src/aws/developer-tasks/cancel.js";
import { retryTaskWorkflow } from "../../packages/broker/src/aws/developer-tasks/workflow-retry.js";
import { reviseTaskWorkflowPlan } from "../../packages/broker/src/aws/developer-tasks/workflow-revise.js";
import { PEOPLE_ORG, createPeopleWorld, type Person, type PeopleWorld } from "../support/cloud-people-world.js";
import { companyScoped, orgProjectCatalogKey, projectMemberKey, projectMetaKey, projectRevisionKey } from "@rovara-code/contracts";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes/dependencies.js";
import { plannedTask, rig, type Rig } from "../support/cloud-core-rig.js";
import type { CloudApp } from "../../packages/broker/src/cloud/app/index.js";

afterEach(() => installCoreTaskRoutes(undefined));

const callerOf = (person: Person, extra: Record<string, unknown> = {}) => ({
  developerId: person.developerId, sessionId: person.sessionId, amr: person.amr, name: person.name, orgId: person.orgId, orgRole: person.role, ...extra,
}) as never;
const browser = (person: Person) => callerOf(person, { browserSession: true });

const metaOf = async (r: Rig, taskId: string) => (await r.world.store.get({ pk: `DEVTASK#${taskId}`, sk: "META" })) as unknown as { closedAt?: string; workflow?: { revision: number; artifacts: Array<{ sha256: string }> } };
const viewOf = (r: Rig, taskId: string) => async (): Promise<DeveloperTaskView> => ({ taskId, status: (await metaOf(r, taskId)).closedAt === undefined ? "WAITING" : "CLOSED" }) as never;

function routesOver(r: Rig, app: CloudApp = r.app, workflowOverlay?: Record<string, unknown>): CoreTaskRoutes {
  const provider = createCloudIdentityProvider(r.people.routes);
  return createCoreTaskRoutes({
    app, log: () => undefined,
    read: async (key) => {
      const row = (await r.world.store.get(key)) as Record<string, unknown> | undefined;
      return workflowOverlay !== undefined && row?.["workflow"] !== undefined ? { ...row, workflow: { ...(row["workflow"] as object), ...workflowOverlay } } : row;
    },
    principalOf: async (caller) => (await provider.getPrincipal(caller.orgId, caller.developerId))!,
  });
}

async function planned(r: Rig) {
  r.standing.set(r.people.people.owner.developerId, "owner");
  r.standing.set(r.people.people.maintainer.developerId, "maintainer");
  const { taskId } = await plannedTask(r);
  const meta = await metaOf(r, taskId);
  const workflow = meta.workflow!;
  const body = (extra: Record<string, unknown> = {}) => ({
    requestId: randomUUID(), expectedRevision: workflow.revision, decision: "APPROVE", reason: "fine", artifactDigest: workflow.artifacts.at(-1)!.sha256, ...extra,
  });
  return { taskId, body };
}

const refusal = async (promise: Promise<unknown>) => await promise.then(() => undefined, (error: unknown) => error as AgentXError);

for (const switchState of ["on", "off"] as const) {
  describe(`a core-stamped task, switch ${switchState}: Cloud's routes are answered by the core`, () => {
    const setup = async () => {
      const r = await rig();
      const { taskId, body } = await planned(r);
      // `off`: a later container with the switch OFF still serves the stamped task.
      const app = switchState === "on" ? r.app : r.rebuild({ env: {}, serveStamped: true });
      return { r, taskId, body, routes: routesOver(r, app), owner: r.people.people.owner };
    };

    it("owns: the stamp says core for the company's own task", async () => {
      const { routes, taskId, owner } = await setup();
      expect(await routes.owns(browser(owner), taskId)).toBe(true);
    });

    it("decide: the owner's browser session approves", async () => {
      const { r, routes, taskId, body, owner } = await setup();
      const answer = await routes.decide({ caller: browser(owner), taskId, value: body(), view: viewOf(r, taskId) });
      expect(answer.task.taskId).toBe(taskId);
      expect((await metaOf(r, taskId)).workflow).toMatchObject({ decisions: [{ decision: "APPROVE" }] });
    });

    it("decide: the owner's developer token is presented as the tool method (a tool approves low risk only, as in Cloud), and the decision is the gate's", async () => {
      const { r, routes, taskId, body, owner } = await setup();
      const error = await refusal(routes.decide({ caller: callerOf(owner), taskId, value: body(), bearer: r.people.tokenOf(owner), view: viewOf(r, taskId) }));
      expect(error).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("tool_low_risk_only") as string });
      // A token the verifier does not know is not the owner at all.
      expect(await refusal(routes.decide({ caller: callerOf(owner), taskId, value: body(), bearer: "tok-unknown", view: viewOf(r, taskId) }))).toMatchObject({ code: expect.stringMatching(/FORBIDDEN|TASK_NOT_FOUND/) as string });
      expect((await metaOf(r, taskId)).workflow).toMatchObject({ decisions: [] });
    });

    it("L-2: a HIGH plan card's press carries the decide-grade cookie: the credential is the browser-step-up method (this card, unused, recent), and the decision is the gate's", async () => {
      const { r, routes, taskId, body, owner } = await setup();
      const decision = body();
      const token = await r.people.stepUp(owner, taskId, { contentVersion: decision.artifactDigest });
      const cookie = token.slice(token.indexOf(":") + 1);
      const answer = await routes.decide({ caller: browser(owner), taskId, value: decision, stepUpCookie: cookie, view: viewOf(r, taskId) });
      expect(answer.task.taskId).toBe(taskId);
      expect((await metaOf(r, taskId)).workflow).toMatchObject({ decisions: [{ decision: "APPROVE" }] });
      // The step-up is a sign-in for ONE card: the gate spends it across every request (it is not in the gate's reusable methods), while the browser session it rode on is not spent.
      const markers = (await r.world.store.query({ pk: companyScoped(PEOPLE_ORG, "APPROVAL_PROOF") })).items.filter((item) => item["entityType"] === "APPROVAL_PROOF_SPENT");
      expect(markers.map((item) => item["method"])).toEqual(["browser-step-up"]);
    });

    it("L-2: a step-up for another card, a cookie that is not a decide session, and a caller that is no browser session are refused, and nothing is decided", async () => {
      const { r, routes, taskId, body, owner } = await setup();
      const other = await r.people.stepUp(owner, taskId, { contentVersion: "c".repeat(64) });
      for (const stepUpCookie of [other.slice(other.indexOf(":") + 1), "x".repeat(64)]) {
        expect(await refusal(routes.decide({ caller: browser(owner), taskId, value: body(), stepUpCookie, view: viewOf(r, taskId) })), stepUpCookie).toMatchObject({ code: "FORBIDDEN" });
      }
      expect(await refusal(routes.decide({ caller: callerOf(owner), taskId, value: body(), stepUpCookie: "x".repeat(64), view: viewOf(r, taskId) }))).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining(NO_CREDENTIAL_WORDS) as string });
      expect((await metaOf(r, taskId)).workflow).toMatchObject({ decisions: [] });
    });

    it("decide: a caller with no credential to present (a Slack event, a script token, a token with no header) is refused, and nothing is decided", async () => {
      const { r, routes, taskId, body, owner } = await setup();
      for (const caller of [callerOf(owner), callerOf(owner, { scriptToken: { tokenId: "t", name: "n", permissions: ["start"], projects: [] } })]) {
        const error = await refusal(routes.decide({ caller, taskId, value: body(), bearer: r.people.tokenOf(owner).length > 0 && (caller as { scriptToken?: unknown }).scriptToken !== undefined ? r.people.tokenOf(owner) : undefined, view: viewOf(r, taskId) }));
        expect(error, "refused").toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining(NO_CREDENTIAL_WORDS) as string });
      }
      expect((await metaOf(r, taskId)).workflow).toMatchObject({ decisions: [] });
    });

    it("decide: refusals come in Cloud's codes and words (not the owner, stale, skip, a reused request id)", async () => {
      const { r, routes, taskId, body, owner } = await setup();
      const { member } = r.people.people;
      expect(await refusal(routes.decide({ caller: browser(member), taskId, value: body(), view: viewOf(r, taskId) }))).toMatchObject({ code: "TASK_NOT_FOUND", message: expect.stringContaining(NOT_YOURS_WORDS) as string });
      expect(await refusal(routes.decide({ caller: browser(owner), taskId, value: body({ expectedRevision: 999 }), view: viewOf(r, taskId) }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(await refusal(routes.decide({ caller: browser(owner), taskId, value: body({ decision: "SKIP" }), view: viewOf(r, taskId) }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(SKIP_REFUSED_WORDS) as string });
      expect(await refusal(routes.decide({ caller: browser(owner), taskId, value: { requestId: "no" }, view: viewOf(r, taskId) }))).toMatchObject({ code: "CONFIG_INVALID" });
      expect((await metaOf(r, taskId)).workflow).toMatchObject({ decisions: [] });
    });

    it("decide: a maintainer's seat limits read as Cloud's (the run limit is the owner's; closing as answered reads as no task)", async () => {
      const { r, routes, taskId, body } = await setup();
      const maintainer = browser(r.people.people.maintainer);
      expect(await refusal(routes.decide({ caller: maintainer, taskId, value: body({ acknowledgedRunLimitUsd: 5 }), view: viewOf(r, taskId) }))).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("run limit") as string });
      expect(await refusal(routes.decide({ caller: maintainer, taskId, value: body({ decision: "REJECT", closeAsAnswered: true }), view: viewOf(r, taskId) }))).toMatchObject({ code: "TASK_NOT_FOUND" });
    });

    it("close: a task whose coding never ran closes, as DeveloperCloseResponse; the same request again answers the same", async () => {
      const { r, routes, taskId, owner } = await setup();
      const first = await routes.close({ caller: browser(owner), taskId, value: { requestId: randomUUID() }, view: viewOf(r, taskId) });
      expect(first).toMatchObject({ closed: true });
      expect((await metaOf(r, taskId)).closedAt).toBeDefined();
      expect(await routes.close({ caller: browser(owner), taskId, value: { requestId: randomUUID() }, view: viewOf(r, taskId) })).toMatchObject({ closed: true });
    });

    it("close: a caller the flow's access rule refuses reads as no task, in Cloud's words, and nothing closes", async () => {
      const { r, taskId, owner } = await setup();
      const app = switchState === "on" ? r.app : r.rebuild({ env: {}, serveStamped: true });
      const refusing = async (...args: unknown[]) => { void args; throw agentXError("TASK_NOT_FOUND", "no such task"); };
      const denied = Object.create(app, { runtimeFor: { value: async (company: string) => {
        const runtime = await app.runtimeFor(company);
        return { ...runtime, flow: { ...runtime.flow, get: refusing, close: refusing } };
      } } }) as CloudApp;
      expect(await refusal(routesOver(r, denied).close({ caller: browser(owner), taskId, value: { requestId: randomUUID() }, view: viewOf(r, taskId) }))).toMatchObject({ code: "TASK_NOT_FOUND", message: expect.stringContaining(NOT_YOURS_WORDS) as string });
      expect((await metaOf(r, taskId)).closedAt).toBeUndefined();
    });

    it("close: the vendor's candidateIsOnPullRequest decides what is published: the candidate on an open pull request closes; a commit made after it was opened, or none, is held; a merged one closes", async () => {
      const { r, taskId, owner } = await setup();
      const app = (switchState === "on" ? r.app : r.rebuild({ env: {}, serveStamped: true }));
      const coded = Object.create(app, { runtimeFor: { value: async (company: string) => {
        const runtime = await app.runtimeFor(company);
        return { ...runtime, flow: { ...runtime.flow, get: async (...args: Parameters<typeof runtime.flow.get>) => ({ ...(await runtime.flow.get(...args)), operations: [{ id: "o", kind: "task", status: "SUCCEEDED", workflowMode: "IMPLEMENT" }] }) } };
      } } }) as CloudApp;
      const candidate = { repositories: [{ repositoryId: "repo-1", commitSha: "a".repeat(40) }] };
      const pr = (state: string, headSha: string | undefined) => ({ pullRequests: [{ repositoryId: "repo-1", state, ...(headSha === undefined ? {} : { headSha }) }], candidate });
      const close = async (overlay: Record<string, unknown>, discard = false) => await routesOver(r, coded, overlay).close({ caller: browser(owner), taskId, value: { requestId: randomUUID(), ...(discard ? { discard_unpublished: true } : {}) }, view: viewOf(r, taskId) });
      expect(await close(pr("OPEN", "b".repeat(40)))).toMatchObject({ closed: false, message: CLOSE_REFUSED });
      expect(await close(pr("OPEN", undefined))).toMatchObject({ closed: false });
      expect(await close({ pullRequests: [], candidate })).toMatchObject({ closed: false });
      expect((await metaOf(r, taskId)).closedAt).toBeUndefined();
      expect(await close(pr("OPEN", "a".repeat(40)))).toMatchObject({ closed: true });
    });

    it("close: a merged pull request is published, whatever the candidate is now", async () => {
      const { r, taskId, owner } = await setup();
      const app = (switchState === "on" ? r.app : r.rebuild({ env: {}, serveStamped: true }));
      const coded = Object.create(app, { runtimeFor: { value: async (company: string) => {
        const runtime = await app.runtimeFor(company);
        return { ...runtime, flow: { ...runtime.flow, get: async (...args: Parameters<typeof runtime.flow.get>) => ({ ...(await runtime.flow.get(...args)), operations: [{ id: "o", kind: "task", status: "SUCCEEDED", workflowMode: "IMPLEMENT" }] }) } };
      } } }) as CloudApp;
      const overlay = { pullRequests: [{ repositoryId: "repo-1", state: "MERGED", headSha: "c".repeat(40) }], candidate: { repositories: [{ repositoryId: "repo-1", commitSha: "d".repeat(40) }] } };
      const got = await routesOver(r, coded, overlay).close({ caller: browser(owner), taskId, value: { requestId: randomUUID() }, view: viewOf(r, taskId) });
      expect(got).toMatchObject({ closed: true });
    });

    it("close: coding ran and nothing is published: not closed, in Cloud's words, until the owner discards", async () => {
      const { r, taskId, owner } = await setup();
      const app = (switchState === "on" ? r.app : r.rebuild({ env: {}, serveStamped: true }));
      const coded = Object.create(app, { runtimeFor: { value: async (company: string) => {
        const runtime = await app.runtimeFor(company);
        return { ...runtime, flow: { ...runtime.flow, get: async (...args: Parameters<typeof runtime.flow.get>) => ({ ...(await runtime.flow.get(...args)), operations: [{ id: "o", kind: "task", status: "SUCCEEDED", workflowMode: "IMPLEMENT" }] }) } };
      } } }) as CloudApp;
      const routes = routesOver(r, coded);
      const held = await routes.close({ caller: browser(owner), taskId, value: { requestId: randomUUID() }, view: viewOf(r, taskId) });
      expect(held).toMatchObject({ closed: false, message: CLOSE_REFUSED });
      expect((await metaOf(r, taskId)).closedAt).toBeUndefined();
      expect(await routes.close({ caller: browser(owner), taskId, value: { requestId: randomUUID(), discard_unpublished: true }, view: viewOf(r, taskId) })).toMatchObject({ closed: true });
    });
  });
}

describe("owner decision 198: every action a core task cannot do yet says so in plain words, never a generic error", () => {
  const REFUSED = ["workflow/send-back", "continue", "workflow/review-findings", "workflow/review", "pull-requests", "workflow/keep-pull-requests", "workflow/publish-retry", "workflow/feedback-decision", "workflow/feedback-retry", "canvas-closeout/retry", "e2e-publication-context"];

  it("each refused action has its own sentence, in the same plain first words, and says what to do instead", () => {
    expect(Object.keys(CORE_ACTION_WORDS).sort()).toEqual([...REFUSED].sort());
    for (const action of REFUSED) {
      const words = coreActionWords(action);
      expect(words, action).toMatch(new RegExp(`^${CORE_NOT_AVAILABLE_PREFIX.replace(/\./gu, "\\.")} `, "u"));
      expect(words, action).not.toMatch(/CONFIG_INVALID|error|failed|route not found|not found/iu);
      expect(words.length, action).toBeGreaterThan(CORE_NOT_AVAILABLE_PREFIX.length + 20);
    }
    // The actions that mean "change the work" tell the person to close this task and start a new one with the extra instructions.
    for (const action of ["workflow/send-back", "continue", "workflow/review-findings", "workflow/feedback-decision", "workflow/feedback-retry"]) expect(coreActionWords(action), action).toContain("close this task and start a new one");
    expect(coreActionWords("workflow/send-back")).toBe("Not available on this task yet. To make more changes, close this task and start a new one with the extra instructions.");
    // Retry, cancel and revising the plan are the core's to answer now (Code's session actions at the 0.5.19 pin): none of them is refused in words.
    for (const action of ["workflow/retry", "cancel", "workflow/revise-plan"]) {
      expect(CORE_ACTION_WORDS[action], action).toBeUndefined();
      expect(CORE_TASK_ANSWERED_ACTIONS.has(action), action).toBe(true);
    }
  });

  it("the sentences differ where the advice differs (a kept pull request, a canvas or E2E check, a review are not told to start again)", () => {
    expect(new Set(REFUSED.map((action) => coreActionWords(action))).size).toBeGreaterThan(7);
    expect(coreActionWords("workflow/keep-pull-requests")).toContain("stay on GitHub");
    expect(coreActionWords("canvas-closeout/retry")).toContain("canvas");
    expect(coreActionWords("e2e-publication-context")).toContain("End-to-end");
  });

  it("an action no row names still gets the plain words (never a generic error)", () => {
    expect(coreActionWords("workflow/some-new-action")).toBe(`${CORE_NOT_AVAILABLE_PREFIX} To make more changes, close this task and start a new one with the extra instructions.`);
  });
});

describe("a Cloud task, and the engine being down", () => {
  it("owns is false for a task with no core stamp, another company's task, and a task that does not exist (Cloud's reader answers)", async () => {
    const r = await rig();
    const { taskId } = await planned(r);
    const routes = routesOver(r);
    const id = randomUUID();
    await r.world.store.put({ item: { pk: `DEVTASK#${id}`, sk: "META", entityType: "DEVTASK", orgId: PEOPLE_ORG } });
    expect(await routes.owns(browser(r.people.people.owner), id)).toBe(false);
    expect(await routes.owns(browser(r.people.people.owner), randomUUID())).toBe(false);
    expect(await routes.owns(browser(r.people.people.stranger), taskId)).toBe(false);
  });

  it("a root that cannot be built answers RUNTIME_UNAVAILABLE for a decision, never Cloud's code", async () => {
    const r = await rig();
    const { taskId, body } = await planned(r);
    const broken = Object.create(r.app, { runtimeFor: { value: async () => { throw new Error("point empty"); } } }) as CloudApp;
    const routes = routesOver(r, broken);
    expect(await refusal(routes.decide({ caller: browser(r.people.people.owner), taskId, value: body(), view: viewOf(r, taskId) }))).toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining(ENGINE_UNAVAILABLE_WORDS) as string });
  });

  it("the decision subject's kind is the vendored source's", () => {
    expect(readFileSync("vendor/rovara-code/packages/broker/src/core/decisions/workflow-subject.ts", "utf8")).toContain(`WORKFLOW_DOCUMENT_KIND = "${WORKFLOW_DOCUMENT_KIND}"`);
  });

  it("every gate refusal reason has a code (nothing falls to a raw status)", () => {
    for (const reason of ["not_found", "not_the_approver", "invalid", "invalid_outcome", "unsupported", "not_waiting", "stale", "expired", "request_id_reused", "method_not_allowed", "sign_in_not_fresh", "not_approved", "self_approval_not_allowed", "needs_more_approvers", "proof_already_used"]) {
      expect(coreDecisionRefusal({ reason, detail: "words" }, {}), reason).toBeInstanceOf(AgentXError);
    }
  });
});

describe("the seam: Cloud's route and functions hand a core task to the hook, and a Cloud task never reaches it", () => {
  const calls: string[] = [];
  const stub = (owned: boolean): CoreTaskRoutes => ({
    owns: async () => owned,
    decide: async (input) => { calls.push(`decide:${input.bearer ?? "none"}:${input.via ?? "none"}${input.stepUpCookie === undefined ? "" : `:step-up=${input.stepUpCookie}`}`); return { task: { taskId: input.taskId } as never }; },
    close: async (input) => { calls.push("close"); return { task: { taskId: input.taskId } as never, closed: true }; },
    retry: async (input) => { calls.push("retry"); return { task: { taskId: input.taskId } as never }; },
    cancel: async (input) => { calls.push("cancel"); return { task: { taskId: input.taskId } as never, nothingRunning: false }; },
    revisePlan: async (input) => { calls.push("revise-plan"); return { task: { taskId: input.taskId } as never }; },
  });
  const taskId = randomUUID();
  const request = (path: string, headers: Record<string, string> = {}, body: unknown = {}) => ({ method: "POST", path: `/v1/dev/tasks/${taskId}/${path}`, headers, requestId: randomUUID(), body: JSON.stringify(body) });
  const route = (path: string, headers?: Record<string, string>) => routeDeveloperTaskRequest({} as never, callerOf({ developerId: "d".repeat(64), sessionId: "s", orgId: PEOPLE_ORG, role: "owner", name: "n", amr: "oidc", key: "k" }), request(path, headers), new URL(`https://x.test/v1/dev/tasks/${taskId}/${path}`));

  it("a core task: decide gets the request's bearer; close, retry, cancel and revise-plan go to the core; every other Cloud workflow action is refused in words", async () => {
    calls.length = 0;
    installCoreTaskRoutes(stub(true));
    await route("workflow/decision", { authorization: "Bearer abc.def" });
    await route("close");
    await route("workflow/retry");
    await route("cancel");
    await route("workflow/revise-plan");
    expect(calls).toEqual(["decide:abc.def:none", "close", "retry", "cancel", "revise-plan"]);
    for (const action of ["workflow/send-back", "workflow/review", "workflow/publish-retry", "workflow/keep-pull-requests", "workflow/review-findings", "workflow/feedback-decision", "workflow/feedback-retry", "canvas-closeout/retry", "pull-requests", "continue", "e2e-publication-context"]) {
      expect(await refusal(route(action)), action).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(coreActionWords(action)) as string });
    }
  });

  it("a core task: a People change and sharing are still Cloud's (the hook is not asked to answer them)", async () => {
    calls.length = 0;
    installCoreTaskRoutes(stub(true));
    for (const action of ["people/role", "people/take-ownership", "share"]) {
      const error = await refusal(route(action));
      expect(String((error as Error | undefined)?.message), action).not.toContain(CORE_NOT_AVAILABLE_PREFIX);
    }
    expect(calls).toEqual([]);
    expect([...CORE_TASK_CLOUD_ACTIONS].sort()).toEqual(["people/role", "people/take-ownership", "share"]);
    expect([...CORE_TASK_ANSWERED_ACTIONS].sort()).toEqual(["cancel", "close", "workflow/decision", "workflow/retry", "workflow/revise-plan"]);
  });

  it("a Cloud task (the hook says it is not the core's), and no hook at all: the hook is never asked to decide, close or refuse", async () => {
    for (const hook of [stub(false), undefined]) {
      calls.length = 0;
      installCoreTaskRoutes(hook);
      for (const action of ["workflow/decision", "close", "cancel", "workflow/retry", "workflow/revise-plan"]) {
        const error = await refusal(route(action));
        expect(String((error as Error | undefined)?.message), action).not.toContain("new engine");
      }
      expect(calls).toEqual([]);
    }
  });

  it("L-2: a plan card's decide-grade cookie reaches the hook as the step-up (decideTaskWorkflow's coreStepUp option)", async () => {
    calls.length = 0;
    installCoreTaskRoutes(stub(true));
    const caller = callerOf({ developerId: "d".repeat(64), sessionId: "s", orgId: PEOPLE_ORG, role: "owner", name: "n", amr: "oidc", key: "k" }, { browserSession: true });
    await decideTaskWorkflow({} as never, caller, taskId, {}, { coreStepUp: "cookie-value" });
    expect(calls).toEqual(["decide:none:none:step-up=cookie-value"]);
  });

  it("the function gates cover every other caller of decide, close, retry, cancel and revise (the task page, a card, a session's stop and retry)", async () => {
    calls.length = 0;
    installCoreTaskRoutes(stub(true));
    const caller = callerOf({ developerId: "d".repeat(64), sessionId: "s", orgId: PEOPLE_ORG, role: "owner", name: "n", amr: "oidc", key: "k" }, { browserSession: true });
    await decideTaskWorkflow({ coreBearer: "tok" } as never, caller, taskId, {}, { via: "PAGE" });
    await closeTask({} as never, caller, taskId, {});
    await retryTaskWorkflow({} as never, caller, taskId, {});
    await cancelTask({} as never, caller, taskId, {});
    expect(await cancelTaskFor({} as never, { taskId }, { requestId: randomUUID(), actor: { kind: "session", caller } })).toMatchObject({ nothingRunning: false });
    await reviseTaskWorkflowPlan({} as never, caller, taskId, {});
    expect(calls).toEqual(["decide:tok:PAGE", "close", "retry", "cancel", "cancel", "revise-plan"]);
  });

  it("Rovara's own retry (autofix, the recovery re-entry) never runs Cloud's retry over a core task's rows: it is refused, and the core is not asked", async () => {
    calls.length = 0;
    installCoreTaskRoutes(stub(true));
    const caller = callerOf({ developerId: "d".repeat(64), sessionId: "s", orgId: PEOPLE_ORG, role: "owner", name: "n", amr: "oidc", key: "k" });
    expect(await refusal(retryTaskWorkflow({} as never, caller, taskId, {}, true))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await refusal(retryTaskWorkflow({} as never, caller, taskId, {}, false, { reason: "autofix" } as never))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(calls).toEqual([]);
  });
});

// DEFERRED S3-RETRY-CANCEL-REVISE-WIRING (0.5.19 pin): retry, cancel and revise-plan on a core task are Code's session actions (public #577), over the real rig: Code's real flow, store and dispatch. Code's
// actions check no access of their own, so the route's `authorize` (Cloud's own check) must run first: a refusal there leaves the task exactly as it was.
const META = (taskId: string) => ({ pk: `DEVTASK#${taskId}`, sk: "META" });
const allow = async (): Promise<void> => undefined;
const deny = async (): Promise<void> => { throw agentXError("TASK_NOT_FOUND", NOT_YOURS_WORDS); };

async function blockAtPlan(r: Rig, taskId: string): Promise<number> {
  const row = (await r.world.store.get(META(taskId)))!;
  const workflow = row["workflow"] as Record<string, unknown>;
  await r.world.store.put({ item: { ...row, workflow: { ...workflow, stage: "PLAN", state: "BLOCKED", blockReason: "The planning step stopped." } } });
  return workflow["revision"] as number;
}

async function runningOperation(r: Rig, taskId: string): Promise<{ workspaceId: string; operationId: string }> {
  const row = (await r.world.store.get(META(taskId)))!;
  const workspaceId = row["workspaceId"] as string;
  const operations = (await r.world.store.query({ pk: `WORKSPACE#${workspaceId}` })).items.filter((item) => String(item["sk"]).startsWith("OPERATION#"));
  const operation = operations.at(-1)!;
  await r.world.store.put({ item: { ...operation, status: "RUNNING" } });
  const workspace = (await r.world.store.get({ pk: `WORKSPACE#${workspaceId}`, sk: "META" }))!;
  await r.world.store.put({ item: { ...workspace, activeOperationId: operation["id"] } as never });
  return { workspaceId, operationId: operation["id"] as string };
}
const operationStatus = async (r: Rig, at: { workspaceId: string; operationId: string }) => (await r.world.store.get({ pk: `WORKSPACE#${at.workspaceId}`, sk: `OPERATION#${at.operationId}` }))?.["status"];

for (const switchState of ["on", "off"] as const) {
  describe(`Code's session actions answer a core task's retry, cancel and revise-plan, switch ${switchState}`, () => {
    const setup = async () => {
      const r = await rig();
      const { taskId } = await planned(r);
      const app = switchState === "on" ? r.app : r.rebuild({ env: {}, serveStamped: true });
      return { r, taskId, routes: routesOver(r, app), owner: r.people.people.owner, member: r.people.people.member };
    };
    const retryBody = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), instructions: "Try this step again.", ...extra });

    it("retry: the step the task is blocked at runs again (the core's next revision, no longer blocked)", async () => {
      const { r, routes, taskId, owner } = await setup();
      const before = await blockAtPlan(r, taskId);
      const answer = await routes.retry({ caller: browser(owner), taskId, value: retryBody({ expectedRevision: before }), authorize: allow, view: viewOf(r, taskId) });
      expect(answer.task.taskId).toBe(taskId);
      const after = (await metaOf(r, taskId)).workflow as unknown as { revision: number; state: string; stage: string };
      expect(after.revision).toBeGreaterThan(before);
      expect(after.state).not.toBe("BLOCKED");
    });

    it("retry: a caller Cloud's check refuses gets Cloud's refusal, and the task stays blocked at the same revision", async () => {
      const { r, routes, taskId, member } = await setup();
      const before = await blockAtPlan(r, taskId);
      expect(await refusal(routes.retry({ caller: browser(member), taskId, value: retryBody(), authorize: deny, view: viewOf(r, taskId) }))).toMatchObject({ code: "TASK_NOT_FOUND" });
      expect((await metaOf(r, taskId)).workflow).toMatchObject({ revision: before, state: "BLOCKED" });
    });

    it("retry: a page for an older revision, a task that is not blocked, and a body Cloud does not accept are refused and change nothing", async () => {
      const { r, routes, taskId, owner } = await setup();
      const waiting = (await metaOf(r, taskId)).workflow!.revision;
      expect(await refusal(routes.retry({ caller: browser(owner), taskId, value: retryBody(), authorize: allow, view: viewOf(r, taskId) }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("nothing to retry") as string });
      expect((await metaOf(r, taskId)).workflow!.revision).toBe(waiting);
      const before = await blockAtPlan(r, taskId);
      expect(await refusal(routes.retry({ caller: browser(owner), taskId, value: retryBody({ expectedRevision: before + 5 }), authorize: allow, view: viewOf(r, taskId) }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("changed since you read it") as string });
      expect(await refusal(routes.retry({ caller: browser(owner), taskId, value: { requestId: "no" }, authorize: allow, view: viewOf(r, taskId) }))).toMatchObject({ code: "CONFIG_INVALID" });
      expect((await metaOf(r, taskId)).workflow).toMatchObject({ revision: before, state: "BLOCKED" });
    });

    it("cancel: a running step is stopped; with nothing running the answer says so", async () => {
      const { r, routes, taskId, owner } = await setup();
      expect(await routes.cancel({ caller: browser(owner), taskId, value: { requestId: randomUUID() }, authorize: allow, view: viewOf(r, taskId) })).toMatchObject({ nothingRunning: true });
      const at = await runningOperation(r, taskId);
      expect(await routes.cancel({ caller: browser(owner), taskId, value: { requestId: randomUUID() }, authorize: allow, view: viewOf(r, taskId) })).toMatchObject({ nothingRunning: false });
      expect(await operationStatus(r, at)).toBe("CANCELLED");
    });

    it("cancel: a caller Cloud's check refuses gets Cloud's refusal, and the running step keeps running", async () => {
      const { r, routes, taskId, member } = await setup();
      const at = await runningOperation(r, taskId);
      expect(await refusal(routes.cancel({ caller: browser(member), taskId, value: { requestId: randomUUID() }, authorize: deny, view: viewOf(r, taskId) }))).toMatchObject({ code: "TASK_NOT_FOUND" });
      expect(await operationStatus(r, at)).toBe("RUNNING");
    });

    it("revise-plan: the owner's press reaches Code's own rule (a task that did not stop for a live change is refused in Code's words, and nothing moves)", async () => {
      const { r, routes, taskId, owner } = await setup();
      const before = (await metaOf(r, taskId)).workflow!.revision;
      const row = (await r.world.store.get(META(taskId)))!;
      if (typeof row["sessionId"] !== "string") await r.world.store.put({ item: { ...row, sessionId: `ses_${"b".repeat(20)}` } });
      expect(await refusal(routes.revisePlan({ caller: browser(owner), taskId, value: { requestId: randomUUID(), expectedRevision: before }, authorize: allow, view: viewOf(r, taskId) })))
        .toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("did not stop for a change the plan can take in") as string });
      expect((await metaOf(r, taskId)).workflow!.revision).toBe(before);
    });

    it("revise-plan: Cloud's check runs first, and anyone but the task's effective owner hears 'owners only' (never Code's words about the task's state)", async () => {
      const { r, routes, taskId, owner, member } = await setup();
      const before = (await metaOf(r, taskId)).workflow!.revision;
      const row = (await r.world.store.get(META(taskId)))!;
      if (typeof row["sessionId"] !== "string") await r.world.store.put({ item: { ...row, sessionId: `ses_${"b".repeat(20)}` } });
      const value = { requestId: randomUUID(), expectedRevision: before };
      expect(await refusal(routes.revisePlan({ caller: browser(owner), taskId, value, authorize: deny, view: viewOf(r, taskId) }))).toMatchObject({ code: "TASK_NOT_FOUND" });
      expect(await refusal(routes.revisePlan({ caller: browser(member), taskId, value, authorize: allow, view: viewOf(r, taskId) }))).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining(REVISE_OWNER_ONLY_WORDS) as string });
      expect((await metaOf(r, taskId)).workflow!.revision).toBe(before);
    });

    it("revise-plan: a core task with no agent session had no live message, so it is refused before Code is asked", async () => {
      const { r, routes, taskId, owner } = await setup();
      const row = (await r.world.store.get(META(taskId)))!;
      const { sessionId: _drop, ...noSession } = row as Record<string, unknown>;
      void _drop;
      await r.world.store.put({ item: noSession as never });
      expect(await refusal(routes.revisePlan({ caller: browser(owner), taskId, value: { requestId: randomUUID(), expectedRevision: 1 }, authorize: allow, view: viewOf(r, taskId) }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(REVISE_NO_SESSION_WORDS) as string });
    });
  });
}

describe("the route's authorize is Cloud's own check for each action (Code's session actions check no access)", () => {
  const TASK = "66666666-6666-4666-8666-666666666666";
  const seed = (world: PeopleWorld, options: { archived?: boolean } = {}) => {
    world.db.set({
      ...projectRevisionKey(PEOPLE_ORG, "payments", 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z",
      definition: { name: "payments", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/payments.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." },
    });
    world.db.set({ ...orgProjectCatalogKey(PEOPLE_ORG, "payments"), entityType: "PROJECT_CATALOG", name: "payments", latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
    world.db.set({ ...projectMetaKey(PEOPLE_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: options.archived === true ? "archived" : "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: world.people.owner.developerId, ...(options.archived === true ? { archivedAt: "2026-10-03T00:00:00.000Z", archivedBy: world.people.owner.developerId } : {}) });
    world.db.set({ ...projectMemberKey(PEOPLE_ORG, world.people.member.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: world.people.member.developerId, projectName: "payments", role: "developer" });
    // The task row as the broker's read-only view shows a core task (`companyId` read as `orgId` too), owned by the owner.
    world.db.set({
      pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVTASK", taskId: TASK, orgId: PEOPLE_ORG, companyId: PEOPLE_ORG, project: "payments", developerId: world.people.owner.developerId, developerName: world.people.owner.name, provider: "oidc",
      ownerKey: taskOwnerKey(world.people.owner.developerId, TASK), workspaceId: "77777777-7777-4777-8777-777777777777", status: "RUNNING", createdAt: "2026-11-12T10:00:00.000Z",
    });
  };
  const authorizedBy = (done: string[]): CoreTaskRoutes => ({
    owns: async () => true,
    decide: async () => { throw new Error("unused"); },
    close: async () => { throw new Error("unused"); },
    retry: async (input) => { await input.authorize(); done.push("retry"); return { task: {} as never }; },
    cancel: async (input) => { await input.authorize(); done.push("cancel"); return { task: {} as never, nothingRunning: true }; },
    revisePlan: async (input) => { await input.authorize(); done.push("revise-plan"); return { task: {} as never }; },
  });
  const act = async (world: PeopleWorld, who: Person) => {
    const caller = callerOf(who);
    const deps = developerTaskRouteDependencies(world.routes, caller);
    const results: Record<string, string> = {};
    for (const [name, run] of [
      ["retry", () => retryTaskWorkflow(deps, caller, TASK, {})],
      ["cancel", () => cancelTask(deps, caller, TASK, {})],
      ["revise-plan", () => reviseTaskWorkflowPlan(deps, caller, TASK, {})],
    ] as const) {
      const error = await refusal(run());
      results[name] = error === undefined ? "done" : (error as { code?: string }).code ?? "error";
    }
    return results;
  };

  it("the task's owner passes Cloud's check for retry, cancel and revise-plan, and the core acts", async () => {
    const world = createPeopleWorld();
    seed(world);
    const done: string[] = [];
    installCoreTaskRoutes(authorizedBy(done));
    expect(await act(world, world.people.owner)).toEqual({ retry: "done", cancel: "done", "revise-plan": "done" });
    expect(done).toEqual(["retry", "cancel", "revise-plan"]);
  });

  it("a member who does not own the task, the Auditor, a revoked person and a stranger are refused each, and the core does nothing", async () => {
    const world = createPeopleWorld();
    seed(world);
    const done: string[] = [];
    installCoreTaskRoutes(authorizedBy(done));
    for (const who of [world.people.member, world.people.auditor, world.people.revoked, world.people.stranger]) {
      const results = await act(world, who);
      for (const [action, outcome] of Object.entries(results)) expect(outcome, `${who.key} ${action}`).not.toBe("done");
    }
    expect(done).toEqual([]);
  });

  it("an archived project refuses a retry and a revise (both start work again), as Cloud's own do; a stop still stops", async () => {
    const world = createPeopleWorld();
    seed(world, { archived: true });
    const done: string[] = [];
    installCoreTaskRoutes(authorizedBy(done));
    expect(await act(world, world.people.owner)).toEqual({ retry: "PROJECT_ARCHIVED", cancel: "done", "revise-plan": "PROJECT_ARCHIVED" });
    expect(done).toEqual(["cancel"]);
  });
});

// DEFERRED S3-RETRY-CANCEL-REVISE-WIRING, review round 1: the route's `authorize` is Cloud's own check for each action. These tests run the real functions (`retryTaskWorkflow`, `cancelTask`,
// `reviseTaskWorkflowPlan`) over the people world with the task's People list, a share, project roles and a closed task, and a hook that records only that the core was reached. Each case fails when the check
// it pins is weakened (the review's mutants R1, R2, V1, V2, C1, C2, T3, T4).
describe("who may retry, stop and revise a core task: Cloud's access rule for the action, not 'can read' (review round 1)", () => {
  const TASK = "99999999-9999-4999-8999-999999999999";
  type Key = keyof PeopleWorld["people"];
  type Listed = Partial<Record<Key, "owner" | "commenter" | "viewer">>;
  interface Setup { creator: Key; listed?: Listed; /** A project grant: `developer` is a contributor, `viewer` a viewer, none is no grant at all. */ grants?: Partial<Record<Key, "developer" | "viewer">>; closed?: boolean; takenOverBy?: Key }

  const build = (setup: Setup) => {
    const world = createPeopleWorld();
    const { people } = world;
    world.db.set({
      ...projectRevisionKey(PEOPLE_ORG, "payments", 1), entityType: "PROJECT", registeredBy: "seed", registeredAt: "2026-10-01T00:00:00.000Z",
      definition: { name: "payments", revision: 1, repositories: [{ name: "web", url: "https://github.com/acme/payments.git", path: "repo/web", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." },
    });
    world.db.set({ ...orgProjectCatalogKey(PEOPLE_ORG, "payments"), entityType: "PROJECT_CATALOG", name: "payments", latestRevision: 1, firstRegisteredAt: "2026-10-01T00:00:00.000Z" });
    world.db.set({ ...projectMetaKey(PEOPLE_ORG, "payments"), entityType: "PROJECT_META", name: "payments", status: "active", createdAt: "2026-10-02T00:00:00.000Z", createdBy: people.owner.developerId });
    for (const [key, role] of Object.entries(setup.grants ?? {}) as Array<[Key, "developer" | "viewer"]>) {
      world.db.set({ ...projectMemberKey(PEOPLE_ORG, people[key].developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: people[key].developerId, projectName: "payments", role });
    }
    const creator = people[setup.creator];
    const taker = setup.takenOverBy === undefined ? undefined : people[setup.takenOverBy];
    world.db.set({
      pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK, orgId: PEOPLE_ORG, companyId: PEOPLE_ORG, project: "payments", developerId: creator.developerId, developerName: creator.name, provider: "oidc",
      ownerKey: taskOwnerKey(creator.developerId, TASK), workspaceId: "77777777-7777-4777-8777-777777777777", status: "RUNNING", createdAt: "2026-11-12T10:00:00.000Z",
      ...(setup.listed === undefined ? {} : { share: { teamId: "T0PEOPLE1", channelId: "C0CHAN", threadTs: "1.1" } }),
      ...(setup.closed === true ? { closedAt: "2026-11-12T11:00:00.000Z" } : {}),
      ...(taker === undefined ? {} : { currentOwner: { developerId: taker.developerId, name: taker.name, provider: "oidc", since: "2026-11-12T10:30:00.000Z" } }),
    });
    if (setup.listed !== undefined) {
      world.db.set({
        pk: `DEVTASK#${TASK}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false,
        people: Object.entries(setup.listed).map(([key, role]) => ({ developerId: people[key as Key].developerId, name: people[key as Key].name, role })),
      });
    }
    const grants = setup.grants ?? {};
    // The identity check the People list asks (Slack and the directory are not under test): everyone listed is an eligible member of the task's channel; a project viewer is marked as one.
    const checkTaskPerson = async (_task: unknown, developerId: string) => {
      const who = Object.values(people).find((person) => person.developerId === developerId)!;
      return { subject: { developerId }, identity: { developerId, name: who.name, method: "oidc", issuer: "https://oidc.example.test", subject: `${who.key}-subject` }, eligible: true, channelMember: true,
        ...((grants as Record<string, string | undefined>)[who.key] === "viewer" ? { projectViewer: true as const } : {}) } as never;
    };
    const depsFor = (who: Person) => ({ ...developerTaskRouteDependencies(world.routes, callerOf(who)), checkTaskPerson });
    return { world, depsFor, people };
  };

  /** The core's hook with the real revise route (the owner rule is the route's own) and a recorder for the rest: it says only that the route reached the core. */
  const hook = (world: PeopleWorld, done: string[]): CoreTaskRoutes => {
    const real = createCoreTaskRoutes({ app: {} as never, log: () => undefined, read: async (key) => world.db.get(key), principalOf: async () => { throw new Error("unused"); } });
    return {
      owns: async () => true,
      decide: async () => { throw new Error("unused"); },
      close: async () => { throw new Error("unused"); },
      retry: async (input) => { await input.authorize(); done.push("retry"); return { task: {} as never }; },
      cancel: async (input) => { await input.authorize(); done.push("cancel"); return { task: {} as never, nothingRunning: true }; },
      // The real owner rule after Cloud's check; a person who passes both reaches the (absent) session and is told so before Code is asked.
      revisePlan: async (input) => { const answer = await real.revisePlan(input); done.push("revise-plan"); return answer; },
    };
  };

  type Outcome = "done" | { code?: string | undefined; message: string };
  const press = async (setup: ReturnType<typeof build>, who: Person): Promise<Record<"retry" | "cancel" | "revise-plan", Outcome>> => {
    const caller = callerOf(who);
    const deps = setup.depsFor(who);
    const outcome = async (run: () => Promise<unknown>): Promise<Outcome> => {
      const error = await refusal(run());
      return error === undefined ? "done" : { code: (error as { code?: string }).code, message: error.message };
    };
    return {
      retry: await outcome(() => retryTaskWorkflow(deps, caller, TASK, {})),
      cancel: await outcome(() => cancelTask(deps, caller, TASK, {})),
      "revise-plan": await outcome(() => reviseTaskWorkflowPlan(deps, caller, TASK, {})),
    };
  };
  // Where a person who passed Cloud's check ends in the revise route: the owner rule passed and the task has no session, so the route says so (it never calls Code).
  const REACHED_CORE = { code: "CONFIG_INVALID" };

  it("R2/V2: a company admin or owner who is not the task's owner, and a shared person with a developer project role, are each refused retry and revise; a commenter is refused stop too", async () => {
    for (const setup of [
      // The task is the member's; the company owner and the admin are listed as commenters (they can read it).
      build({ creator: "member", listed: { member: "owner", owner: "commenter", maintainer: "commenter" }, grants: { member: "developer" } }),
      // The task is the owner's; the admin and a member with a developer grant (a shared person) are commenters.
      build({ creator: "owner", listed: { owner: "owner", maintainer: "commenter", member: "commenter" }, grants: { member: "developer" } }),
    ]) {
      const done: string[] = [];
      installCoreTaskRoutes(hook(setup.world, done));
      const { owner, maintainer, member } = setup.people;
      const creatorId = (setup.world.db.get({ pk: `DEVTASK#${TASK}`, sk: "META" }) as { developerId: string }).developerId;
      const bystanders = [owner, maintainer, member].filter((who) => who.developerId !== creatorId);
      expect(bystanders).toHaveLength(2);
      for (const who of bystanders) {
        const outcomes = await press(setup, who);
        expect(outcomes.retry, `${who.key} retry`).toMatchObject({ code: "TASK_NOT_FOUND" });
        expect(outcomes["revise-plan"], `${who.key} revise`).toMatchObject({ code: "TASK_NOT_FOUND" });
        expect(outcomes.cancel, `${who.key} stop`).toMatchObject({ code: "TASK_NOT_FOUND" });
      }
      expect(done).toEqual([]);
    }
  });

  it("C1: a viewer who can see the task, and a commenter, are refused stop (it is the owner's action, not a read)", async () => {
    const setup = build({ creator: "owner", listed: { owner: "owner", member: "viewer", maintainer: "commenter" }, grants: { member: "developer" } });
    const done: string[] = [];
    installCoreTaskRoutes(hook(setup.world, done));
    for (const who of [setup.people.member, setup.people.maintainer]) expect((await press(setup, who)).cancel, who.key).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(done).toEqual([]);
    // The owner's own stop passes the same check.
    expect((await press(setup, setup.people.owner)).cancel).toBe("done");
    expect(done).toContain("cancel");
  });

  it("R1/V1: an owner (the creator, or a co-owner on the People list) who holds no project access, or only a viewer's, cannot send the task back to coding by retry or revise", async () => {
    for (const setup of [
      build({ creator: "member" }),
      build({ creator: "member", grants: { member: "viewer" } }),
      build({ creator: "owner", listed: { owner: "owner", member: "owner" } }),
      build({ creator: "owner", listed: { owner: "owner", member: "owner" }, grants: { member: "viewer" } }),
    ]) {
      const done: string[] = [];
      installCoreTaskRoutes(hook(setup.world, done));
      const outcomes = await press(setup, setup.people.member);
      expect(outcomes.retry, "retry").toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
      expect(outcomes["revise-plan"], "revise").toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
      expect(done).not.toContain("retry");
      expect(done).not.toContain("revise-plan");
    }
    // The same owner with a contributor's grant passes both, and a company admin who owns the task needs no grant.
    const allowed = build({ creator: "member", grants: { member: "developer" } });
    installCoreTaskRoutes(hook(allowed.world, []));
    const outcomes = await press(allowed, allowed.people.member);
    expect(outcomes.retry).toBe("done");
    expect(outcomes["revise-plan"]).toMatchObject({ ...REACHED_CORE, message: expect.stringContaining(REVISE_NO_SESSION_WORDS) as string });
    const admin = build({ creator: "maintainer" });
    installCoreTaskRoutes(hook(admin.world, []));
    expect((await press(admin, admin.people.maintainer)).retry).toBe("done");
  });

  it("C2: a closed task is refused a stop in Cloud's own words (and a retry and a revise as no task), and the core does nothing", async () => {
    const setup = build({ creator: "owner", closed: true });
    const done: string[] = [];
    installCoreTaskRoutes(hook(setup.world, done));
    const outcomes = await press(setup, setup.people.owner);
    expect(outcomes.cancel).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining("this task is closed") as string });
    expect(outcomes.retry).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(outcomes["revise-plan"]).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(done).toEqual([]);
  });

  it("T3: a stranger, a person with no access and someone of another company hear 'no task' from revise, never 'owners only' (which would confirm the task exists)", async () => {
    const setup = build({ creator: "owner", grants: { owner: "developer" } });
    const done: string[] = [];
    installCoreTaskRoutes(hook(setup.world, done));
    for (const who of [setup.people.stranger, setup.people.auditor, setup.people.member]) {
      const outcome = (await press(setup, who))["revise-plan"];
      expect(outcome, who.key).toMatchObject({ code: "TASK_NOT_FOUND" });
      expect(JSON.stringify(outcome), who.key).not.toContain(REVISE_OWNER_ONLY_WORDS);
    }
    expect(done).toEqual([]);
  });

  it("T3/T4: the route's own order and owner (over the real route): Cloud's refusal is first even for a non-owner, and the owner is the task's EFFECTIVE owner (the taker after a take-over, never the creator)", async () => {
    const setup = build({ creator: "owner", takenOverBy: "member" });
    const real = createCoreTaskRoutes({ app: {} as never, log: () => undefined, read: async (key) => setup.world.db.get(key), principalOf: async () => { throw new Error("unused"); } });
    const value = { requestId: randomUUID(), expectedRevision: 1 };
    const view = async () => ({}) as never;
    // Cloud's check first: a person it refuses hears its words whoever owns the task.
    expect(await refusal(real.revisePlan({ caller: browser(setup.people.maintainer), taskId: TASK, value, authorize: deny, view }))).toMatchObject({ code: "TASK_NOT_FOUND" });
    // After the take-over the creator is not the owner any more ("owners only"), and the taker is (so the route goes on to the session, which this task has none of).
    expect(await refusal(real.revisePlan({ caller: browser(setup.people.owner), taskId: TASK, value, authorize: allow, view }))).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining(REVISE_OWNER_ONLY_WORDS) as string });
    expect(await refusal(real.revisePlan({ caller: browser(setup.people.member), taskId: TASK, value, authorize: allow, view }))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(REVISE_NO_SESSION_WORDS) as string });
  });
});
