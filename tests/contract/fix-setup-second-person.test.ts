// Setup and test health SH17 (owner decision F4, option D): who must confirm "Mark as known failing", through the whole broker with a live browser session and the real approval cards. One maintainer may mark, unless
// they own an affected task, an owner is unknown, the card is full, or the company turned on "always two people"; the second person is a different eligible maintainer or admin, or the company's only owner through the
// sole-owner exception (audited as such, and refused when the company turned the exception off).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionCardsViewSchema, orgMetaKey, teamRecordPk } from "../../packages/contracts/src/index.js";

// The card routes are not a browser family yet (web-browser-auth.test.ts keeps decisions out of /v1/web); this file lets them through so a real cookie session (`browserSession`) can press them.
vi.mock("../../packages/broker/src/aws/web-auth.js", async (original) => {
  const real = await original<Record<string, unknown> & { webRouteAllowed: (method: string, pathname: string) => boolean }>();
  return { ...real, webRouteAllowed: (method: string, pathname: string) => pathname.startsWith("/v1/web/decisions") || real.webRouteAllowed(method, pathname) };
});

import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { recordFixSetup } from "../../packages/broker/src/test-env/fix-setup.js";
import { readKnownFailingRow } from "../../packages/broker/src/test-env/known-failing.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR, type Developer } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { NAME, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";

afterEach(() => { delete process.env.VERIFY_RESULTS_ENABLED; delete process.env.DECISION_CARDS_ENABLED; });
const TASK = "11111111-1111-4111-8111-111111111111";
const store = (t: Bench) => ({ documentClient: t.db, tableName: "state", now: () => Date.now() });

async function bench(options: { owner: Developer; maya?: boolean }) {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit });
  if (options.maya === true) await t.person(MAYA, "admin");
  t.db.set({ ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, orgId: TEST_ORG, project: NAME, title: "Retry payments", developerId: options.owner.developerId, developerName: options.owner.name, provider: options.owner.provider });
  await recordFixSetup(store(t), { orgId: TEST_ORG, project: NAME, taskId: TASK, cause: "fails-on-original-code", tests: [{ name: "tests/a.py::one", checkId: "unit" }] });
  return { t, audit };
}
const marks = async (t: Bench) => (await readKnownFailingRow(store(t), TEST_ORG, NAME))!.marks.map((mark) => mark.name);

/** Opens the card's evidence and presses Mark as known failing, as `who` from a browser session. */
async function press(t: Bench, who: Developer) {
  const reply = await t.web(who, "GET", "/v1/app/decisions");
  const { requestId: gateway, ...own } = reply.body; void gateway;
  const view = DecisionCardsViewSchema.parse(own);
  const card = view.cards.find((entry) => entry.kind === "fix_setup")!;
  const base = `/v1/app/decisions/${card.id.replace(":", "/")}`;
  const digest = view.digests[card.id];
  await t.web(who, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digest });
  return t.web(who, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digest });
}
const knownFailingCards = (t: Bench) => t.approvals().filter((card) => (card as { subject: { kind: string } }).subject.kind === "known_failing");
const markedEvents = (audit: ReturnType<typeof capturingAuditDeps>) => audit.recordedBy("project.known_failing_marked");

describe("a presser who is not the owner of any affected task", () => {
  it("marks alone: one maintainer is enough, audited as a single approval", async () => {
    const { t, audit } = await bench({ owner: MAYA, maya: true });
    process.env.VERIFY_RESULTS_ENABLED = "1"; process.env.DECISION_CARDS_ENABLED = "1";
    const reply = await press(t, OMAR);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(await marks(t)).toEqual(["tests/a.py::one"]);
    expect(knownFailingCards(t)).toEqual([]);
    expect(markedEvents(audit)[0]).toMatchObject({ facts: { approvalMode: "single", secondPersonWhy: "not_needed" } });
  });
});

