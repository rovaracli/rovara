// Setup host asks (task SH12) through the whole broker: the `setup_host` decision card appears only while the setup agent switch (`su`) is on, only for a company admin, and its approve is the project's own
// website change (second person, audit, egress plan). With the switch off nothing here reads or writes anything.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionCardsViewSchema, egressDomainsKey, projectRevisionKey, projectPk, type DecisionCard } from "../../packages/contracts/src/index.js";
import { hostAskSubjectId, requestHostAsk } from "../../packages/broker/src/rovara-code/setup-host-ask.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { NAME, setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";

const HOST = "artifactory.corp.example";
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
async function bench(): Promise<Bench> {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit });
  audit.audit.documentClient = t.db as unknown as typeof audit.audit.documentClient;
  return t;
}

async function seeded(): Promise<Bench> {
  const t = await bench();
  await t.person(MAYA, "admin");
  await t.person(OMAR, "owner");
  const asked = await requestHostAsk({ documentClient: t.db, tableName: "state", now: () => Date.now() }, {
    orgId: TEST_ORG, project: NAME, host: HOST, requestedBy: OMAR.developerId, projectDomains: [], journalN: 3, from: { path: "pip.conf", line: 2 },
  });
  expect(asked.outcome).toBe("created");
  return t;
}

describe("the setup_host card", () => {
  it("does not exist while the switch is off, even with an ask stored", async () => {
    const t = await seeded();
    process.env.DECISION_CARDS_ENABLED = "1";
    expect(hosts((await cards(t)).cards)).toEqual([]);
    const base = `/v1/app/decisions/setup_host/${hostAskSubjectId(TEST_ORG, NAME, HOST)}`;
    const pressed = await t.dev(MAYA, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: "x".repeat(64) });
    expect(pressed.status).toBeGreaterThanOrEqual(400);
    expect(t.db.get(projectRevisionKey(TEST_ORG, NAME, 2))).toBeUndefined();
  });

  it("with the switch on, an admin sees one medium card, opens the evidence, approves, and the project's websites change through the second-person rule", async () => {
    const t = await seeded();
    process.env.DECISION_CARDS_ENABLED = "1";
    process.env.SETUP_AGENT_ENABLED = "1";
    const { cards: list, digests } = await cards(t);
    const [card] = hosts(list);
    expect(hosts(list)).toHaveLength(1);
    expect(card).toMatchObject({ risk: "medium", status: "pending", project: NAME });
    expect(card!.question).toContain(HOST);
    const base = `/v1/app/decisions/setup_host/${card!.id.split(":")[1]}`;
    expect((await t.dev(MAYA, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card!.id] })).status).toBe(409);
    expect((await t.dev(MAYA, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digests[card!.id] })).status).toBe(200);
    const approved = await t.dev(MAYA, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card!.id] });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const revision = t.db.get(projectRevisionKey(TEST_ORG, NAME, 2));
    expect((revision?.definition as { network?: unknown }).network).toEqual({ allowedDomains: [HOST] });
    expect(t.db.get(egressDomainsKey(TEST_ORG, { kind: "project", project: NAME }))?.domains).toMatchObject([{ domain: HOST, status: "pending" }]);
    expect(t.db.get({ pk: projectPk(TEST_ORG, NAME), sk: `SETUP_HOST_ASK#${HOST}` })).toMatchObject({ state: "approved", decidedBy: MAYA.developerId });
    expect(hosts((await cards(t)).cards)).toEqual([]);
  });

  it("the person who asked is the only admin here: their own press is refused (a card never acknowledges the sole-owner exception) and the ask stays open", async () => {
    const t = await bench();
    await t.person(OMAR, "owner");
    await requestHostAsk({ documentClient: t.db, tableName: "state", now: () => Date.now() }, { orgId: TEST_ORG, project: NAME, host: HOST, requestedBy: OMAR.developerId, projectDomains: [] });
    process.env.DECISION_CARDS_ENABLED = "1";
    process.env.SETUP_AGENT_ENABLED = "1";
    const { cards: list, digests } = await cards(t, OMAR);
    const [card] = hosts(list);
    const base = `/v1/app/decisions/setup_host/${card!.id.split(":")[1]}`;
    await t.dev(OMAR, "POST", `${base}/evidence-opened`, { requestId: randomUUID(), shownDigest: digests[card!.id] });
    const pressed = await t.dev(OMAR, "POST", `${base}/approve`, { requestId: randomUUID(), shownDigest: digests[card!.id] });
    expect(pressed.status).not.toBe(200);
    expect(t.db.get(projectRevisionKey(TEST_ORG, NAME, 2))).toBeUndefined();
    expect(t.db.get({ pk: projectPk(TEST_ORG, NAME), sk: `SETUP_HOST_ASK#${HOST}` })).toMatchObject({ state: "open" });
  });

  it("a plain member never sees the card", async () => {
    const t = await seeded();
    await t.person(MAYA, "member", "maintainer");
    process.env.DECISION_CARDS_ENABLED = "1";
    process.env.SETUP_AGENT_ENABLED = "1";
    expect(hosts((await cards(t, MAYA)).cards)).toEqual([]);
  });
});
