import { fixtureActor } from "../support/money-authority.js";
// Plan 4 Task 18: the trigger routes. A chain's and an agent's triggers, a project's switch for the triggers the built-in agents suggest, turning one on only through a person on
// the confirmation page, the checks a trigger must pass, and what archiving does. Each test starts its own world.
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "../../packages/contracts/src/agent-templates.js";
import { BUILTIN_AGENT_IDS } from "../../packages/contracts/src/agent.js";
import { TriggerSpecSchema } from "../../packages/contracts/src/agent-recipe.js";
import { MAX_TRIGGERS_PER_TARGET } from "../../packages/contracts/src/trigger-specs.js";
import { triggerKey, targetTriggersKey, triggerMatchKey, triggerTargetKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { builtinTriggerIdFor } from "../../packages/broker/src/triggers/routes.js";
import { DANA, HOOK_A, HOOK_A2, HOOK_B, MAX, ORG_A, ORG_B, PRIYA, CARL, VIV, ARJUN, disposeGateWorlds, rid, setupTriggerWorld, type TriggerWorld } from "../support/trigger-world.js";

afterEach(disposeGateWorlds);

const ID = (letter: string) => `ctr_${letter.repeat(20)}`;
const PR_OPENED = { kind: "event", source: "github", type: "pull_request.opened" };
const BY_HOOK = { kind: "event", source: "sentry", type: "issue.created" };
const SCHEDULE = (schedule: unknown, extra: Record<string, unknown> = {}) => ({ kind: "schedule", schedule, timezone: "Europe/Berlin", ...extra });

/** A chain a trigger may be put on, and the path of its triggers. */
async function chainWorld() {
  const v = setupTriggerWorld();
  const chain = await v.budgetedChain();
  return { v, chain, path: (triggerId = "") => `/v1/app/chains/${chain.chainId}/triggers${triggerId === "" ? "" : `/${triggerId}`}` };
}

/** Confirms `approvalId` on the page as `who`, with a fresh sign-in. */
const confirm = async (v: TriggerWorld, who: string, confirmUrl: string) => v.decideAs(who, confirmUrl.split("/").pop()!.split("?")[0]!);
const confirmUrlOf = (called: { body: Record<string, unknown> }) => String(called.body["confirmUrl"]);
const stored = async (v: TriggerWorld, triggerId: string) => (await v.triggers.get(ORG_A, triggerId))!;

describe("turning a trigger on needs a person", () => {
  it("answers 202 with the confirmation link for a new enabled trigger, stores it off, and turns on exactly that spec when a maintainer confirms on the page", async () => {
    const { v, chain, path } = await chainWorld();
    const put = await v.chainCall(PRIYA, "PUT", path(ID("a")), { project: "web", spec: PR_OPENED });
    // Priya manages her own chain but is only a contributor of web: this is refused, not asked about.
    expect(put).toMatchObject({ status: 403 });
    const asked = await v.chainCall(DANA, "PUT", path(ID("a")), { project: "web", spec: PR_OPENED });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ status: "NEEDS_CONFIRMATION", changes: ["turn on github pull request opened for web"] });
    expect(confirmUrlOf(asked)).toMatch(/^https:\/\/cell\.example\.com\/v1\/app\/approve\/apr_[0-9a-z]{20}$/);
    const before = await stored(v, ID("a"));
    expect(before).toMatchObject({ enabled: false, createdBy: DANA, target: { kind: "chain", chainId: chain.chainId } });
    expect(before.disabledReason).toBeDefined();
    const decided = await confirm(v, DANA, confirmUrlOf(asked));
    expect(decided.statusCode).toBe(200);
    const after = await stored(v, ID("a"));
    expect(after).toMatchObject({ enabled: true, spec: { kind: "event", source: "github", type: "pull_request.opened" } });
    expect(after.disabledReason).toBeUndefined();
  });

  it("refuses a CLI or MCP token's confirmation and turns nothing on", async () => {
    const { v, path } = await chainWorld();
    const asked = await v.chainCall(DANA, "PUT", path(ID("a")), { project: "web", spec: PR_OPENED });
    const approvalId = confirmUrlOf(asked).split("/").pop()!;
    const refused = await v.tokenDecide(DANA, approvalId, "Bearer dana").then(() => "went through", (error: { code?: string }) => error.code);
    expect(refused).toBe("REAUTH_REQUIRED");
    expect((await stored(v, ID("a"))).enabled).toBe(false);
  });

  it("applies a trigger that is stored off, and a turn-off, at once; and asks again for a re-enable", async () => {
    const { v, path } = await chainWorld();
    const off = await v.chainCall(DANA, "PUT", path(ID("a")), { project: "web", spec: PR_OPENED, enabled: false });
    expect(off.status).toBe(201);
    expect(await stored(v, ID("a"))).toMatchObject({ enabled: false, createdBy: DANA });
    const again = await v.chainCall(DANA, "PUT", path(ID("a")), { project: "web", spec: PR_OPENED, enabled: true });
    expect(again.status).toBe(202);
    expect((await stored(v, ID("a"))).enabled).toBe(false);
    await confirm(v, DANA, confirmUrlOf(again));
    expect((await stored(v, ID("a"))).enabled).toBe(true);
    const turnedOff = await v.chainCall(DANA, "PUT", path(ID("a")), { project: "web", spec: PR_OPENED, enabled: false });
    expect(turnedOff.status).toBe(200);
    expect((await stored(v, ID("a"))).enabled).toBe(false);
  });

  async function enabledPr(v: TriggerWorld, chainId: string) {
    return v.seed({ target: { kind: "chain", chainId }, createdBy: DANA, spec: TriggerSpecSchema.parse({ ...PR_OPENED, filter: { label: ["bug", "p1"] } }) as never });
  }

  it("applies a narrower filter at once, and asks again for a wider one or a higher rate", async () => {
    const { v, chain, path } = await chainWorld();
    const trigger = await enabledPr(v, chain.chainId);
    const narrower = await v.chainCall(DANA, "PUT", path(trigger.triggerId), { project: "web", spec: { ...PR_OPENED, filter: { label: ["bug"] } } });
    expect(narrower.status, JSON.stringify(narrower.body)).toBe(200);
    expect((await stored(v, trigger.triggerId)).enabled).toBe(true);
    const lower = await v.chainCall(DANA, "PUT", path(trigger.triggerId), { project: "web", spec: { ...PR_OPENED, filter: { label: ["bug"] } }, maxRunsPerHour: 10 });
    expect(lower.status).toBe(200);
    const wider = await v.chainCall(DANA, "PUT", path(trigger.triggerId), { project: "web", spec: { ...PR_OPENED, filter: { label: ["bug", "p2"] } } });
    expect(wider.status).toBe(202);
    expect(await stored(v, trigger.triggerId)).toMatchObject({ enabled: false, spec: { filter: { label: ["bug", "p2"] } } });
  });

  it("asks again for a higher rate", async () => {
    const { v, chain, path } = await chainWorld();
    const trigger = await enabledPr(v, chain.chainId);
    const raised = await v.chainCall(DANA, "PUT", path(trigger.triggerId), { project: "web", spec: trigger.spec, maxRunsPerHour: 31 });
    expect(raised.status).toBe(202);
    expect((await stored(v, trigger.triggerId)).enabled).toBe(false);
  });

  it("treats a change of type, source, hook, project or target of an enabled trigger as a new turn-on", async () => {
    const { v, chain, path } = await chainWorld();
    v.connection("linear");
    v.hook("sentry", HOOK_A);
    v.hook("sentry", HOOK_A2);
    v.hook("linear", HOOK_B);
    const other = await v.budgetedChain(undefined, {});
    // The chain runs as its member owner, who must be able to start tasks on the project a trigger is moved to.
    v.projectMembers.grant(ORG_A, "api", PRIYA, "contributor");
    const changes: Array<[string, Record<string, unknown>, string?]> = [
      ["type", { project: "web", spec: { ...PR_OPENED, type: "issues.opened" } }],
      ["source", { project: "web", spec: { kind: "event", source: "linear", type: "issue.created" }, hookId: HOOK_B }],
      ["project", { project: "api", spec: PR_OPENED }],
      ["target", { project: "web", spec: PR_OPENED }, `/v1/app/chains/${other.chainId}/triggers`],
    ];
    for (const [label, body, targetPath] of changes) {
      const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
      const called = await v.chainCall(DANA, "PUT", `${targetPath ?? `/v1/app/chains/${chain.chainId}/triggers`}/${trigger.triggerId}`, body);
      expect(called.status, `${label}: ${JSON.stringify(called.body)}`).toBe(202);
      const after = await stored(v, trigger.triggerId);
      expect(after.enabled, label).toBe(false);
    }
    const hooked = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA, spec: TriggerSpecSchema.parse(BY_HOOK) as never, hookId: HOOK_A });
    const moved = await v.chainCall(DANA, "PUT", path(hooked.triggerId), { project: "web", spec: BY_HOOK, hookId: HOOK_A2 });
    expect(moved.status).toBe(202);
    expect(await stored(v, hooked.triggerId)).toMatchObject({ enabled: false, hookId: HOOK_A2 });
    void ORG_B;
  });

  it("asks for a schedule that fires more often, and for a missed run that is no longer skipped, and applies a less frequent one at once", async () => {
    const { v, chain, path } = await chainWorld();
    const make = async (schedule: unknown, missed: "skip" | "run_once" = "run_once") => v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA, spec: TriggerSpecSchema.parse(SCHEDULE(schedule, { missed })) as never, scheduleStatus: "ok" });
    const put = (triggerId: string, schedule: unknown, missed: "skip" | "run_once" = "run_once") => v.chainCall(DANA, "PUT", path(triggerId), { project: "web", spec: SCHEDULE(schedule, { missed }) });
    expect((await put((await make({ kind: "weekly", at: "09:00", day: "MON" })).triggerId, { kind: "daily", at: "09:00" })).status).toBe(202);
    expect((await put((await make({ kind: "interval", minutes: 60 })).triggerId, { kind: "interval", minutes: 15 })).status).toBe(202);
    expect((await put((await make({ kind: "daily", at: "09:00", days: ["MON"] })).triggerId, { kind: "daily", at: "09:00", days: ["MON", "THU"] })).status).toBe(202);
    expect((await put((await make({ kind: "daily", at: "09:00" }, "skip")).triggerId, { kind: "daily", at: "09:00" }, "run_once")).status).toBe(202);
    const slower = await make({ kind: "interval", minutes: 15 });
    expect((await put(slower.triggerId, { kind: "interval", minutes: 60 })).status).toBe(200);
    expect(await stored(v, slower.triggerId)).toMatchObject({ enabled: true, spec: { schedule: { minutes: 60 } } });
  });

  it("starts a schedule only when a person confirms it, and sets it DISABLED when it is turned off", async () => {
    const { v, path } = await chainWorld();
    const asked = await v.chainCall(DANA, "PUT", path(ID("s")), { project: "web", spec: SCHEDULE({ kind: "interval", minutes: 60 }) });
    expect(asked.status).toBe(202);
    expect(v.scheduler.calls).toEqual([]);
    expect(await stored(v, ID("s"))).toMatchObject({ enabled: false, scheduleStatus: "pending" });
    await confirm(v, DANA, confirmUrlOf(asked));
    expect(v.scheduler.states.get(ID("s"))).toBe("ENABLED");
    expect(await stored(v, ID("s"))).toMatchObject({ enabled: true, scheduleStatus: "ok" });
    const off = await v.chainCall(DANA, "PUT", path(ID("s")), { project: "web", spec: SCHEDULE({ kind: "interval", minutes: 60 }), enabled: false });
    expect(off.status).toBe(200);
    expect(v.scheduler.states.get(ID("s"))).toBe("DISABLED");
  });

  it("leaves a schedule pending when the scheduler can't be reached, for the scheduler's own repair", async () => {
    const { v, path } = await chainWorld();
    const asked = await v.chainCall(DANA, "PUT", path(ID("s")), { project: "web", spec: SCHEDULE({ kind: "interval", minutes: 60 }) });
    v.scheduler.failNext = new Error("throttled");
    await confirm(v, DANA, confirmUrlOf(asked));
    expect(await stored(v, ID("s"))).toMatchObject({ enabled: true, scheduleStatus: "pending" });
  });

  it("refuses to turn on a spec that was edited after it was asked, and turns on nothing", async () => {
    const { v, path } = await chainWorld();
    const asked = await v.chainCall(DANA, "PUT", path(ID("a")), { project: "web", spec: PR_OPENED });
    // Edited in the store, so that nothing closes the request: the digest it was bound to is what refuses it.
    await v.triggers.update({ trigger: await stored(v, ID("a")), patch: { spec: TriggerSpecSchema.parse({ ...PR_OPENED, filter: { label: ["bug"] } }) as never } });
    const decided = await confirm(v, DANA, confirmUrlOf(asked));
    const approvalId = confirmUrlOf(asked).split("/").pop()!;
    expect((await v.approval(approvalId)).status).toBe("APPROVED_FAILED");
    expect(JSON.stringify(decided.body)).toContain("did not go through");
    expect((await stored(v, ID("a"))).enabled).toBe(false);
  });

  it("closes the request when the route edits the spec after it was asked, so the confirmation page says it is closed (review I-3)", async () => {
    const { v, path } = await chainWorld();
    const asked = await v.chainCall(DANA, "PUT", path(ID("a")), { project: "web", spec: PR_OPENED });
    await v.chainCall(DANA, "PUT", path(ID("a")), { project: "web", spec: { ...PR_OPENED, filter: { label: ["bug"] } }, enabled: false });
    const approvalId = confirmUrlOf(asked).split("/").pop()!;
    expect((await v.approval(approvalId)).status).toBe("EXPIRED");
    await confirm(v, DANA, confirmUrlOf(asked));
    expect((await stored(v, ID("a"))).enabled).toBe(false);
  });

  it("lets the one who asks have the runs: another person confirming does not become the creator", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain(undefined, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX } });
    const path = `/v1/app/chains/${chain.chainId}/triggers/${ID("a")}`;
    const asked = await v.chainCall(MAX, "PUT", path, { project: "web", spec: PR_OPENED });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    // A contributor can't confirm it; an org admin can.
    expect((await confirm(v, PRIYA, confirmUrlOf(asked))).statusCode).toBe(403);
    expect((await stored(v, ID("a"))).enabled).toBe(false);
    await confirm(v, DANA, confirmUrlOf(asked));
    expect(await stored(v, ID("a"))).toMatchObject({ enabled: true, createdBy: MAX });
    expect((await v.triggers.listByCreator(ORG_A, MAX)).map((t) => t.triggerId)).toEqual([ID("a")]);
    expect(await v.triggers.listByCreator(ORG_A, DANA)).toEqual([]);
  });

  it("answers a repeat of the same request with the same confirmation, and writes nothing new", async () => {
    const { v, chain } = await chainWorld();
    const body = { requestId: rid(), project: "web", spec: PR_OPENED };
    const path = `/v1/app/chains/${chain.chainId}/triggers/${ID("a")}`;
    const first = await v.chainCall(DANA, "PUT", path, body);
    const second = await v.chainCall(DANA, "PUT", path, body);
    expect(second.status).toBe(202);
    expect(second.body["confirmUrl"]).toBe(first.body["confirmUrl"]);
    expect((await v.triggers.listForTarget(ORG_A, { kind: "chain", chainId: chain.chainId })).length).toBe(1);
    const different = await v.chainCall(DANA, "PUT", path, { ...body, project: "api" });
    expect(different).toMatchObject({ status: 400 });
  });
});

