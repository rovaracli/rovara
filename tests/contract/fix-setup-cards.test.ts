// Setup and test health SH17, through the whole broker: the Fix setup card for a project's maintainers. It exists only while `vx` and the card routes are on, is medium (the evidence is opened first on the
// server), and its approve ("Mark as known failing") adds the stored record's tests to the project's already-failing set. A person who is not a maintainer sees no card and cannot press one.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { DecisionCardsViewSchema, type DecisionCard } from "@rovara-code/contracts";
import { createDecisionPerformer, fixSetupHandler } from "../../packages/broker/src/decisions/performer.js";
import { routeDecisionCards, type DecisionRouteDependencies } from "../../packages/broker/src/decisions/routes.js";
import { dynamoDecisionStore } from "../../packages/broker/src/decisions/store.js";
import { dismissFixSetup, fixSetupItemsFor, markKnownFailing, recordFixSetup } from "../../packages/broker/src/test-env/fix-setup.js";
import { readKnownFailingRow } from "../../packages/broker/src/test-env/known-failing.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { NAME, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";

const withSwitches = async <T>(vx: string | undefined, run: () => Promise<T>): Promise<T> => {
  const before = { vx: process.env.VERIFY_RESULTS_ENABLED, dk: process.env.DECISION_CARDS_ENABLED };
  if (vx === undefined) delete process.env.VERIFY_RESULTS_ENABLED; else process.env.VERIFY_RESULTS_ENABLED = vx;
  process.env.DECISION_CARDS_ENABLED = "1";
  try { return await run(); } finally {
    if (before.vx === undefined) delete process.env.VERIFY_RESULTS_ENABLED; else process.env.VERIFY_RESULTS_ENABLED = before.vx;
    if (before.dk === undefined) delete process.env.DECISION_CARDS_ENABLED; else process.env.DECISION_CARDS_ENABLED = before.dk;
  }
};
afterEach(() => { delete process.env.VERIFY_RESULTS_ENABLED; delete process.env.DECISION_CARDS_ENABLED; });

const TASK = "11111111-1111-4111-8111-111111111111";
const cards = async (t: Bench, who = OMAR) => {
  const reply = await t.dev(who, "GET", "/v1/app/decisions");
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  const { requestId: _gateway, ...own } = reply.body; void _gateway;
  const view = DecisionCardsViewSchema.parse(own);
  return { cards: view.cards.filter((card: DecisionCard) => card.kind === "fix_setup"), digests: view.digests };
};
const store = (t: Bench) => ({ documentClient: t.db, tableName: "state", now: () => Date.now() });
const seed = (t: Bench, over: { tests?: string[]; cause?: "fails-on-original-code" | "login-failed" } = {}) =>
  recordFixSetup(store(t), { orgId: TEST_ORG, project: NAME, taskId: TASK, cause: over.cause ?? "fails-on-original-code", tests: (over.tests ?? ["tests/a.py::one", "tests/a.py::two"]).map((name) => ({ name, checkId: "unit" })) });

