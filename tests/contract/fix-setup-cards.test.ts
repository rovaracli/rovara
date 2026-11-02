// Setup and test health SH17, through the whole broker: the Fix setup card for a project's maintainers. It exists only while `vx` and the card routes are on, is medium (the evidence is opened first on the
// server), and its approve ("Mark as known failing") adds the stored record's tests to the project's already-failing set. A person who is not a maintainer sees no card and cannot press one.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionCardsViewSchema, type DecisionCard } from "../../packages/contracts/src/index.js";
import { recordFixSetup } from "../../packages/broker/src/test-env/fix-setup.js";
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
  recordFixSetup(store(t), { orgId: TEST_ORG, project: NAME, taskId: TASK, cause: over.cause ?? "fails-on-original-code", tests: over.tests ?? ["tests/a.py::one", "tests/a.py::two"] });

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

  it("make the maintainer open the evidence first (the server enforces it), then Mark as known failing adds the stored tests and the card goes away", async () => {
    const t = await setupWizardBench();
    await seed(t);
    await withSwitches("1", async () => {
      const { cards: list, digests } = await cards(t);
      const card = list[0]!;
      const base = `/v1/app/decisions/${card.id.replace(":", "/")}`;
      const early = await t.dev(OMAR, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card.id] });
      expect(early.status).toBe(409);
      expect(await readKnownFailingRow(store(t), TEST_ORG, NAME)).toEqual({ tests: [], version: 0 });
      expect((await t.dev(OMAR, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digests[card.id] })).status).toBe(200);
      const approved = await t.dev(OMAR, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card.id] });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect((await readKnownFailingRow(store(t), TEST_ORG, NAME))!.tests).toEqual(["tests/a.py::one", "tests/a.py::two"]);
      expect((await cards(t)).cards).toEqual([]);
    });
  });

  it("a card changed under the person (another task joined) is not approved on the old view", async () => {
    const t = await setupWizardBench();
    await seed(t);
    await withSwitches("1", async () => {
      const { cards: list, digests } = await cards(t);
      const card = list[0]!;
      const base = `/v1/app/decisions/${card.id.replace(":", "/")}`;
      await t.dev(OMAR, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digests[card.id] });
      await recordFixSetup(store(t), { orgId: TEST_ORG, project: NAME, taskId: "22222222-2222-4222-8222-222222222222", cause: "fails-on-original-code", tests: ["tests/a.py::three"] });
      const stale = await t.dev(OMAR, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card.id] });
      expect(stale.status).toBe(409);
      expect((await readKnownFailingRow(store(t), TEST_ORG, NAME))!.tests).toEqual([]);
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
      expect(await readKnownFailingRow(store(t), TEST_ORG, NAME)).toEqual({ tests: [], version: 0 });
    });
  });

  it("a cause with nothing to mark has no approve at all", async () => {
    const t = await setupWizardBench();
    await seed(t, { cause: "login-failed" });
    await withSwitches("1", async () => {
      const { cards: list, digests } = await cards(t);
      const card = list[0];
      expect(card!.actions.map((action) => action.kind)).toEqual(["open", "reject"]);
      const reply = await t.dev(OMAR, "POST", `/v1/app/decisions/${card!.id.replace(":", "/")}/approve`, { requestId: randomUUID(), shownDigest: digests[card!.id] });
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
