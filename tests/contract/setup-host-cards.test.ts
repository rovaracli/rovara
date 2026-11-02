// Setup host asks (task SH12) through the whole broker: the `setup_host` decision card appears only while the setup agent switch (`su`) is on AND the install is Cloud, only for a company admin, and its
// approve is the project's own website change (second person, audit, egress plan) that only a live browser session can press. With the switch off nothing here reads or writes anything.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionCardsViewSchema, projectRevisionKey, projectPk, type DecisionCard } from "../../packages/contracts/src/index.js";
import { hostAskSubjectId, requestHostAsk } from "../../packages/broker/src/rovara-code/setup-host-ask.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { NAME, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";

const HOST = "artifactory.acme-build.io";
const TASK = randomUUID();
const SWITCHES = ["SETUP_AGENT_ENABLED", "DECISION_CARDS_ENABLED"] as const;
afterEach(() => { for (const name of SWITCHES) delete process.env[name]; });

const cards = async (t: Bench, who = MAYA) => {
  const reply = await t.dev(who, "GET", "/v1/app/decisions");
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  const { requestId: _gateway, ...own } = reply.body; void _gateway;
  const view = DecisionCardsViewSchema.parse(own);
  return { cards: view.cards, digests: view.digests };
};
const hosts = (list: readonly DecisionCard[]) => list.filter((card) => card.kind === "setup_host");

/** The website change refuses an audit whose client is not the broker's own, so the capture is pointed at the bench's table itself. */
async function bench(options: { cloud?: boolean } = {}): Promise<Bench> {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit, ...options });
  audit.audit.documentClient = t.db as unknown as typeof audit.audit.documentClient;
  return t;
}

async function ask(t: Bench): Promise<void> {
  t.db.set({ ...taskKey(TASK), entityType: "DEVTASK", taskId: TASK, orgId: TEST_ORG, project: NAME, purpose: "setup_agent", developerId: OMAR.developerId });
  const asked = await requestHostAsk({ documentClient: t.db, tableName: "state", now: () => Date.now() }, {
    orgId: TEST_ORG, project: NAME, host: HOST, taskId: TASK, projectDomains: [], journalN: 3, from: { path: "pip.conf", line: 2 },
  });
  expect(asked.outcome).toBe("created");
}

async function seeded(options: { cloud?: boolean } = {}): Promise<Bench> {
  const t = await bench(options);
  await t.person(MAYA, "admin");
  await t.person(OMAR, "owner");
  await ask(t);
  return t;
}

const base = `/v1/app/decisions/setup_host/${hostAskSubjectId(TEST_ORG, NAME, HOST)}`;
const openEvidence = async (t: Bench, card: DecisionCard, digest: string | undefined) => {
  const path = `/v1/app/decisions/setup_host/${card.id.split(":")[1]}`;
  expect((await t.dev(MAYA, "POST", `${path}/evidence-opened`, { requestId: randomUUID(), shownDigest: digest })).status).toBe(200);
  return path;
};