describe("Fix setup cards", () => {
  it("do not exist while vx is off: no card, and nothing else about the card list changes", async () => {
    const t = await setupWizardBench();
    await seed(t);
    for (const value of [undefined, "0", "true"]) await withSwitches(value, async () => expect((await cards(t)).cards, String(value)).toEqual([]));
  });

  it("show a medium card to a maintainer with the fixed words, one open link and the two decisions", async () => {
    const t = await setupWizardBench();
    await seed(t);
    await withSwitches("1", async () => {
      const [card] = (await cards(t)).cards;
      expect(card).toMatchObject({ kind: "fix_setup", project: NAME, risk: "medium", status: "pending", question: "Fix the test setup?" });
      expect(card!.actions.map((action) => action.kind)).toEqual(["open", "reject", "approve"]);
      expect(card!.actions[0]!.href).toBe(`/app/onboard?project=${NAME}&step=setup`);
      expect(card!.evidence.map((chip) => chip.label)).toEqual(["Result", "Failing step", "Tasks affected", "Failing before this change"]);
    });
  });

  it("refuses the same press from a token (no live browser session), even after the evidence was opened, and marks nothing", async () => {
    const t = await setupWizardBench();
    await seed(t);
    await withSwitches("1", async () => {
      const { cards: list, digests } = await cards(t);
      const card = list[0]!;
      const base = `/v1/app/decisions/${card.id.replace(":", "/")}`;
      expect((await t.dev(OMAR, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digests[card.id] })).status).toBe(200);
      const refused = await t.dev(OMAR, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card.id] });
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(JSON.stringify(refused.body)).toContain("Use a live browser session to mark tests as known failing.");
      expect(await readKnownFailingRow(store(t), TEST_ORG, NAME)).toEqual({ marks: [], version: 0 });
      expect((await cards(t)).cards).toHaveLength(1);
      // Not now stays open to a token.
      const away = await t.dev(OMAR, "POST", `${base}/reject`, { requestId: randomUUID(), reason: "not_now" });
      expect(away.status, JSON.stringify(away.body)).toBe(200);
    });
  });

  it("'Not now' puts the card away and marks nothing", async () => {
    const t = await setupWizardBench();
    await seed(t);
    await withSwitches("1", async () => {
      const card = (await cards(t)).cards[0]!;
      const reply = await t.dev(OMAR, "POST", `/v1/app/decisions/${card.id.replace(":", "/")}/reject`, { requestId: randomUUID(), reason: "not_now" });
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect((await cards(t)).cards).toEqual([]);
      expect(await readKnownFailingRow(store(t), TEST_ORG, NAME)).toEqual({ marks: [], version: 0 });
    });
  });

  it("a cause with nothing to mark has no approve at all", async () => {
    const t = await setupWizardBench();
    await seed(t, { cause: "login-failed" });
    await withSwitches("1", async () => {
      const { cards: list, digests } = await cards(t);
      const card = list[0];
      expect(card!.actions.map((action) => action.kind)).toEqual(["open", "reject"]);
      const reply = await t.web(OMAR, "POST", `/v1/app/decisions/${card!.id.replace(":", "/")}/approve`, { requestId: randomUUID(), shownDigest: digests[card!.id] });
      expect(reply.status).toBe(404);
    });
  });

  it("are not shown to, and cannot be pressed by, someone who does not maintain the project", async () => {
    const t = await setupWizardBench();
    await t.person(MAYA, "member", "viewer");
    await seed(t);
    await withSwitches("1", async () => {
      expect((await cards(t, MAYA)).cards).toEqual([]);
      const [card] = (await cards(t)).cards;
      const reply = await t.dev(MAYA, "POST", `/v1/app/decisions/${card!.id.replace(":", "/")}/reject`, { requestId: randomUUID(), reason: "not_now" });
      expect(reply.status).toBe(404);
      expect((await cards(t)).cards).toHaveLength(1);
    });
  });
});

