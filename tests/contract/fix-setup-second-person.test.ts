// Setup and test health SH17 (owner decision F4, option D): who must confirm "Mark as known failing", through the whole broker with a live browser session and the real approval cards. One maintainer may mark, unless
// they own an affected task, an owner is unknown, the card is full, or the company turned on "always two people"; the second person is a different eligible maintainer or admin, or the company's only owner through the
// sole-owner exception (audited as such, and refused when the company turned the exception off).
import { createHash, randomUUID } from "node:crypto";
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
import { browserRequests } from "../support/browser-session.js";
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

// M3 (Opus re-check): the second person's confirmation page lists the tests, and they must have opened it before confirming (the same rule the presser follows on the card).
import { approvalDecideKind } from "../../packages/broker/src/agents/approval-decide-kind.js";
import { KNOWN_FAILING_OPEN_FIRST_MESSAGE } from "../../packages/broker/src/agents/approval-viewed.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import type { ApprovalDependencies } from "../../packages/broker/src/agents/approvals.js";

describe("the confirmation page of a mark (M3)", () => {
  const proof = () => ({ kind: "fresh_sign_in" as const, method: "email_code" as const, authTime: new Date(Date.now() - 60_000).toISOString(), sessionRef: "a".repeat(64) });
  async function pending() {
    const made = await bench({ owner: OMAR, maya: true });
    process.env.VERIFY_RESULTS_ENABLED = "1"; process.env.DECISION_CARDS_ENABLED = "1";
    await recordFixSetup(store(made.t), { orgId: TEST_ORG, project: NAME, taskId: "22222222-2222-4222-8222-222222222222", cause: "fails-on-original-code", tests: [{ name: `tests/${"long/".repeat(30)}x.py::two`, checkId: "lint" }] });
    expect((await press(made.t, OMAR)).status).toBe(403);
    const card = knownFailingCards(made.t)[0] as { approvalId: string };
    const deps = { documentClient: made.t.db, tableName: "state", modelSignInTableName: "state", signInStore: new DeveloperSignInStore({ documentClient: made.t.db, tableName: "state", now: () => Date.now() }), teamRecordTable: { documentClient: made.t.teamDb, tableName: "team" }, now: () => Date.now() } as unknown as ApprovalDependencies;
    return { ...made, card, kind: approvalDecideKind(deps), target: { orgId: TEST_ORG, developerId: MAYA.developerId, approvalId: card.approvalId } };
  }

  it("lists every test the mark covers, each in full with its check", async () => {
    const { kind, target } = await pending();
    const inspected = await kind.inspect(target);
    expect(inspected).toMatchObject({ status: "open", view: { title: "Confirm marking tests as already failing" } });
    const view = (inspected as { view: { paragraphs: string[]; facts: Array<{ label: string }> } }).view;
    expect(view.paragraphs[0]).toContain("Confirm marking");
    expect(view.paragraphs.slice(1)).toEqual(["tests/a.py::one (check unit)", `tests/${"long/".repeat(30)}x.py::two (check lint)`]);
  });

  it("refuses a confirmation by a person who has not opened the page, accepts it after they have, and lets a decline through", async () => {
    const { kind, target, t } = await pending();
    await expect(kind.decide(target, "approve", proof())).rejects.toThrow(KNOWN_FAILING_OPEN_FIRST_MESSAGE);
    expect(t.approvals().filter((card) => (card as { status: string }).status === "PENDING")).toHaveLength(1);
    // Someone else opening it does not count for this person.
    await kind.opened!({ ...target, developerId: OMAR.developerId }).catch(() => undefined);
    await expect(kind.decide(target, "approve", proof())).rejects.toThrow(KNOWN_FAILING_OPEN_FIRST_MESSAGE);
    // Eligibility checks (inspect) run before every decision and from the sign-in code: they must not count as the page having been opened.
    await kind.inspect(target);
    await expect(kind.decide(target, "approve", proof())).rejects.toThrow(KNOWN_FAILING_OPEN_FIRST_MESSAGE);
    await kind.opened!(target);
    const decided = await kind.decide(target, "approve", proof());
    expect(decided.message).toMatch(/Approved/u);
  });

  it("a decline needs no reading", async () => {
    const { kind, target } = await pending();
    expect((await kind.decide(target, "decline", proof())).message).toMatch(/Declined/u);
  });
});