describe("what a trigger on a chain needs", () => {
  it("gives CHAIN_BUDGET_REQUIRED for a chain with no run limit or budget, and the approvers' words for a gate only the starter can approve", async () => {
    const v = setupTriggerWorld();
    const noBudget = await v.publish({ ...{ start: "look", steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "end" } }] } });
    const refused = await v.chainCall(DANA, "PUT", `/v1/app/chains/${noBudget.chainId}/triggers/${ID("a")}`, { project: "web", spec: PR_OPENED });
    expect(refused).toMatchObject({ status: 409, body: { code: "CHAIN_BUDGET_REQUIRED", message: `${noBudget.name} has no monthly budget and run limit, so events and schedules can't start it. Ask its owner to set both.` } });
    const starterOnly = await v.budgetedChain({
      start: "look", limits: { maxRunUsd: 5 },
      steps: [
        { kind: "agent", id: "look", name: "Look", agent: { agentId: "root-cause-analyst", version: "current" }, next: { kind: "go", to: "ask" } },
        { kind: "gate", id: "ask", name: "Ask", prompt: "Go on?", approvers: [{ kind: "starter" }], onApprove: { to: "$end" }, onReject: { to: "$end" } },
      ],
    });
    const gated = await v.chainCall(DANA, "PUT", `/v1/app/chains/${starterOnly.chainId}/triggers/${ID("b")}`, { project: "web", spec: PR_OPENED });
    expect(gated).toMatchObject({ status: 400, body: { code: "CONFIG_INVALID", message: "steps.1.approvers: no one starts an event or schedule run, so add project maintainers, the chain owner or named people" } });
    expect(await v.triggers.get(ORG_A, ID("a"))).toBeUndefined();
  });

  it("gives a contributor of the project 403 even with manage on the chain, and a trigger naming another org's hook 404", async () => {
    const { v, chain, path } = await chainWorld();
    expect(await v.chainCall(PRIYA, "PUT", path(ID("a")), { project: "web", spec: PR_OPENED })).toMatchObject({ status: 403 });
    v.connection("linear");
    v.hookReader.add({ orgId: ORG_B, hookId: HOOK_B, project: "web", source: "linear", disabled: false });
    const crossOrg = await v.chainCall(DANA, "PUT", path(ID("b")), { project: "web", spec: { kind: "event", source: "linear", type: "issue.created" }, hookId: HOOK_B });
    expect(crossOrg).toMatchObject({ status: 404 });
    expect(chain.chainId).toBeDefined();
    expect(await v.triggers.get(ORG_A, ID("b"))).toBeUndefined();
  });

  it("refuses a hook of another project or another source, a disabled one, and a non-GitHub event with no hook", async () => {
    const { v, path } = await chainWorld();
    v.hook("sentry", HOOK_A, { project: "api" });
    v.hook("datadog", HOOK_A2);
    v.hook("sentry", HOOK_B, { disabled: true });
    const put = (spec: unknown, hookId?: string) => v.chainCall(DANA, "PUT", path(ID("a")), { project: "web", spec, ...(hookId === undefined ? {} : { hookId }) });
    expect(await put(BY_HOOK, HOOK_A)).toMatchObject({ status: 404 });
    expect(await put(BY_HOOK, HOOK_A2)).toMatchObject({ status: 404 });
    expect(await put(BY_HOOK, HOOK_B)).toMatchObject({ status: 400, body: { message: "hookId: that hook is turned off" } });
    expect(await put(BY_HOOK)).toMatchObject({ status: 400, body: { message: "hookId: name the sentry hook that receives these events" } });
    expect(await put(PR_OPENED, HOOK_A)).toMatchObject({ status: 400 });
    expect((await put(BY_HOOK, "hk_nope")).status).toBe(400);
  });

  it("refuses a Linear trigger until the org's Linear connection has recorded an actor id, and the same for Jira", async () => {
    const { v, path } = await chainWorld();
    v.hook("linear", HOOK_A);
    v.hook("jira", HOOK_A2);
    const linear = { kind: "event", source: "linear", type: "issue.created" };
    const jira = { kind: "event", source: "jira", type: "issue.created" };
    expect(await v.chainCall(DANA, "PUT", path(ID("a")), { project: "web", spec: linear, hookId: HOOK_A })).toMatchObject({ status: 400, body: { message: "spec: connect Linear and run its check first, so Rovara can tell its own tickets from others" } });
    expect(await v.chainCall(DANA, "PUT", path(ID("b")), { project: "web", spec: jira, hookId: HOOK_A2 })).toMatchObject({ status: 400, body: { message: "spec: connect Jira and run its check first, so Rovara can tell its own tickets from others" } });
    v.connection("linear");
    expect((await v.chainCall(DANA, "PUT", path(ID("a")), { project: "web", spec: linear, hookId: HOOK_A })).status).toBe(202);
    expect((await v.chainCall(DANA, "PUT", path(ID("b")), { project: "web", spec: jira, hookId: HOOK_A2 })).status).toBe(400);
    v.connection("jira");
    expect((await v.chainCall(DANA, "PUT", path(ID("b")), { project: "web", spec: jira, hookId: HOOK_A2 })).status).toBe(202);
  });

  it("refuses an interval of 5 minutes, a filter key the type does not take, and a zone that does not exist, and takes authorAssociation on a pull request", async () => {
    const { v, path } = await chainWorld();
    const put = (spec: unknown) => v.chainCall(DANA, "PUT", path(ID("a")), { project: "web", spec });
    expect((await put(SCHEDULE({ kind: "interval", minutes: 5 }))).status).toBe(400);
    expect((await put({ ...PR_OPENED, filter: { assignee: ["max"] } })).status).toBe(400);
    expect((await put({ ...SCHEDULE({ kind: "interval", minutes: 60 }), timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await put({ kind: "person" })).status).toBe(400);
    expect((await put({ ...PR_OPENED, filter: { authorAssociation: ["MEMBER"] } })).status).toBe(202);
    expect((await put({ kind: "event", source: "github", type: "workflow_run.completed", filter: { authorAssociation: ["MEMBER"] } })).status).toBe(400);
    expect((await v.chainCall(DANA, "PUT", path(ID("c")), { project: "web", spec: PR_OPENED, maxRunsPerHour: 61 })).status).toBe(400);
    expect((await v.chainCall(DANA, "PUT", path("ctr_bad"), { project: "web", spec: PR_OPENED })).status).toBe(404);
  });

  it("refuses an eleventh trigger on one target, and a project the caller has no role on", async () => {
    const { v, chain, path } = await chainWorld();
    for (let index = 0; index < MAX_TRIGGERS_PER_TARGET; index += 1) {
      const called = await v.chainCall(DANA, "PUT", path(`ctr_${String(index).padStart(20, "0")}`), { project: "web", spec: PR_OPENED, enabled: false });
      expect(called.status).toBe(201);
    }
    const eleventh = await v.chainCall(DANA, "PUT", path(ID("z")), { project: "web", spec: PR_OPENED, enabled: false });
    expect(eleventh).toMatchObject({ status: 400 });
    expect(String(eleventh.body["message"])).toContain("most triggers it can have (10)");
    expect((await v.triggers.listForTarget(ORG_A, { kind: "chain", chainId: chain.chainId })).length).toBe(10);
    expect((await v.chainCall(DANA, "PUT", path(ID("y")), { project: "nowhere", spec: PR_OPENED })).status).toBe(404);
    expect((await v.chainCall(ARJUN, "PUT", path(ID("y")), { project: "web", spec: PR_OPENED })).status).toBe(404);
  });

  it("refuses a trigger on a chain with no published version, and on an archived one", async () => {
    const v = setupTriggerWorld();
    const created = await v.chainCall(DANA, "POST", "/v1/app/chains", { name: "Fresh", owner: { kind: "member", developerId: DANA } });
    const chainId = (created.body["chain"] as { chainId: string }).chainId;
    const unpublished = await v.chainCall(DANA, "PUT", `/v1/app/chains/${chainId}/triggers/${ID("a")}`, { project: "web", spec: PR_OPENED });
    expect(unpublished).toMatchObject({ status: 409, body: { code: "CHAIN_UNAVAILABLE" } });
  });

  it("lists a target's triggers for a viewer, and keeps a stranger and another org out", async () => {
    const { v, chain, path } = await chainWorld();
    await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
    expect((await v.chainCall(PRIYA, "GET", path())).body["triggers"]).toHaveLength(1);
    expect((await v.chainCall(ARJUN, "GET", path())).status).toBe(404);
    expect((await v.chainCall(PRIYA, "GET", path(), undefined, ORG_B)).status).toBe(404);
    const listed = (await v.chainCall(PRIYA, "GET", path())).body["triggers"] as Array<Record<string, unknown>>;
    expect(listed[0]).toMatchObject({ enabled: true, maxRunsPerHour: 30, createdBy: { developerId: DANA, name: "Dana" } });
    expect(JSON.stringify(listed)).not.toContain("revision");
  });

  it("deletes a trigger with its index items, and 404s another org's delete", async () => {
    const { v, chain, path } = await chainWorld();
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
    expect((await v.chainCall(DANA, "DELETE", path(trigger.triggerId), {}, ORG_B)).status).toBe(404);
    expect((await v.chainCall(PRIYA, "DELETE", path(trigger.triggerId), {})).status).toBe(403);
    expect((await v.chainCall(DANA, "DELETE", path(trigger.triggerId), {})).body).toEqual({ deleted: true });
    expect(await v.triggers.get(ORG_A, trigger.triggerId)).toBeUndefined();
    expect(v.db.find((item) => String(item["pk"]).includes(`TARGET_TRIGGERS#CHAIN#${chain.chainId}`) && item["sk"] === trigger.triggerId)).toEqual([]);
    expect(v.db.get(triggerKey(ORG_A, trigger.triggerId))).toBeUndefined();
  });

  it("shows a trigger's activity, newest first, with the reason it was turned off", async () => {
    const { v, chain, path } = await chainWorld();
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
    await v.triggers.recordActivity(ORG_A, trigger.triggerId, { eventKey: "github:1", outcome: "started", runId: `crn_${"a".repeat(20)}` });
    v.clock.now += 1000;
    await v.triggers.recordActivity(ORG_A, trigger.triggerId, { eventKey: "github:2", outcome: "duplicate" });
    const activity = (await v.chainCall(PRIYA, "GET", `${path(trigger.triggerId)}/activity`)).body["activity"] as Array<Record<string, unknown>>;
    expect(activity.map((entry) => [entry.eventKey, entry.outcome])).toEqual([["github:2", "duplicate"], ["github:1", "started"]]);
    expect((await v.chainCall(ARJUN, "GET", `${path(trigger.triggerId)}/activity`)).status).toBe(404);
  });
});