describe("a presser who owns an affected task", () => {
  it("is refused until a different maintainer or admin confirms, then marks with both audited", async () => {
    const { t, audit } = await bench({ owner: OMAR, maya: true });
    process.env.VERIFY_RESULTS_ENABLED = "1"; process.env.DECISION_CARDS_ENABLED = "1";
    const first = await press(t, OMAR);
    expect(first.status, JSON.stringify(first.body)).toBe(403);
    expect(JSON.stringify(first.body)).toContain("Someone else has to decide this.");
    expect(await marks(t)).toEqual([]);
    // The confirmation card exists for a second person, bound to this card and these tests.
    expect(knownFailingCards(t)).toHaveLength(1);
    const card = knownFailingCards(t)[0] as { approvalId: string; status: string; requestedBy: string };
    expect(card).toMatchObject({ status: "PENDING", requestedBy: OMAR.developerId });
    // Pressing again before anyone confirmed marks nothing and does not make a second card.
    expect((await press(t, OMAR)).status).toBe(403);
    expect(knownFailingCards(t)).toHaveLength(1);
    t.confirmCard(card.approvalId, MAYA);
    const second = await press(t, OMAR);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(await marks(t)).toEqual(["tests/a.py::one"]);
    expect(markedEvents(audit)[0]).toMatchObject({ actor: { id: OMAR.developerId }, related: [MAYA.developerId], facts: { approvalMode: "second_person", secondPersonWhy: "owner_of_affected_task" }, proof: { kind: "fresh_sign_in" } });
  });

  it("is not helped by the confirmation of the same person when the company has another eligible person", async () => {
    const { t } = await bench({ owner: OMAR, maya: true });
    process.env.VERIFY_RESULTS_ENABLED = "1"; process.env.DECISION_CARDS_ENABLED = "1";
    await press(t, OMAR);
    const card = knownFailingCards(t)[0] as { approvalId: string };
    t.confirmCard(card.approvalId, OMAR);
    const reply = await press(t, OMAR);
    expect(reply.status).toBe(403);
    expect(await marks(t)).toEqual([]);
  });
});

describe("the company's only owner (the sole-owner exception)", () => {
  it("confirms their own card, marks, and it is audited as sole_owner_exception", async () => {
    const { t, audit } = await bench({ owner: OMAR });
    process.env.VERIFY_RESULTS_ENABLED = "1"; process.env.DECISION_CARDS_ENABLED = "1";
    expect((await press(t, OMAR)).status).toBe(403);
    t.confirmCard((knownFailingCards(t)[0] as { approvalId: string }).approvalId, OMAR);
    const reply = await press(t, OMAR);
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(await marks(t)).toEqual(["tests/a.py::one"]);
    expect(markedEvents(audit)[0]).toMatchObject({ facts: { approvalMode: "sole_owner_exception", secondPersonWhy: "owner_of_affected_task" } });
  });

  it("is refused when the company turned the sole-owner exception off", async () => {
    const { t } = await bench({ owner: OMAR });
    process.env.VERIFY_RESULTS_ENABLED = "1"; process.env.DECISION_CARDS_ENABLED = "1";
    t.teamDb.set({ pk: teamRecordPk(TEST_ORG), sk: "LESSONSET#COMPANYSOLE", entityType: "LESSON_SOLE_OWNER_SETTING", enabled: false, updatedAt: 1 });
    expect((await press(t, OMAR)).status).toBe(403);
    t.confirmCard((knownFailingCards(t)[0] as { approvalId: string }).approvalId, OMAR);
    const reply = await press(t, OMAR);
    expect(reply.status, JSON.stringify(reply.body)).toBe(403);
    expect(await marks(t)).toEqual([]);
  });
});

describe("the company setting always two people", () => {
  const turnOn = (t: Bench) => t.db.set({ pk: orgMetaKey(TEST_ORG).pk, sk: "KNOWNFAILING#POLICY", entityType: "KNOWN_FAILING_POLICY", enabled: false, updatedAt: 1 });

  it("applies to everyone, even a presser who owns nothing affected", async () => {
    const { t, audit } = await bench({ owner: MAYA, maya: true });
    process.env.VERIFY_RESULTS_ENABLED = "1"; process.env.DECISION_CARDS_ENABLED = "1";
    turnOn(t);
    expect((await press(t, OMAR)).status).toBe(403);
    expect(await marks(t)).toEqual([]);
    t.confirmCard((knownFailingCards(t)[0] as { approvalId: string }).approvalId, MAYA);
    expect((await press(t, OMAR)).status).toBe(200);
    expect(markedEvents(audit)[0]).toMatchObject({ facts: { approvalMode: "second_person", secondPersonWhy: "always_two" } });
  });

  it("a confirmation made before a task joined (a changed card) does not carry over", async () => {
    const { t } = await bench({ owner: OMAR, maya: true });
    process.env.VERIFY_RESULTS_ENABLED = "1"; process.env.DECISION_CARDS_ENABLED = "1";
    await press(t, OMAR);
    t.confirmCard((knownFailingCards(t)[0] as { approvalId: string }).approvalId, MAYA);
    await recordFixSetup(store(t), { orgId: TEST_ORG, project: NAME, taskId: "22222222-2222-4222-8222-222222222222", cause: "fails-on-original-code", tests: [{ name: "tests/a.py::two", checkId: "unit" }] });
    const reply = await press(t, OMAR);
    expect(reply.status).toBe(403);
    expect(await marks(t)).toEqual([]);
    expect(knownFailingCards(t)).toHaveLength(2);
  });
});
