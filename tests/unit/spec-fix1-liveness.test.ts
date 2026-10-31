// Fix round 1: I1 who may approve, I2/I3 the obligation is never lost or left behind, C2 holds can always be left, M2 the link line, M4 bug or feature, and the owner-choice route.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpecTargetSchema, type SpecFile, type SpecTarget } from "@agentx/contracts";
import { readSpecPullRequestOf } from "../../packages/broker/src/aws/broker/spec-wiring.js";
import { specKindOf } from "../../packages/broker/src/aws/developer-tasks/spec-wiring.js";
import { createSpecHooks, specStateItem, type PlanApproval, type SpecStore, type SpecTaskRef, type SpecWorld } from "../../packages/broker/src/spec/hooks.js";
import { withSpecLink } from "../../packages/broker/src/spec/link.js";
import { approvingReviewer, specStateFromFacts, type SpecPullRequestFacts } from "../../packages/broker/src/spec/refresh.js";
import { newSpecState, publishSucceeded, specGate, startWriting, writeSucceeded, type SpecState } from "../../packages/broker/src/spec/state.js";

const TASK = randomUUID();
const PLAN_A = "a".repeat(64);
const PLAN_B = "e".repeat(64);
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const NOW = "2026-10-31T10:00:00.000Z";
const META = "https://github.com/acme/service-meta";
const FILES: SpecFile[] = [{ path: ".kiro/specs/x/requirements.md", content: "- 1.1 WHEN a THE SYSTEM SHALL b\n" }];
const target = (overrides: Partial<SpecTarget> = {}): SpecTarget => SpecTargetSchema.parse({ format: "kiro", ...overrides });
const task: SpecTaskRef = { taskId: TASK, title: "T", knowledgeCommit: BASE };

function published(overrides: Partial<SpecTarget> = {}): SpecState {
  let state = startWriting(newSpecState({ taskId: TASK, planDigest: PLAN_A, kind: "feature", target: target(overrides), knowledgeCommit: BASE, now: NOW }), randomUUID(), NOW)!;
  state = writeSucceeded(state, { operationId: state.writeOperationId!, title: "T", files: FILES, requirementCount: 1 }, NOW)!;
  return publishSucceeded(state, { pullRequest: { number: 12, url: `${META}/pull/12`, repositoryUrl: META, headBranch: `agentx/${randomUUID()}`, commit: HEAD } }, NOW)!;
}
const review = (state: string, login: string, overrides: Record<string, unknown> = {}) => ({ state, commitId: HEAD, login, userId: `id-${login}`, eligible: true, ...overrides });
const facts = (reviews: SpecPullRequestFacts["reviews"], extra: Partial<SpecPullRequestFacts> = {}): SpecPullRequestFacts => ({ state: "open", headSha: HEAD, reviews, ...extra });