describe("what a trigger on an agent needs", () => {
  it("refuses an event the agent's recipe doesn't allow with the exact text, and accepts one it does once the agent has a budget", async () => {
    const v = setupTriggerWorld();
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }, { kind: "event", source: "github", type: "issues.opened" }]);
    const path = `/v1/app/agents/${agent.agentId}/triggers/${ID("a")}`;
    const wrong = await v.agentCall(DANA, "PUT", path, { project: "web", spec: PR_OPENED });
    expect(wrong).toMatchObject({ status: 400, body: { message: "spec: Triage bot can't be started by events; ask its owner to allow it" } });
    const noBudget = await v.agentCall(DANA, "PUT", path, { project: "web", spec: { kind: "event", source: "github", type: "issues.opened" } });
    expect(noBudget).toMatchObject({ status: 409, body: { code: "AGENT_BUDGET_REQUIRED" } });
    await v.agents.setBudget(ORG_A, agent.agentId, { monthlyUsd: 20 }, fixtureActor(v.agents, ORG_A, DANA).developerId, undefined, { ...({}), actor: fixtureActor(v.agents, ORG_A, DANA) });
    const accepted = await v.agentCall(DANA, "PUT", path, { project: "web", spec: { kind: "event", source: "github", type: "issues.opened" } });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
    expect(await stored(v, ID("a"))).toMatchObject({ target: { kind: "agent", agentId: agent.agentId }, enabled: false, createdBy: DANA });
  });

  it("allows a schedule only where the recipe lists a schedule", async () => {
    const v = setupTriggerWorld();
    const agent = await v.triggerAgent("Nightly", [{ kind: "person" }, TriggerSpecSchema.parse(SCHEDULE({ kind: "interval", minutes: 60 }))], { budgetUsd: 20 });
    const put = (spec: unknown) => v.agentCall(DANA, "PUT", `/v1/app/agents/${agent.agentId}/triggers/${ID("a")}`, { project: "web", spec });
    expect((await put(SCHEDULE({ kind: "interval", minutes: 120 }))).status).toBe(202);
    const events = await v.agentCall(DANA, "PUT", `/v1/app/agents/${agent.agentId}/triggers/${ID("b")}`, { project: "web", spec: PR_OPENED });
    expect(events).toMatchObject({ status: 400, body: { message: "spec: Nightly can't be started by events; ask its owner to allow it" } });
  });

  it("keeps the agent's own access: view to list, manage to set, and another org's agent is 404", async () => {
    const v = setupTriggerWorld();
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }, { kind: "event", source: "github", type: "issues.opened" }], { budgetUsd: 20 });
    const path = `/v1/app/agents/${agent.agentId}/triggers`;
    expect((await v.agentCall(ARJUN, "GET", path)).status).toBe(404);
    expect((await v.agentCall(DANA, "GET", path)).body).toEqual({ triggers: [] });
    expect((await v.agentCall(PRIYA, "PUT", `${path}/${ID("a")}`, { project: "web", spec: { kind: "event", source: "github", type: "issues.opened" } })).status).toBe(404);
    expect((await v.agentCall(DANA, "GET", path, undefined, ORG_B)).status).toBe(404);
  });
});