// The card routes are not a browser family yet (`web-browser-auth.test.ts` keeps decisions out of /v1/web), so a live browser session is composed here: the real card routes, the real source and handler, a caller the web
// boundary would have vouched for (`browserSession: true`), and an in-memory store.
describe("a press from a live browser session", () => {
  const BROWSER = { orgId: TEST_ORG, developerId: "dev_a", browserSession: true as const };
  function routes() {
    const db = new FakeDynamoDb();
    const clock = { now: Date.UTC(2026, 10, 2, 10, 0, 0) };
    const base = { documentClient: db, tableName: "state", now: () => clock.now };
    const policy = { task: async (id: string) => ({ taskId: id, orgId: TEST_ORG, project: NAME, developerId: "someone_else", developerName: "Else", provider: "github" }) as never, alwaysTwoPeople: async () => false };
    const ports = { store: base, mayEditSettings: async () => true, policy };
    const deps: DecisionRouteDependencies<typeof BROWSER> = {
      sources: { list: (who) => fixSetupItemsFor({ store: base, maintainedProjects: async () => [NAME], task: async () => undefined }, who, { VERIFY_RESULTS_ENABLED: "1" }), locks: async () => ({}) },
      performer: createDecisionPerformer<typeof BROWSER>({ fix_setup: fixSetupHandler({ markKnownFailing: (who, item, requestId) => markKnownFailing(ports, who, item, requestId), dismiss: (who, item) => dismissFixSetup(ports, who, item) }) }),
      store: dynamoDecisionStore(base), now: () => clock.now,
    };
    const call = async (caller: typeof BROWSER | Omit<typeof BROWSER, "browserSession">, method: string, pathname: string, body?: unknown) => {
      try {
        const reply = await routeDecisionCards(deps, caller as typeof BROWSER, { method, pathname, searchParams: new URLSearchParams(), body });
        return { status: reply?.statusCode ?? 0, body: reply?.body as Record<string, unknown> };
      } catch (error) { return { status: (error as { statusCode?: number }).statusCode ?? 500, body: { message: (error as Error).message } }; }
    };
    return { db, base, call };
  }
  const seeded = async (r: ReturnType<typeof routes>) => {
    await recordFixSetup(r.base, { orgId: TEST_ORG, project: NAME, taskId: TASK, cause: "fails-on-original-code", tests: [{ name: "tests/a.py::one", checkId: "unit" }, { name: "tests/a.py::two", checkId: "unit" }] });
    const view = (await r.call(BROWSER, "GET", "/v1/app/decisions")).body as { cards: Array<{ id: string }>; digests: Record<string, string> };
    const card = view.cards[0]!;
    return { card, digest: view.digests[card.id]!, base: `/v1/app/decisions/${card.id.replace(":", "/")}` };
  };

  it("makes the maintainer open the evidence first (the server enforces it), then Mark as known failing adds the stored tests and the card goes away", async () => {
    const r = routes();
    const { card, digest, base } = await seeded(r);
    expect((await r.call(BROWSER, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digest })).status).toBe(409);
    expect(await readKnownFailingRow(r.base, TEST_ORG, NAME)).toEqual({ marks: [], version: 0 });
    expect((await r.call(BROWSER, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digest })).status).toBe(200);
    const approved = await r.call(BROWSER, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digest });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await readKnownFailingRow(r.base, TEST_ORG, NAME))!.marks.map((mark) => mark.name)).toEqual(["tests/a.py::one", "tests/a.py::two"]);
    expect(((await r.call(BROWSER, "GET", "/v1/app/decisions")).body as { cards: unknown[] }).cards.filter((entry) => (entry as { id: string }).id === card.id)).toEqual([]);
  });

  it("does not approve a card that changed under the person (another task joined)", async () => {
    const r = routes();
    const { digest, base } = await seeded(r);
    await r.call(BROWSER, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digest });
    await recordFixSetup(r.base, { orgId: TEST_ORG, project: NAME, taskId: "22222222-2222-4222-8222-222222222222", cause: "fails-on-original-code", tests: [{ name: "tests/a.py::three", checkId: "unit" }] });
    expect((await r.call(BROWSER, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digest })).status).toBe(409);
    expect((await readKnownFailingRow(r.base, TEST_ORG, NAME))!.marks).toEqual([]);
  });

  it("refuses the same approve without the browser flag, with the sentence, even with the evidence opened", async () => {
    const r = routes();
    const { digest, base } = await seeded(r);
    await r.call(BROWSER, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digest });
    const token = { orgId: TEST_ORG, developerId: "dev_a" };
    const refused = await r.call(token, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digest });
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("Use a live browser session to mark tests as known failing.");
    expect(await readKnownFailingRow(r.base, TEST_ORG, NAME)).toEqual({ marks: [], version: 0 });
  });
});