describe("I1: who may approve a spec_first spec", () => {
  it("ignores a review whose author is not eligible (a bot, or someone without write access)", () => {
    expect(specStateFromFacts(published({ linkStyle: "spec_first" }), facts([review("APPROVED", "bot[bot]", { eligible: false })]), NOW)).toBeUndefined();
    expect(specStateFromFacts(published({ linkStyle: "spec_first" }), facts([{ state: "APPROVED", commitId: HEAD, login: "x" }]), NOW)).toBeUndefined();
  });
  it("counts the latest review of each reviewer: a later approval clears that reviewer's earlier change request, a later change request withdraws an approval", () => {
    expect(approvingReviewer([review("CHANGES_REQUESTED", "alice"), review("APPROVED", "alice")], HEAD)).toEqual({ login: "alice" });
    expect(approvingReviewer([review("APPROVED", "alice"), review("CHANGES_REQUESTED", "alice")], HEAD)).toBeUndefined();
    expect(approvingReviewer([review("APPROVED", "alice"), review("COMMENTED", "alice")], HEAD)).toEqual({ login: "alice" });
    expect(approvingReviewer([review("APPROVED", "alice"), review("DISMISSED", "alice")], HEAD)).toBeUndefined();
  });
  it("an eligible reviewer's objection blocks another's approval; an ineligible one's does not", () => {
    expect(approvingReviewer([review("APPROVED", "alice"), review("CHANGES_REQUESTED", "bob")], HEAD)).toBeUndefined();
    expect(approvingReviewer([review("APPROVED", "alice"), review("CHANGES_REQUESTED", "outsider", { eligible: false })], HEAD)).toEqual({ login: "alice" });
  });
  it("counts only reviews of the recorded head", () => {
    expect(approvingReviewer([review("APPROVED", "alice", { commitId: "d".repeat(40) })], HEAD)).toBeUndefined();
  });
  it("releases the hold in the state when an eligible reviewer approved", () => {
    const next = specStateFromFacts(published({ linkStyle: "spec_first" }), facts([review("CHANGES_REQUESTED", "alice"), review("APPROVED", "alice")]), NOW)!;
    expect(next.approvedBy).toBe("alice");
    expect(specGate(next).action).toBe("proceed");
  });
  describe("the broker's eligibility check", () => {
    const status = (reviews: Array<{ login: string; userType: string; state?: string }>) => ({ state: "open", headSha: HEAD, reviews: reviews.map((entry, index) => ({ state: entry.state ?? "APPROVED", commitId: HEAD, login: entry.login, githubUserId: String(index), userType: entry.userType })) });
    const read = async (reviews: Array<{ login: string; userType: string; state?: string }>, permission: ((login: string) => Promise<string>) | undefined) => {
      const getRepositoryPermission = permission === undefined ? undefined : vi.fn(async (_url: string, login: string) => permission(login));
      const dependencies = { githubPullRequests: { getPullRequestStatus: vi.fn(async () => status(reviews)), ...(getRepositoryPermission === undefined ? {} : { getRepositoryPermission }) } } as never;
      return { facts: await readSpecPullRequestOf(dependencies)({ orgId: "o" } as never, META, 12), getRepositoryPermission };
    };
    it("marks a person with write or admin access eligible, and a reader, a bot, an app and a person nobody can look up not", async () => {
      const levels: Record<string, string> = { writer: "write", admin: "admin", reader: "read", nobody: "none" };
      const out = await read([{ login: "writer", userType: "User" }, { login: "admin", userType: "User" }, { login: "reader", userType: "User" }, { login: "nobody", userType: "User" }, { login: "rovara[bot]", userType: "Bot" }, { login: "botty", userType: "Bot" }], async (login) => levels[login] ?? "write");
      expect(out.facts!.reviews.map((entry) => [entry.login, entry.eligible])).toEqual([["writer", true], ["admin", true], ["reader", false], ["nobody", false], ["rovara[bot]", false], ["botty", false]]);
      expect(out.getRepositoryPermission!.mock.calls.map((call) => call[1])).not.toContain("rovara[bot]");
    });
    it("makes every review ineligible when permissions cannot be asked, or fail", async () => {
      expect((await read([{ login: "alice", userType: "User" }], undefined)).facts!.reviews[0]!.eligible).toBe(false);
      expect((await read([{ login: "alice", userType: "User" }], async () => { throw new Error("502"); })).facts!.reviews[0]!.eligible).toBe(false);
    });
  });
});

function memoryWorld(extra: Partial<SpecWorld> = {}) {
  const rows = new Map<string, SpecState>();
  let corrupt = false;
  const store: SpecStore = {
    load: async (id) => (corrupt ? { state: undefined, corrupt: true } : { state: rows.get(id), corrupt: false }),
    save: async (next, replaces) => { const current = rows.get(next.taskId); if ((current?.revision) !== replaces) return false; rows.set(next.taskId, next); return true; },
    force: async (next) => { corrupt = false; rows.set(next.taskId, next); return true; },
  };
  const world: SpecWorld = { tableName: "t", now: () => NOW, store, log: () => undefined, startWrite: async ({ items }) => { for (const item of items(randomUUID())) { const next = item.Put!.Item as SpecState; rows.set(next.taskId, next); } return "STARTED"; }, publish: async () => ({ ok: false, transient: true }), ...extra };
  return { world, rows, setCorrupt: (value: boolean) => { corrupt = value; } };
}
const approval = (overrides: Partial<PlanApproval> = {}): PlanApproval => ({ task, planDigest: PLAN_A, kind: "feature", target: target({ when: "medium_and_large" }), size: "large", ...overrides });
const gateInput = (extra: Record<string, unknown> = {}) => ({ task, approvedPlanDigest: PLAN_A, planMarkdown: () => "plan", metaRepositoryUrl: META, ...extra });

