// Decisions D2: the card routes enforce the friction on the server. A medium card cannot be approved without its evidence opened (409), a high card has no approve route, nothing is bulk, and
// the routes decide nothing themselves: they call the existing endpoint through the performer.
import { describe, expect, it, vi } from "vitest";
import type { DecisionCard, DecisionAnswered } from "@agentx/contracts";
import { DecisionCardsViewSchema } from "@agentx/contracts";
import { routeDecisionCards, type DecisionCaller, type DecisionPerformer, type DecisionRequest, type DecisionSources } from "../../packages/broker/src/decisions/routes.js";
import { decisionCardPath, type DecisionItem, type ItemBase } from "../../packages/broker/src/decisions/project.js";
import { inMemoryDecisionStore } from "../../packages/broker/src/decisions/store.js";
import { summarizeDecisionMeasures, type DecisionMeasure } from "../../packages/broker/src/decisions/measures.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const ME: DecisionCaller = { orgId: "org1", developerId: "dev1" };
const OTHER: DecisionCaller = { orgId: "org1", developerId: "dev2" };
const REQ = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const base = (id: string, extra: Partial<ItemBase> = {}): ItemBase => ({ subjectId: id, taskId: TASK, project: "payments", title: "Retry failed payments", createdAt: "2026-10-30T10:00:00.000Z", openPath: `/app/sessions/ses_${"a".repeat(20)}`, ...extra });
const low = (): DecisionItem => ({ ...base("plan1"), kind: "approve_plan", path: "quick", files: ["src/retry.ts"], claims: 2, untestedClaims: 0 });
const medium = (): DecisionItem => ({ ...base("dep1"), kind: "approve_dependency", packages: 2, newInstallScripts: false });
const high = (): DecisionItem => ({ ...base("set1"), kind: "approve_setting", settingLabel: "Allow video", secondPerson: false });
const requirements = (): DecisionItem => ({ ...base("req1"), kind: "approve_requirements", claims: 3 });
const design = (): DecisionItem => ({ ...base("des1"), kind: "approve_design", files: ["src/a.ts"] });

function setup(items: DecisionItem[] = [low(), medium(), high()], now = { ms: Date.parse("2026-10-30T10:05:00.000Z") }) {
  const state = { items };
  const sources: DecisionSources = { list: vi.fn(async (caller: DecisionCaller) => (caller.developerId === "dev1" ? state.items : [])), locks: async () => ({}) };
  const performer = { approve: vi.fn(async () => undefined), reject: vi.fn(async () => undefined) } satisfies DecisionPerformer;
  const store = inMemoryDecisionStore(() => now.ms);
  const measures: DecisionMeasure[] = [];
  const deps = { sources, performer, store, now: () => now.ms, log: (measure: DecisionMeasure) => { measures.push(measure); } };
  const call = (caller: DecisionCaller, method: string, pathname: string, body: unknown = undefined, query = ""): Promise<Awaited<ReturnType<typeof routeDecisionCards>>> =>
    routeDecisionCards(deps, caller, { method, pathname, searchParams: new URLSearchParams(query), body } satisfies DecisionRequest);
  const path = (cardId: string, action: string) => `${decisionCardPath(cardId)}/${action}`;
  return { state, sources, performer, store, measures, deps, call, path, now };
}

describe("GET /v1/app/decisions", () => {
  it("lists the caller's cards, high first, and nobody else's", async () => {
    const t = setup();
    const mine = await t.call(ME, "GET", "/v1/app/decisions");
    const view = DecisionCardsViewSchema.parse(mine?.body);
    expect(view.cards.map((card) => card.id)).toEqual(["approve_setting:set1", "approve_dependency:dep1", "approve_plan:plan1"]);
    expect(view.total).toBe(3);
    expect(DecisionCardsViewSchema.parse((await t.call(OTHER, "GET", "/v1/app/decisions"))?.body).cards).toEqual([]);
  });
  it("answers undefined for a path or method it does not own", async () => {
    const t = setup();
    expect(await t.call(ME, "GET", "/v1/app/home")).toBeUndefined();
    expect(await t.call(ME, "POST", "/v1/app/decisions", { ids: ["a"] })).toBeUndefined();
    expect(await t.call(ME, "POST", "/v1/app/decisions/approve-all", {})).toBeUndefined();
    expect(await t.call(ME, "GET", "/v1/app/decisions/approve_plan/plan1/approve")).toBeUndefined();
  });
});