describe("the built-in agents' triggers", () => {
  it("keeps every built-in recipe on person alone, and lists a project's rows all off", async () => {
    const v = setupTriggerWorld();
    for (const id of BUILTIN_AGENT_IDS) for (const release of BUILTIN_AGENTS[id].versions) expect(release.recipe.triggers).toEqual([{ kind: "person" }]);
    const rows = await v.agentCall(MAX, "GET", "/v1/app/projects/web/builtin-triggers");
    expect(rows.status).toBe(200);
    const list = rows.body["triggers"] as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((row) => row["enabled"] === false)).toBe(true);
    expect(list.find((row) => row["agentId"] === "code-reviewer")).toMatchObject({ index: 0, needsHook: false, runsVersion: expect.any(Number) as number });
    expect((await v.agentCall(ARJUN, "GET", "/v1/app/projects/web/builtin-triggers")).status).toBe(404);
  });

  it("refuses the generic route for a built-in and sends the caller to the switch", async () => {
    const v = setupTriggerWorld();
    await v.builtinBudget("code-reviewer");
    const refused = await v.agentCall(DANA, "PUT", `/v1/app/agents/code-reviewer/triggers/${ID("x")}`, { project: "web", spec: PR_OPENED });
    expect(refused).toMatchObject({ status: 400, body: { message: "use the project's built-in trigger switch" } });
  });

  it("creates one agent trigger whose creator is the caller when a maintainer turns on the code reviewer's row, after confirming, even when the built-in has no accountable", async () => {
    const v = setupTriggerWorld();
    await v.builtinBudget("code-reviewer");
    const turnedOn = await v.agentCall(MAX, "PUT", "/v1/app/projects/web/builtin-triggers/code-reviewer/0", { enabled: true });
    expect(turnedOn.status, JSON.stringify(turnedOn.body)).toBe(202);
    const id = builtinTriggerIdFor(ORG_A, "web", "code-reviewer", 0);
    expect(await stored(v, id)).toMatchObject({ enabled: false, createdBy: MAX, target: { kind: "agent", agentId: "code-reviewer" }, project: "web" });
    await confirm(v, MAX, confirmUrlOf(turnedOn));
    expect(await stored(v, id)).toMatchObject({ enabled: true, createdBy: MAX });
    expect((await v.agentCall(MAX, "GET", "/v1/app/projects/web/builtin-triggers")).body["triggers"]).toContainEqual(expect.objectContaining({ agentId: "code-reviewer", index: 0, enabled: true, triggerId: id }));
    // Turning it off applies at once; turning it on again asks again.
    expect((await v.agentCall(MAX, "PUT", "/v1/app/projects/web/builtin-triggers/code-reviewer/0", { enabled: false })).status).toBe(200);
    expect((await stored(v, id)).enabled).toBe(false);
    expect((await v.agentCall(MAX, "PUT", "/v1/app/projects/web/builtin-triggers/code-reviewer/0", { enabled: true })).status).toBe(202);
    expect(v.db.find((item) => item["entityType"] === "TRIGGER").length).toBe(1);
  });

  it("is for maintainers of the project, narrows a filter and never widens one, and needs a hook only for sources that have one", async () => {
    const v = setupTriggerWorld();
    await v.builtinBudget("code-reviewer");
    const path = "/v1/app/projects/web/builtin-triggers/code-reviewer/0";
    expect((await v.agentCall(PRIYA, "PUT", path, { enabled: true })).status).toBe(403);
    expect((await v.agentCall(ARJUN, "PUT", path, { enabled: true })).status).toBe(404);
    expect((await v.agentCall(MAX, "PUT", "/v1/app/projects/web/builtin-triggers/code-reviewer/7", { enabled: true })).status).toBe(404);
    expect((await v.agentCall(MAX, "PUT", "/v1/app/projects/web/builtin-triggers/rovara-code/0", { enabled: true })).status).toBe(404);
    expect((await v.agentCall(MAX, "PUT", path, { enabled: true, filter: { authorAssociation: ["OWNER", "MEMBER", "COLLABORATOR", "NONE"] } })).status).toBe(400);
    expect((await v.agentCall(MAX, "PUT", path, { enabled: true, filter: { label: ["x"] } })).status).toBe(400);
    const narrowed = await v.agentCall(MAX, "PUT", path, { enabled: true, filter: { authorAssociation: ["OWNER"] } });
    expect(narrowed.status).toBe(202);
    expect((await stored(v, builtinTriggerIdFor(ORG_A, "web", "code-reviewer", 0))).spec).toMatchObject({ filter: { authorAssociation: ["OWNER"] } });
    expect((await v.agentCall(MAX, "PUT", path, { enabled: true, schedule: { kind: "interval", minutes: 60 } })).status).toBe(400);
    expect((await v.agentCall(MAX, "PUT", path, { enabled: true, hookId: "x" })).status).toBe(400);
  });

  it("refuses to turn the row on while the built-in has no budget", async () => {
    const v = setupTriggerWorld();
    const refused = await v.agentCall(MAX, "PUT", "/v1/app/projects/web/builtin-triggers/code-reviewer/0", { enabled: true });
    expect(refused).toMatchObject({ status: 409, body: { code: "AGENT_BUDGET_REQUIRED" } });
  });

  it("starts nothing and changes nothing when a built-in's suggestion changes, and shows a copy of what was turned on", async () => {
    const v = setupTriggerWorld();
    await v.builtinBudget("code-reviewer");
    const asked = await v.agentCall(MAX, "PUT", "/v1/app/projects/web/builtin-triggers/code-reviewer/0", { enabled: true, filter: { authorAssociation: ["OWNER"] } });
    await confirm(v, MAX, confirmUrlOf(asked));
    const id = builtinTriggerIdFor(ORG_A, "web", "code-reviewer", 0);
    const before = await stored(v, id);
    const rows = (await v.agentCall(MAX, "GET", "/v1/app/projects/web/builtin-triggers")).body["triggers"] as Array<Record<string, unknown>>;
    expect(rows.find((row) => row["agentId"] === "code-reviewer")).toMatchObject({ enabled: true, spec: { filter: { authorAssociation: ["OWNER"] } } });
    expect(await stored(v, id)).toEqual(before);
  });
});

