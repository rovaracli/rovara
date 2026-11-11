// srv/needs-broker-ui-2 (controller's review of batch 1): the per-project needs-you count (`AppNavSchema.projects[].needsYou`, computed by `homeNeedsYou`) is made from the SAME set of
// cards Home shows, so it respects Home's dedupe and the caller's dismissals: a task whose plan card is replaced by an approve_plan decision card counts once, not twice; a dismissed card is
// not counted in its project (and comes back when it is a new occurrence); a dismissal is the dismisser's alone.
import { afterEach, describe, expect, it } from "vitest";
import { AppNavSchema, orgMetaKey } from "@agentx/contracts";
import { dismissHomeCard, homeCards, homeNeedsYou, registerHomeCardSource, type HomeCardSource, type HomeDependencies, type PendingDecisionRef } from "../../packages/broker/src/agent-sessions/home.js";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { ARJUN, CELL, PRIYA, sessionWorld } from "../support/agent-session-world.js";

const unregister: Array<() => void> = [];
afterEach(() => { while (unregister.length > 0) unregister.pop()!(); });
const source = (entry: HomeCardSource) => { unregister.push(registerHomeCardSource(entry)); };

const AT = "2026-10-23T12:00:00.000Z";
const TASK_PLAN = "11111111-1111-4111-8111-111111111111";
const TASK_PR = "22222222-2222-4222-8222-222222222222";
const SESSION = "ses_00000000000000000001";
const card = (kind: "plan" | "pull_request" | "offer", id: string, project: string | undefined, extra: Record<string, unknown> = {}) => ({
  cardId: `${kind}:${id}`, kind, title: `${kind} ${id}`, reason: "It needs you.", at: AT, buttons: [], ...(project === undefined ? {} : { project }), ...extra,
});

function homeWorld(options: { decisions?: (developerId: string) => PendingDecisionRef[] } = {}) {
  const w = sessionWorld();
  const deps: HomeDependencies = {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, projectMembers: w.members, signInStore: w.signInStore, origin: CELL, cursorKey: "k".repeat(64),
    taskView: async () => { throw new Error("not read by Home's count"); },
    ...(options.decisions === undefined ? {} : { pendingDecisions: async (caller) => options.decisions!(caller.developerId) }),
  };
  const caller = (who: string) => ({ ...w.caller(who), orgRole: "member" as const });
  return { w, deps, caller };
}

describe("the per-project needs-you count", () => {
  it("counts a plan whose approve_plan decision card is pending once, and a pull request whose merge card is pending once", async () => {
    const decisions = (who: string): PendingDecisionRef[] => (who === PRIYA ? [
      { cardId: "approve_plan:p1", kind: "approve_plan", taskId: TASK_PLAN, project: "web" },
      { cardId: "merge:m1", kind: "merge", taskId: TASK_PR, project: "web" },
    ] : []);
    const h = homeWorld({ decisions });
    source({ kind: "plan", list: async () => [card("plan", "p1", "web", { taskId: TASK_PLAN })] });
    // The owner's own pull request card for a session is `pull_request:<sessionId>`; its merge card replaces it.
    source({ kind: "pull_request", list: async () => [card("pull_request", SESSION, "web", { taskId: TASK_PR, sessionId: SESSION })] });
    source({ kind: "offer", list: async () => [card("offer", "o1", "web"), card("offer", "o2", "ops")] });
    const counts = await homeNeedsYou(h.deps, h.caller(PRIYA));
    // The plan card and the pull request card are left out for the decision cards that hold their decisions: web has one offer and the two decision cards, not four things.
    expect(counts.byProject).toEqual({ web: 3, ops: 1 });
    expect(counts.total).toBe(2); // Home's own cards: the two offers
    expect(counts.needsYou).toBe(4); // and the two decision cards
    // The count is the Home answer's, card for card.
    const home = await homeCards(h.deps, h.caller(PRIYA));
    expect(home.cards.map((entry) => entry.cardId).sort()).toEqual(["offer:o1", "offer:o2"]);
    expect(home.needsYou).toBe(counts.needsYou);
    // Positive control: someone with no decision cards of their own has the plan and pull request cards as the cards they are (nothing replaces them), so the dedupe is what removed them above.
    const arjun = await homeNeedsYou(h.deps, h.caller(ARJUN));
    expect(arjun.byProject).toEqual({ web: 3, ops: 1 });
    expect(arjun.total).toBe(4);
    expect(arjun.needsYou).toBe(4);
  });

  it("does not count a card the caller dismissed in its project, counts it again for a new occurrence, and leaves other people's counts alone", async () => {
    const h = homeWorld({ decisions: () => [] });
    let occurrence = "v1";
    source({ kind: "offer", list: async () => [card("offer", "a", "web", { occurrence }), card("offer", "b", "web", { occurrence }), card("offer", "c", "ops", { occurrence })] });
    expect((await homeNeedsYou(h.deps, h.caller(PRIYA))).byProject).toEqual({ web: 2, ops: 1 });
    await dismissHomeCard(h.deps, h.caller(PRIYA), "offer:b");
    await dismissHomeCard(h.deps, h.caller(PRIYA), "offer:c");
    const after = await homeNeedsYou(h.deps, h.caller(PRIYA));
    expect(after.byProject).toEqual({ web: 1 }); // ops has nothing left to count
    expect(after.total).toBe(1);
    // The dismissal is Priya's alone.
    expect((await homeNeedsYou(h.deps, h.caller(ARJUN))).byProject).toEqual({ web: 2, ops: 1 });
    // A new occurrence of a dismissed card is a new thing that needs her.
    occurrence = "v2";
    expect((await homeNeedsYou(h.deps, h.caller(PRIYA))).byProject).toEqual({ web: 2, ops: 1 });
  });

  it("is the number the navigation answer gives a project, after Home's own dismissal route has hidden a card", async () => {
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
    h.db.set({ ...orgMetaKey(TEST_ORG), orgId: TEST_ORG, name: "Maya's organization", plan: "trial", createdBy: MAYA.developerId, createdAt: "2026-10-23T12:00:00Z" });
    source({ kind: "offer", list: async (_deps, who) => (who.developerId === MAYA.developerId ? [card("offer", "a", "payments"), card("offer", "b", "payments"), card("offer", "c", "payments")] : []) });
    const nav = async (who: typeof MAYA) => {
      const reply = await h.dev(who, "GET", "/v1/app/nav");
      expect(reply.status).toBe(200);
      const { requestId: _requestId, ...body } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id
      return AppNavSchema.parse(body);
    };
    // Before the dismissal (read from Home itself: the navigation answer is cached for a few seconds, so it is first read after).
    expect((await h.dev(MAYA, "GET", "/v1/app/home")).body.total).toBe(3);
    const dismissed = await h.dev(MAYA, "POST", "/v1/app/home/cards/offer:b/dismiss", {});
    expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200);
    const mayaNav = await nav(MAYA);
    expect(mayaNav.projects.find((project) => project.name === "payments")?.needsYou).toBe(2);
    expect(mayaNav.homeCount).toBe(2);
    expect((await h.dev(MAYA, "GET", "/v1/app/home")).body.total).toBe(2);
    // Omar has no cards of his own.
    expect((await nav(OMAR)).homeCount).toBe(0);
  });
});