describe("the setup_host card", () => {
  it("does not exist while the switch is off, even with an ask stored", async () => {
    const t = await seeded();
    process.env.DECISION_CARDS_ENABLED = "1";
    expect(hosts((await cards(t)).cards)).toEqual([]);
    const pressed = await t.dev(MAYA, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: "x".repeat(64) });
    expect(pressed.status).toBeGreaterThanOrEqual(400);
    expect(t.db.get(projectRevisionKey(TEST_ORG, NAME, 2))).toBeUndefined();
  });

  it("does not exist on a private install, even with the switch on: websites are added there the way they are today", async () => {
    const t = await seeded({ cloud: false });
    process.env.DECISION_CARDS_ENABLED = "1";
    process.env.SETUP_AGENT_ENABLED = "1";
    expect(hosts((await cards(t)).cards)).toEqual([]);
    const pressed = await t.dev(MAYA, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: "x".repeat(64) });
    expect(pressed.status).toBeGreaterThanOrEqual(400);
    expect(t.db.get(projectRevisionKey(TEST_ORG, NAME, 2))).toBeUndefined();
  });

  it("with the switch on, an admin sees one medium card that needs its evidence opened first", async () => {
    const t = await seeded();
    process.env.DECISION_CARDS_ENABLED = "1";
    process.env.SETUP_AGENT_ENABLED = "1";
    const { cards: list, digests } = await cards(t);
    const [card] = hosts(list);
    expect(hosts(list)).toHaveLength(1);
    expect(card).toMatchObject({ risk: "medium", status: "pending", project: NAME });
    expect(card!.question).toContain(HOST);
    expect((await t.dev(MAYA, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card!.id] })).status).toBe(409);
    expect(t.db.get(projectRevisionKey(TEST_ORG, NAME, 2))).toBeUndefined();
  });

  // NOTE: the browser's cookie boundary has no `decisions` route family yet (WEB_ROUTE_FAMILIES), so today EVERY card press reaches the broker without a browser session. A card that needs one (this
  // one) therefore always answers the website page until that family is added; the approval itself, with a browser session, is covered in setup-host-ask.test.ts ("the card's handler").
  it("a press without a browser session (a token, or Slack) decides nothing and answers the project's website page", async () => {
    const t = await seeded();
    process.env.DECISION_CARDS_ENABLED = "1";
    process.env.SETUP_AGENT_ENABLED = "1";
    const { cards: list, digests } = await cards(t);
    const [card] = hosts(list);
    await openEvidence(t, card!, digests[card!.id]);
    const pressed = await t.dev(MAYA, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card!.id] });
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(202);
    expect(pressed.body).toMatchObject({ outcome: "needs_confirmation", confirmUrl: expect.stringContaining(`/app/projects/${NAME}`) as unknown });
    expect(String((pressed.body as { confirmUrl: string }).confirmUrl).startsWith("https://")).toBe(true);
    expect(t.db.get(projectRevisionKey(TEST_ORG, NAME, 2))).toBeUndefined();
    expect(t.db.get({ pk: projectPk(TEST_ORG, NAME), sk: `SETUP_HOST_ASK#${HOST}` })).toMatchObject({ state: "open" });
    expect(t.db.find((item) => String(item.sk).startsWith("EGRESS_PROPOSAL"))).toEqual([]);
  });

  it("the person who asked is the only admin here: their own press is refused (a card never acknowledges the sole-owner exception), the ask stays open, and nothing is left pending", async () => {
    const t = await bench();
    await t.person(OMAR, "owner");
    await ask(t);
    process.env.DECISION_CARDS_ENABLED = "1";
    process.env.SETUP_AGENT_ENABLED = "1";
    const { cards: list, digests } = await cards(t, OMAR);
    const [card] = hosts(list);
    const path = `/v1/app/decisions/setup_host/${card!.id.split(":")[1]}`;
    await t.dev(OMAR, "POST", `${path}/evidence-opened`, { requestId: randomUUID(), shownDigest: digests[card!.id] });
    const pressed = await t.dev(OMAR, "POST", `${path}/approve`, { requestId: randomUUID(), shownDigest: digests[card!.id] });
    expect(pressed.status).not.toBe(200);
    expect(t.db.get(projectRevisionKey(TEST_ORG, NAME, 2))).toBeUndefined();
    expect(t.db.get({ pk: projectPk(TEST_ORG, NAME), sk: `SETUP_HOST_ASK#${HOST}` })).toMatchObject({ state: "open" });
    expect(t.db.find((item) => String(item.sk).startsWith("EGRESS_PROPOSAL"))).toEqual([]);
  });

  it("a plain member never sees the card", async () => {
    const t = await seeded();
    await t.person(MAYA, "member", "maintainer");
    process.env.DECISION_CARDS_ENABLED = "1";
    process.env.SETUP_AGENT_ENABLED = "1";
    expect(hosts((await cards(t, MAYA)).cards)).toEqual([]);
  });
});