describe("archiving and the indexes", () => {
  it("turns off the triggers of an archived chain and of an archived agent, and unarchiving turns none back on", async () => {
    const { v, chain, path } = await chainWorld();
    const onChain = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }, { kind: "event", source: "github", type: "issues.opened" }], { budgetUsd: 20 });
    const onAgent = await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: DANA, spec: TriggerSpecSchema.parse({ kind: "event", source: "github", type: "issues.opened" }) as never });
    expect((await v.chainCall(DANA, "POST", `/v1/app/chains/${chain.chainId}/archive`, {})).status).toBe(200);
    expect((await v.agentCall(DANA, "POST", `/v1/app/agents/${agent.agentId}/archive`, {})).status).toBe(200);
    expect(await stored(v, onChain.triggerId)).toMatchObject({ enabled: false });
    expect(await stored(v, onAgent.triggerId)).toMatchObject({ enabled: false });
    expect(await v.notices(DANA)).toHaveLength(2);
    expect((await v.chainCall(DANA, "POST", `/v1/app/chains/${chain.chainId}/unarchive`, {})).status).toBe(200);
    expect((await stored(v, onChain.triggerId)).enabled).toBe(false);
    expect(path).toBeDefined();
  });

  it("keeps the hook id in the match key, so two triggers of one project on two hooks sit under different keys, and deletes only an org's own items when it closes", async () => {
    const { v, chain, path } = await chainWorld();
    v.hook("sentry", HOOK_A);
    v.hook("sentry", HOOK_A2);
    const first = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA, spec: TriggerSpecSchema.parse(BY_HOOK) as never, hookId: HOOK_A });
    const second = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA, spec: TriggerSpecSchema.parse(BY_HOOK) as never, hookId: HOOK_A2 });
    expect(triggerMatchKey(ORG_A, "sentry", "web", HOOK_A, first.triggerId).pk).not.toBe(triggerMatchKey(ORG_A, "sentry", "web", HOOK_A2, second.triggerId).pk);
    expect((await v.triggers.listForMatch(ORG_A, "sentry", "web", HOOK_A)).map((t) => t.triggerId)).toEqual([first.triggerId]);
    expect((await v.triggers.listForMatch(ORG_A, "sentry", "web", HOOK_A2)).map((t) => t.triggerId)).toEqual([second.triggerId]);
    expect(await v.triggers.listForMatch(ORG_B, "sentry", "web", HOOK_A)).toEqual([]);
    // Another org's trigger, which closing org A must leave.
    const foreign = { ...first, orgId: ORG_B, triggerId: ID("f"), createdBy: "9".repeat(64) };
    await v.triggers.create({ record: foreign });
    await v.triggers.recordActivity(ORG_A, first.triggerId, { eventKey: "k", outcome: "started" });
    await v.triggers.recordActivity(ORG_B, foreign.triggerId, { eventKey: "k", outcome: "started" });
    await (await import("../../packages/broker/src/triggers/lifecycle.js")).deleteOrgTriggers(v.routeDeps, ORG_A);
    expect(v.db.find((item) => String(item["pk"]).startsWith(`ORG#${ORG_A}#TRIGGER`) || String(item["pk"]).startsWith(`ORG#${ORG_A}#TARGET_TRIGGERS`))).toEqual([]);
    expect(await v.triggers.get(ORG_B, foreign.triggerId)).toBeDefined();
    expect(await v.triggers.listActivity(ORG_B, foreign.triggerId)).toHaveLength(1);
    expect(path()).toBeDefined();
    void targetTriggersKey; void triggerTargetKey; void CARL; void VIV;
  });
});
