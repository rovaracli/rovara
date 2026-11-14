// S3 item 7 (rest): Cloud's decide and close for a task the core runs, answered by the core by the task's STAMP, with the switch on or off, and a Cloud task left alone. The core's answers go through the real
// A6 adapters and Code's real gate and flow (the shared rig). The seam in `routeDeveloperTaskRequest` and the three function gates are tested with a stub hook, so a Cloud task provably never reaches it.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { AgentXError } from "@rovara-code/contracts";
import type { DeveloperTaskView } from "@agentx/cloud-contracts";
import { createCloudIdentityProvider } from "../../packages/broker/src/cloud/adapters/people/index.js";
import {
  ENGINE_UNAVAILABLE_WORDS, NOT_YOURS_WORDS, NO_CREDENTIAL_WORDS, WORKFLOW_DOCUMENT_KIND, SKIP_REFUSED_WORDS,
  coreDecisionRefusal, createCoreTaskRoutes,
} from "../../packages/broker/src/cloud/app/index.js";
import { CLOSE_REFUSED } from "../../packages/broker/src/aws/developer-tasks/close.js";
import { CORE_ACTION_WORDS, CORE_CANCEL_NOT_AVAILABLE_WORDS, CORE_NOT_AVAILABLE_PREFIX, CORE_TASK_ANSWERED_ACTIONS, coreActionWords, CORE_TASK_CLOUD_ACTIONS, installCoreTaskRoutes, type CoreTaskRoutes } from "../../packages/broker/src/rovara-code/task-routes.js";
import { routeDeveloperTaskRequest } from "../../packages/broker/src/aws/developer-tasks.js";
import { decideTaskWorkflow } from "../../packages/broker/src/aws/developer-tasks/decide.js";
import { closeTask } from "../../packages/broker/src/aws/developer-tasks/close.js";
import { cancelTask } from "../../packages/broker/src/aws/developer-tasks/cancel.js";
import { PEOPLE_ORG, type Person } from "../support/cloud-people-world.js";
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
        const error = await refusal(routes.decide({ caller, taskId, value: body(), bearer: r.people.tokenOf(owner).length > 0 && caller.scriptToken !== undefined ? r.people.tokenOf(owner) : undefined, view: viewOf(r, taskId) }));
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
      const refusing = async (...args: unknown[]) => { void args; throw new AgentXError("TASK_NOT_FOUND", "no such task"); };
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
  const REFUSED = ["workflow/send-back", "continue", "workflow/review-findings", "workflow/review", "pull-requests", "workflow/keep-pull-requests", "workflow/publish-retry", "workflow/feedback-decision", "workflow/feedback-retry", "canvas-closeout/retry", "e2e-publication-context", "workflow/retry", "workflow/revise-plan", "cancel"];

  it("each refused action has its own sentence, in the same plain first words, and says what to do instead", () => {
    expect(Object.keys(CORE_ACTION_WORDS).sort()).toEqual([...REFUSED].sort());
    for (const action of REFUSED) {
      const words = coreActionWords(action);
      expect(words, action).toMatch(new RegExp(`^${CORE_NOT_AVAILABLE_PREFIX.replace(/\./gu, "\\.")} `, "u"));
      expect(words, action).not.toMatch(/CONFIG_INVALID|error|failed|route not found|not found/iu);
      expect(words.length, action).toBeGreaterThan(CORE_NOT_AVAILABLE_PREFIX.length + 20);
    }
    // The actions that mean "change the work" tell the person to close this task and start a new one with the extra instructions.
    for (const action of ["workflow/send-back", "continue", "workflow/review-findings", "workflow/revise-plan", "workflow/feedback-decision", "workflow/feedback-retry"]) expect(coreActionWords(action), action).toContain("close this task and start a new one");
    expect(coreActionWords("workflow/send-back")).toBe("Not available on this task yet. To make more changes, close this task and start a new one with the extra instructions.");
    expect(CORE_CANCEL_NOT_AVAILABLE_WORDS).toBe("Not available on this task yet. To stop the task, close it.");
  });

  it("the sentences differ where the advice differs (a kept pull request, a canvas or E2E check, a review are not told to start again)", () => {
    expect(new Set(REFUSED.map((action) => coreActionWords(action))).size).toBeGreaterThan(9);
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
  });
  const taskId = randomUUID();
  const request = (path: string, headers: Record<string, string> = {}, body: unknown = {}) => ({ method: "POST", path: `/v1/dev/tasks/${taskId}/${path}`, headers, requestId: randomUUID(), body: JSON.stringify(body) });
  const route = (path: string, headers?: Record<string, string>) => routeDeveloperTaskRequest({} as never, callerOf({ developerId: "d".repeat(64), sessionId: "s", orgId: PEOPLE_ORG, role: "owner", name: "n", amr: "oidc", key: "k" }), request(path, headers), new URL(`https://x.test/v1/dev/tasks/${taskId}/${path}`));

  it("a core task: decide gets the request's bearer, close goes to the core, cancel and every Cloud workflow action are refused in words", async () => {
    calls.length = 0;
    installCoreTaskRoutes(stub(true));
    await route("workflow/decision", { authorization: "Bearer abc.def" });
    await route("close");
    expect(calls).toEqual(["decide:abc.def:none", "close"]);
    expect(await refusal(route("cancel"))).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(CORE_CANCEL_NOT_AVAILABLE_WORDS) as string });
    for (const action of ["workflow/retry", "workflow/send-back", "workflow/revise-plan", "workflow/review", "workflow/publish-retry", "workflow/keep-pull-requests", "workflow/review-findings", "workflow/feedback-decision", "workflow/feedback-retry", "canvas-closeout/retry", "pull-requests", "continue", "e2e-publication-context"]) {
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
    expect([...CORE_TASK_ANSWERED_ACTIONS].sort()).toEqual(["close", "workflow/decision"]);
  });

  it("a Cloud task (the hook says it is not the core's), and no hook at all: the hook is never asked to decide, close or refuse", async () => {
    for (const hook of [stub(false), undefined]) {
      calls.length = 0;
      installCoreTaskRoutes(hook);
      for (const action of ["workflow/decision", "close", "cancel", "workflow/retry"]) {
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

  it("the function gates cover every other caller of decide, close and cancel (the task page, a card, a session's stop)", async () => {
    calls.length = 0;
    installCoreTaskRoutes(stub(true));
    const caller = callerOf({ developerId: "d".repeat(64), sessionId: "s", orgId: PEOPLE_ORG, role: "owner", name: "n", amr: "oidc", key: "k" }, { browserSession: true });
    await decideTaskWorkflow({ coreBearer: "tok" } as never, caller, taskId, {}, { via: "PAGE" });
    await closeTask({} as never, caller, taskId, {});
    expect(calls).toEqual(["decide:tok:PAGE", "close"]);
    expect(await refusal(cancelTask({} as never, caller, taskId, {}))).toMatchObject({ code: "CONFIG_INVALID" });
  });
});