describe("a low-risk card is one request", () => {
  it("approves through the performer once and records the decision and its measure", async () => {
    const t = setup();
    const reply = await t.call(ME, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(1) });
    expect(reply?.statusCode).toBe(200);
    expect(reply?.body).toEqual({ cardId: "approve_plan:plan1", outcome: "approved", remainingTabs: [] });
    expect(t.performer.approve).toHaveBeenCalledTimes(1);
    const [, card] = t.performer.approve.mock.calls[0] as unknown as [DecisionCaller, DecisionCard];
    expect(card.id).toBe("approve_plan:plan1");
    expect(t.store.decisions).toHaveLength(1);
    expect(t.measures).toHaveLength(1);
    expect(t.measures[0]).toMatchObject({ measure: "decision_made", kind: "approve_plan", risk: "low", outcome: "approved", seconds: 300 });
  });
  it("needs no evidence record, and says so", async () => {
    const t = setup();
    expect((await t.call(ME, "POST", t.path("approve_plan:plan1", "evidence-opened"), { requestId: REQ(2) }))?.body).toEqual({ cardId: "approve_plan:plan1", opened: true, recorded: false });
  });
});

describe("a medium card cannot be approved until its evidence was opened", () => {
  it("refuses with 409 and never calls the performer", async () => {
    const t = setup();
    await expect(t.call(ME, "POST", t.path("approve_dependency:dep1", "approve"), { requestId: REQ(3) })).rejects.toMatchObject({ code: "CHANGE_STALE", statusCode: 409 });
    expect(t.performer.approve).not.toHaveBeenCalled();
    expect(t.store.decisions).toHaveLength(0);
  });
  it("accepts it after the evidence-opened event", async () => {
    const t = setup();
    expect((await t.call(ME, "POST", t.path("approve_dependency:dep1", "evidence-opened"), { requestId: REQ(4) }))?.body).toMatchObject({ recorded: true });
    expect((await t.call(ME, "POST", t.path("approve_dependency:dep1", "approve"), { requestId: REQ(5) }))?.statusCode).toBe(200);
    expect(t.performer.approve).toHaveBeenCalledTimes(1);
    expect(t.store.decisions[0]?.openedAt).toBeDefined();
  });
  it("refuses again when what was shown changed after it was opened", async () => {
    const t = setup();
    await t.call(ME, "POST", t.path("approve_dependency:dep1", "evidence-opened"), { requestId: REQ(6) });
    t.state.items = [{ ...medium(), packages: 9 } as DecisionItem, low(), high()];
    await expect(t.call(ME, "POST", t.path("approve_dependency:dep1", "approve"), { requestId: REQ(7) })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(t.performer.approve).not.toHaveBeenCalled();
  });
  it("does not count another person's opening, and an opening expires", async () => {
    const t = setup();
    t.state.items = [medium()];
    await t.deps.store.recordEvidenceOpened({ orgId: "org1", developerId: "dev2", cardId: "approve_dependency:dep1" }, "whatever", new Date(t.now.ms).toISOString());
    await expect(t.call(ME, "POST", t.path("approve_dependency:dep1", "approve"), { requestId: REQ(8) })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await t.call(ME, "POST", t.path("approve_dependency:dep1", "evidence-opened"), { requestId: REQ(9) });
    t.now.ms += 4 * 86_400_000;
    await expect(t.call(ME, "POST", t.path("approve_dependency:dep1", "approve"), { requestId: REQ(10) })).rejects.toMatchObject({ code: "CHANGE_STALE" });
  });
});

describe("a high card has no approve route", () => {
  it("answers 404 to approve and to evidence-opened, and never calls the performer", async () => {
    const t = setup();
    await expect(t.call(ME, "POST", t.path("approve_setting:set1", "approve"), { requestId: REQ(11) })).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    await expect(t.call(ME, "POST", t.path("approve_setting:set1", "evidence-opened"), { requestId: REQ(12) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(t.call(ME, "POST", t.path("approve_setting:set1", "reject"), { requestId: REQ(13), reason: "not_now" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(t.performer.approve).not.toHaveBeenCalled();
    expect(t.performer.reject).not.toHaveBeenCalled();
  });
  it("a lock that raises a low card to high closes its approve route too", async () => {
    const t = setup([low()]);
    t.sources.locks = async () => ({ approve_plan: "high" });
    await expect(t.call(ME, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(14) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("nothing is bulk and only the caller's own cards exist", () => {
  it("refuses a body that names several cards", async () => {
    const t = setup();
    await expect(t.call(ME, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(15), ids: ["approve_plan:plan1", "approve_dependency:dep1"] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(t.call(ME, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(15), cardIds: [] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(t.performer.approve).not.toHaveBeenCalled();
  });
  it("answers 404 for a card that is not in the caller's list (another person's, gone, or malformed)", async () => {
    const t = setup();
    await expect(t.call(OTHER, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(16) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(t.call(ME, "POST", t.path("approve_plan:nope", "approve"), { requestId: REQ(17) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(t.call(ME, "POST", "/v1/app/decisions/not_a_kind/x1/approve", { requestId: REQ(18) })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A path that is not a card route at all is not ours.
    expect(await t.call(ME, "POST", "/v1/app/decisions/%E0%A4%A/approve", { requestId: REQ(18) })).toBeUndefined();
    expect(await t.call(ME, "POST", "/v1/app/decisions/not-a-card/approve", { requestId: REQ(18) })).toBeUndefined();
    expect(t.performer.approve).not.toHaveBeenCalled();
  });
  it("a card that already has an outcome is not approvable again", async () => {
    const t = setup([{ ...low(), outcome: "approved" }]);
    await expect(t.call(ME, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(19) })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("passes a performer's refusal on and records nothing", async () => {
    const t = setup();
    t.performer.approve.mockRejectedValueOnce(Object.assign(new Error("stale"), { name: "AgentXError", code: "CHANGE_STALE" }));
    await expect(t.call(ME, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(20) })).rejects.toThrow("stale");
    expect(t.store.decisions).toHaveLength(0);
    expect(t.measures).toHaveLength(0);
  });
  it("a failure to write history or a measure never turns a made decision into an error", async () => {
    const t = setup();
    t.deps.store.recordDecision = async () => { throw new Error("table down"); };
    t.deps.log = () => { throw new Error("log down"); };
    expect((await t.call(ME, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(21) }))?.statusCode).toBe(200);
  });
});

describe("reject", () => {
  it("takes one of the card's reasons and calls the performer, never approving", async () => {
    const t = setup();
    const reply = await t.call(ME, "POST", t.path("approve_dependency:dep1", "reject"), { requestId: REQ(22), reason: "too_big" });
    expect(reply?.body).toEqual({ cardId: "approve_dependency:dep1", outcome: "rejected", remainingTabs: [] });
    expect(t.performer.reject).toHaveBeenCalledWith(ME, expect.objectContaining({ id: "approve_dependency:dep1" }), { requestId: REQ(22), subjectId: "dep1", reason: "too_big", tab: undefined });
    expect(t.performer.approve).not.toHaveBeenCalled();
    expect(t.store.decisions[0]).toMatchObject({ outcome: "rejected", reason: "too_big" });
  });
  it("refuses an unknown reason", async () => {
    const t = setup();
    await expect(t.call(ME, "POST", t.path("approve_plan:plan1", "reject"), { requestId: REQ(23), reason: "because" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("Full path: one card, two tabs, two recorded approvals", () => {
  const pair = () => [requirements(), design()];
  it("lists one card with two tabs", async () => {
    const t = setup(pair());
    const view = DecisionCardsViewSchema.parse((await t.call(ME, "GET", "/v1/app/decisions"))?.body);
    expect(view.cards).toHaveLength(1);
    expect(view.tabs["approve_requirements:req1"]?.map((tab) => tab.id)).toEqual(["requirements", "design"]);
  });
  it("needs the tab named, and one approval per tab", async () => {
    const t = setup(pair());
    const id = "approve_requirements:req1";
    await expect(t.call(ME, "POST", t.path(id, "approve"), { requestId: REQ(30) })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    // The existing endpoint decides the requirements; from then on the source lists only the design, which is its own card.
    t.performer.approve.mockImplementationOnce(async () => { t.state.items = [design()]; });
    const first = await t.call(ME, "POST", t.path(id, "approve"), { requestId: REQ(31), tab: "requirements" });
    expect(first?.body).toEqual({ cardId: id, outcome: "approved", tab: "requirements", remainingTabs: ["design"] });
    expect(t.performer.approve).toHaveBeenLastCalledWith(ME, expect.objectContaining({ id }), { requestId: REQ(31), subjectId: "req1", tab: "requirements" });
    const second = await t.call(ME, "POST", t.path("approve_design:des1", "approve"), { requestId: REQ(32) });
    expect((second?.body as DecisionAnswered).remainingTabs).toEqual([]);
    expect(t.performer.approve).toHaveBeenCalledTimes(2);
    expect(t.store.decisions.map((record) => record.kind)).toEqual(["approve_requirements", "approve_design"]);
  });
  it("a medium pair needs each tab's evidence opened, tab by tab", async () => {
    const t = setup([requirements(), { ...design(), files: ["src/auth/login.ts"] } as DecisionItem]);
    const id = "approve_requirements:req1";
    await expect(t.call(ME, "POST", t.path(id, "approve"), { requestId: REQ(33), tab: "requirements" })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await t.call(ME, "POST", t.path(id, "evidence-opened"), { requestId: REQ(34) }, "tab=requirements");
    expect((await t.call(ME, "POST", t.path(id, "approve"), { requestId: REQ(35), tab: "requirements" }))?.statusCode).toBe(200);
    await expect(t.call(ME, "POST", t.path(id, "approve"), { requestId: REQ(36), tab: "design" })).rejects.toMatchObject({ code: "CHANGE_STALE" });
  });
  it("the design tab acts on the design document, not the card's own", async () => {
    const t = setup(pair());
    await t.call(ME, "POST", t.path("approve_requirements:req1", "approve"), { requestId: REQ(38), tab: "design" });
    expect(t.performer.approve).toHaveBeenCalledWith(ME, expect.anything(), { requestId: REQ(38), subjectId: "des1", tab: "design" });
  });
  it("refuses a tab on an ordinary card", async () => {
    const t = setup();
    await expect(t.call(ME, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(37), tab: "design" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("measures", () => {
  it("count decisions per person per day and the median time to decide", async () => {
    const t = setup();
    await t.call(ME, "POST", t.path("approve_plan:plan1", "approve"), { requestId: REQ(40) });
    t.now.ms += 100_000;
    await t.call(ME, "POST", t.path("approve_dependency:dep1", "reject"), { requestId: REQ(41), reason: "not_now" });
    const summary = summarizeDecisionMeasures(t.measures);
    expect(Object.values(summary.perPersonPerDay)).toEqual([2]);
    expect(summary.medianSeconds).toBe(350);
    expect(JSON.stringify(t.measures)).not.toContain("dev1");
  });
});