// M3 (second Opus re-check): "opened" is recorded only when the page is rendered, and it is enforced for every route that can decide.
import { routeApprovalRequest } from "../../packages/broker/src/agents/approval-routes.js";
import { routeDecidePage } from "../../packages/broker/src/aws/decide-web.js";
import { DECIDE_COOKIE, DecideStore, csrfTokenFor, requireDecideSession, type DecideRequestContext } from "../../packages/broker/src/developer/decide-session.js";

/** Runs `work` with the decision cards switched off, then puts the switch back as it was. */
async function withCardsOff<T>(work: () => Promise<T>): Promise<T> {
  const was = process.env.DECISION_CARDS_ENABLED;
  delete process.env.DECISION_CARDS_ENABLED;
  try { return await work(); } finally { if (was !== undefined) process.env.DECISION_CARDS_ENABLED = was; }
}

describe("opening the page before confirming holds on every route (M3)", () => {
  const CELL = "https://cell.example.com";
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  async function world() {
    const made = await bench({ owner: OMAR, maya: true });
    process.env.VERIFY_RESULTS_ENABLED = "1"; process.env.DECISION_CARDS_ENABLED = "1";
    await recordFixSetup(store(made.t), { orgId: TEST_ORG, project: NAME, taskId: "22222222-2222-4222-8222-222222222222", cause: "fails-on-original-code", tests: [{ name: "tests/b.py::two", checkId: "lint" }] });
    expect((await press(made.t, OMAR)).status).toBe(403);
    const card = knownFailingCards(made.t)[0] as { approvalId: string };
    const deps = { documentClient: made.t.db, tableName: "state", modelSignInTableName: "state", signInStore: new DeveloperSignInStore({ documentClient: made.t.db, tableName: "state", now: () => Date.now() }), teamRecordTable: { documentClient: made.t.teamDb, tableName: "team" }, now: () => Date.now() } as unknown as ApprovalDependencies;
    const kind = approvalDecideKind(deps);
    const decideStore = new DecideStore({ documentClient: made.t.db, tableName: "state", now: () => Date.now() });
    const context: DecideRequestContext = { store: decideStore, now: () => Date.now(), cellOrigin: CELL, kinds: { apr: kind }, authenticateBearer: async () => { throw new Error("no bearer here"); } };
    let counter = 0;
    const session = async (approvalId: string) => {
      counter += 1;
      const cookie = `cookie-${String(counter)}-${"x".repeat(40)}`;
      const signedInAt = Math.floor(Date.now() / 1000) - 30;
      await decideStore.putSession(cookie, { orgId: TEST_ORG, developerId: MAYA.developerId, approvalId, signedInAt, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: signedInAt + 600 });
      return cookie;
    };
    // The confirmation page as it is with the decision cards off (slice 3b: with them on, its GET sends a browser to the card, below).
    const page = (method: "GET" | "POST", cookie: string, decision = "approve") => withCardsOff(() => routeDecidePage(context, {
      method, path: `/v1/app/approve/${card.approvalId}`, requestId: "r",
      headers: { cookie: `${DECIDE_COOKIE}=${cookie}`, ...(method === "POST" ? { origin: CELL, "content-type": "application/x-www-form-urlencoded" } : {}) },
      ...(method === "POST" ? { body: new URLSearchParams({ decision, csrf: csrfTokenFor(cookie) }).toString() } : {}),
    }, new URL(`${CELL}/v1/app/approve/${card.approvalId}`)));
    const route = (cookie: string) => routeApprovalRequest(
      { ...deps, requireDecide: (request: Parameters<typeof requireDecideSession>[1]) => requireDecideSession(context, request) },
      { orgId: TEST_ORG, developerId: MAYA.developerId, orgRole: "admin" } as never,
      { method: "POST", path: `/v1/app/approvals/${card.approvalId}/decide`, requestId: "r", headers: { cookie: `${DECIDE_COOKIE}=${cookie}`, origin: CELL, "content-type": "application/json" }, body: JSON.stringify({ csrf: csrfTokenFor(cookie), requestId: randomUUID(), decision: "APPROVE" }) },
      new URL(`${CELL}/v1/app/approvals/${card.approvalId}/decide`),
    );
    return { ...made, card, page, session, route, status: () => (made.t.approvals().find((entry) => (entry as { approvalId: string }).approvalId === card.approvalId) as { status: string }).status };
  }

  it("slice 3b: with the decision cards on, the page's GET sends a browser to the approval's card (one release, then the page goes)", async () => {
    const w = await world();
    const redirected = await routeDecidePage({} as never, { method: "GET", path: `/v1/app/approve/${w.card.approvalId}`, requestId: "r", headers: {} }, new URL(`${CELL}/v1/app/approve/${w.card.approvalId}`));
    expect(redirected).toMatchObject({ statusCode: 302, headers: { location: `/app/decisions/approve_request/${w.card.approvalId}` } });
  });

  it("slice 3b (security review): the known-failing approval is decided on its card: Approve is refused until its evidence is opened (which records the page as read), then taken with the decide-grade sign-in", async () => {
    const w = await world();
    const web = browserRequests(w.t);
    // A rule's approver is not on any list: the card page names the approval (as the old link's redirect does), and the server lists it because the kind lets her decide it now.
    const unnamed = await web(MAYA, "GET", "/v1/app/decisions");
    expect(JSON.stringify(unnamed.body)).not.toContain(`approve_request:${w.card.approvalId}`);
    const list = await web(MAYA, "GET", `/v1/app/decisions?approval=${w.card.approvalId}`);
    const { requestId: gateway, ...own } = list.body; void gateway;
    const view = DecisionCardsViewSchema.parse(own);
    const id = `approve_request:${w.card.approvalId}`;
    expect(view.cards.map((entry) => entry.id), "the second person has the card").toContain(id);
    // Someone the kind does not let decide it (the presser) gets nothing, named or not.
    expect(JSON.stringify((await web(OMAR, "GET", `/v1/app/decisions?approval=${w.card.approvalId}`)).body)).not.toContain(id);
    const digest = view.digests[id]!;
    const value = randomUUID() + "-" + "x".repeat(20);
    const signedInAt = Math.floor(Date.now() / 1000) - 30;
    await new DecideStore({ documentClient: w.t.db, tableName: "state", now: () => Date.now() }).putSession(value, { orgId: TEST_ORG, developerId: MAYA.developerId, approvalId: w.card.approvalId, signedInAt, method: "email_code", csrfHash: "h".repeat(64), expiresAt: signedInAt + 600 });
    const cookie = `${DECIDE_COOKIE}=${value}`;
    const path = `/v1/app/decisions/approve_request/${w.card.approvalId}`;
    expect((await web(MAYA, "POST", `${path}/approve`, { requestId: randomUUID(), shownDigest: digest }, 0, cookie)).status).toBe(409);
    expect(w.status()).toBe("PENDING");
    expect((await web(MAYA, "POST", `${path}/evidence-opened`, { requestId: randomUUID(), shownDigest: digest })).status).toBe(200);
    const approved = await web(MAYA, "POST", `${path}/approve`, { requestId: randomUUID(), shownDigest: digest }, 0, cookie);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(w.status()).not.toBe("PENDING");
  });

  it("the page refuses a POST approve with no earlier GET, and the session is given back; a GET then a POST confirms", async () => {
    const w = await world();
    const cookie = await w.session(w.card.approvalId);
    const refused = await w.page("POST", cookie);
    expect(refused.body).toContain(KNOWN_FAILING_OPEN_FIRST_MESSAGE);
    expect(w.status()).toBe("PENDING");
    expect((await w.page("GET", cookie)).statusCode).toBe(200);
    expect((await w.page("POST", cookie)).body).toMatch(/Approved/u);
    expect(w.status()).not.toBe("PENDING");
  });

  it("a decline through the page needs no GET", async () => {
    const w = await world();
    expect((await w.page("POST", await w.session(w.card.approvalId), "decline")).body).toMatch(/Declined/u);
  });

  it("POST /v1/app/approvals/{id}/decide refuses a confirmation without the page having been rendered, and takes it after", async () => {
    const w = await world();
    const cookie = await w.session(w.card.approvalId);
    await expect(w.route(cookie)).rejects.toThrow(KNOWN_FAILING_OPEN_FIRST_MESSAGE);
    expect(w.status()).toBe("PENDING");
    expect((await w.page("GET", cookie)).statusCode).toBe(200);
    await w.route(cookie);
    expect(w.status()).not.toBe("PENDING");
  });
});