describe("I3: a re-approved plan that no longer needs a spec clears the old state", () => {
  it("stores the older plan's state as skipped, and the gate lets the code through", async () => {
    const { world, rows } = memoryWorld();
    const hooks = createSpecHooks(world);
    expect(await hooks.onPlanApproved(approval())).toBe("recorded");
    expect(await hooks.onPlanApproved(approval({ planDigest: PLAN_B, size: "small" }))).toBe("not_due");
    expect(rows.get(TASK)).toMatchObject({ status: "skipped", planDigest: PLAN_B });
    expect(await hooks.gate(gateInput({ approvedPlanDigest: PLAN_B }))).toEqual({ proceed: true });
  });
  it("leaves a state of the same plan alone, and one already skipped", async () => {
    const { world, rows } = memoryWorld();
    const hooks = createSpecHooks(world);
    await hooks.onPlanApproved(approval());
    const before = rows.get(TASK)!.revision;
    await hooks.onPlanApproved(approval({ size: "small" }));
    expect(rows.get(TASK)!.revision).toBe(before);
  });
});

describe("I2: the obligation is found again when its record is missing, and an error holds", () => {
  it("records and starts the spec when the gate finds no record but the project and the plan call for one", async () => {
    const start = vi.fn(async () => "STARTED" as const);
    const { world, rows } = memoryWorld({ startWrite: start });
    const out = await createSpecHooks(world).gate(gateInput({ derive: async () => approval({ target: target() }) }));
    expect(out).toMatchObject({ proceed: false, hold: { reason: "writing" } });
    expect(rows.get(TASK)).toMatchObject({ status: "due" });
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("goes on when nothing calls for a spec, and holds with Retry and Continue when it cannot be told", async () => {
    const { world } = memoryWorld();
    const hooks = createSpecHooks(world);
    expect(await hooks.gate(gateInput({ derive: async () => undefined }))).toEqual({ proceed: true });
    expect(await hooks.gate(gateInput({ derive: async () => { throw new Error("ddb down"); } }))).toMatchObject({ proceed: false, hold: { reason: "failed", ownerActions: ["retry", "continue_without_spec"] } });
  });
  it("holds, failed, when the spec writer cannot be given a base commit to read rules at", async () => {
    const { world, rows } = memoryWorld({ startWrite: async () => "REFUSED" });
    await createSpecHooks(world).onPlanApproved(approval({ target: target() }));
    const out = await createSpecHooks(world).gate(gateInput());
    expect(out).toMatchObject({ proceed: false, hold: { reason: "failed" } });
    expect(rows.get(TASK)).toMatchObject({ status: "failed", failure: { code: "write_failed" } });
  });
});

describe("C2: no hold without a way out", () => {
  it("settles a write whose run has ended (a failed delivery, a cancel, anything) as failed, with Retry and Continue", async () => {
    const { world, rows } = memoryWorld({ operationEnded: async () => true });
    const hooks = createSpecHooks(world);
    await hooks.onPlanApproved(approval({ target: target() }));
    await hooks.gate(gateInput());
    expect(rows.get(TASK)!.status).toBe("writing");
    const out = await hooks.gate(gateInput());
    expect(out).toMatchObject({ proceed: false, hold: { reason: "failed", ownerActions: ["retry", "continue_without_spec"] } });
    expect(rows.get(TASK)).toMatchObject({ status: "failed", failure: { code: "write_failed" } });
    expect(await hooks.ownerChoice({ taskId: TASK, action: "retry", by: "owner" })).toMatchObject({ status: "due" });
  });
  it("leaves a write whose run is still going, and one the broker cannot look up", async () => {
    for (const ended of [async () => false, async () => { throw new Error("ddb"); }]) {
      const { world, rows } = memoryWorld({ operationEnded: ended });
      const hooks = createSpecHooks(world);
      await hooks.onPlanApproved(approval({ target: target() }));
      await hooks.gate(gateInput());
      await hooks.gate(gateInput());
      expect(rows.get(TASK)!.status).toBe("writing");
    }
  });
  it("lets the owner continue past a record that cannot be read, and then the code goes through", async () => {
    const { world, rows, setCorrupt } = memoryWorld();
    const hooks = createSpecHooks(world);
    setCorrupt(true);
    expect(await hooks.gate(gateInput())).toMatchObject({ proceed: false, hold: { ownerActions: ["continue_without_spec"] } });
    const continued = await hooks.ownerChoice({ taskId: TASK, action: "continue_without_spec", by: "owner" });
    expect(continued).toMatchObject({ status: "skipped", continuedWithoutSpec: { by: "owner" } });
    expect(rows.get(TASK)).toEqual(continued);
    expect(await hooks.gate(gateInput())).toEqual({ proceed: true });
  });
  it("lets the owner continue when there is no record at all (the check itself failed)", async () => {
    const { world, rows } = memoryWorld();
    const hooks = createSpecHooks(world);
    expect(await hooks.ownerChoice({ taskId: TASK, action: "continue_without_spec", by: "owner" })).toMatchObject({ continuedWithoutSpec: { by: "owner" } });
    expect(rows.get(TASK)).toBeDefined();
    expect(await hooks.gate(gateInput({ derive: async () => approval({ target: target() }) }))).toEqual({ proceed: true });
  });
  it("offers nothing for a keep or a retry when there is no record", async () => {
    const { world } = memoryWorld();
    const hooks = createSpecHooks(world);
    expect(await hooks.ownerChoice({ taskId: TASK, action: "keep", by: "owner" })).toBeUndefined();
    expect(await hooks.ownerChoice({ taskId: TASK, action: "retry", by: "owner" })).toBeUndefined();
  });
});

describe("M2: the spec line on a code pull request", () => {
  const line = `Spec: ${META}/pull/12 @ ${HEAD}`;
  it("is added at the top even when a plan line elsewhere looks like one", () => {
    const body = withSpecLink("Summary\nSpec: https://github.com/evil/other/pull/1 @ abc\nmore", line);
    expect(body.startsWith(line)).toBe(true);
  });
  it("is not added twice, and not when there is none", () => {
    const once = withSpecLink("Summary", line);
    expect(withSpecLink(once, line)).toBe(once);
    expect(withSpecLink("x", undefined)).toBe("x");
  });
});

describe("M4: a bug is told from a feature by the request", () => {
  it.each([["Fix crash when saving", "bugfix"], ["Totals drop cents (bug)", "bugfix"], ["Regression in checkout", "bugfix"], ["Add password reset", "feature"], ["Prefix handling", "feature"]])("%s is a %s", (title, kind) => {
    expect(specKindOf({ title, requestText: undefined })).toBe(kind);
  });
  it("reads the request text too", () => { expect(specKindOf({ title: "Cart", requestText: "The total is broken for 3 items" })).toBe("bugfix"); });
});

describe("the owner's choice route", () => {
  const specOwnerChoice = vi.fn(async () => ({ status: "due" }));
  beforeEach(() => { specOwnerChoice.mockClear(); });
  it("maps the four paths to the four choices, for the task named, and refuses the rest", async () => {
    vi.resetModules();
    vi.doMock("../../packages/broker/src/aws/developer-tasks/spec-wiring.js", () => ({ specOwnerChoice }));
    vi.doMock("../../packages/broker/src/aws/developer-routes/dependencies.js", () => ({ developerTaskRouteDependencies: (deps: unknown) => deps }));
    const { SPEC_CHOICE_ROUTE, routeSpecChoice } = await import("../../packages/broker/src/aws/developer-routes/spec-routes.js");
    const deps = { tasks: {} } as never;
    const caller = { developerId: "d" } as never;
    expect(SPEC_CHOICE_ROUTE.exec("/v1/app/tasks/abc/spec/continue")?.slice(1)).toEqual(["abc", "continue"]);
    expect(SPEC_CHOICE_ROUTE.exec("/v1/app/tasks/abc/spec/nope")).toBeNull();
    expect(SPEC_CHOICE_ROUTE.exec("/v1/app/tasks/a/b/spec/retry")).toBeNull();
    for (const [path, action] of [["retry", "retry"], ["continue", "continue_without_spec"], ["keep", "keep"], ["replan", "replan"]] as const) {
      await routeSpecChoice(deps, caller, "task%2D1", path);
      expect(specOwnerChoice).toHaveBeenLastCalledWith(deps, caller, "task-1", action);
    }
    await expect(routeSpecChoice(deps, caller, "task-1", "merge")).rejects.toThrow(/route not found/u);
    await expect(routeSpecChoice({ tasks: undefined } as never, caller, "task-1", "retry")).rejects.toThrow(/not set up/u);
    vi.doUnmock("../../packages/broker/src/aws/developer-tasks/spec-wiring.js");
    vi.doUnmock("../../packages/broker/src/aws/developer-routes/dependencies.js");
  });
});

void specStateItem;
