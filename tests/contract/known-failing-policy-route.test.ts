// Setup and test health SH17 (owner decision F4): the company setting "always two people" for marking tests as already failing, through the whole broker with a live browser session. GET is open to members; POST is for
// owners and admins from a browser only; turning it on applies at once; turning it off is a proposal a DIFFERENT admin approves (no sole-owner path); every change is audited.
import { afterEach, describe, expect, it } from "vitest";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";

afterEach(() => { delete process.env.VERIFY_RESULTS_ENABLED; });
const PATH = "/v1/app/org/known-failing-policy";
const on = () => { process.env.VERIFY_RESULTS_ENABLED = "1"; };
async function bench(options: { maya?: "admin" | "member" } = {}) {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit });
  if (options.maya !== undefined) await t.person(MAYA, options.maya);
  return { t, audit };
}
const policyEvents = (audit: ReturnType<typeof capturingAuditDeps>) => audit.recorded().filter((event) => event.action.startsWith("company.known_failing_policy_"));
const get = async (t: Bench, who = OMAR) => (await t.web(who, "GET", PATH));

describe("behind vx", () => {
  it("is not found while vx is off, for any value but exactly 1", async () => {
    const { t } = await bench();
    for (const value of [undefined, "0", "true", " 1"]) {
      if (value === undefined) delete process.env.VERIFY_RESULTS_ENABLED; else process.env.VERIFY_RESULTS_ENABLED = value;
      expect((await get(t)).status, String(value)).toBe(404);
      expect((await t.web(OMAR, "POST", PATH, { action: "set", alwaysTwoPeople: true })).status).toBe(404);
    }
  });
});

describe("reading", () => {
  it("is open to members (off by default) and to a token; only an admin is told which proposal is waiting", async () => {
    const { t } = await bench({ maya: "member" });
    on();
    expect(await get(t, MAYA)).toMatchObject({ status: 200, body: { alwaysTwoPeople: false, pendingLoosening: false } });
    expect((await t.dev(MAYA, "GET", PATH)).status).toBe(200);
    expect((await t.web(OMAR, "POST", PATH, { action: "set", alwaysTwoPeople: true })).status).toBe(200);
    expect(await get(t, MAYA)).toMatchObject({ status: 200, body: { alwaysTwoPeople: true } });
  });
});

describe("writing", () => {
  it("is refused from a token, and from a member in a browser, and writes nothing", async () => {
    const { t, audit } = await bench({ maya: "member" });
    on();
    const token = await t.dev(OMAR, "POST", PATH, { action: "set", alwaysTwoPeople: true });
    expect(token.status).toBe(403);
    expect(JSON.stringify(token.body)).toContain("Use a live browser session");
    const member = await t.web(MAYA, "POST", PATH, { action: "set", alwaysTwoPeople: true });
    expect(member.status).toBe(403);
    expect(JSON.stringify(member.body)).toContain("Only a company owner or admin");
    expect(await get(t)).toMatchObject({ body: { alwaysTwoPeople: false } });
    expect(policyEvents(audit)).toEqual([]);
  });

  it("turning it on applies at once and is audited", async () => {
    const { t, audit } = await bench();
    on();
    const reply = await t.web(OMAR, "POST", PATH, { action: "set", alwaysTwoPeople: true });
    expect(reply).toMatchObject({ status: 200, body: { status: "applied", alwaysTwoPeople: true } });
    expect(policyEvents(audit)).toHaveLength(1);
    expect(policyEvents(audit)[0]).toMatchObject({ action: "company.known_failing_policy_changed", actor: { id: OMAR.developerId }, facts: { fromAlwaysTwo: false, toAlwaysTwo: true, mode: "direct" } });
  });

  it("refuses a body that is not one of the two actions, with field names only", async () => {
    const { t } = await bench();
    on();
    const reply = await t.web(OMAR, "POST", PATH, { action: "set", alwaysTwoPeople: "yes" });
    expect(reply.status).toBe(400);
    expect((await t.web(OMAR, "POST", PATH, { action: "approve" })).status).toBe(400);
    expect((await t.web(OMAR, "POST", PATH, { action: "set", alwaysTwoPeople: true, extra: 1 })).status).toBe(400);
  });
});

describe("turning it off", () => {
  async function withOn() {
    const made = await bench({ maya: "admin" });
    on();
    await made.t.web(OMAR, "POST", PATH, { action: "set", alwaysTwoPeople: true });
    return made;
  }

  it("opens a proposal that changes nothing, which the proposer cannot approve; a different admin approves it, audited", async () => {
    const { t, audit } = await withOn();
    const asked = await t.web(OMAR, "POST", PATH, { action: "set", alwaysTwoPeople: false });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const changeId = (asked.body as { changeId: string }).changeId;
    expect(await get(t)).toMatchObject({ body: { alwaysTwoPeople: true, pendingLoosening: true, pending: { changeId, proposedByYou: true } } });
    // A member sees that something is waiting, not what.
    expect((await get(t, MAYA)).body).toMatchObject({ pendingLoosening: true, pending: { proposedByYou: false } });
    const self = await t.web(OMAR, "POST", PATH, { action: "approve", changeId });
    expect(self.status).toBe(403);
    expect(JSON.stringify(self.body)).toContain("A different admin has to approve");
    expect(await get(t)).toMatchObject({ body: { alwaysTwoPeople: true } });
    const approved = await t.web(MAYA, "POST", PATH, { action: "approve", changeId });
    expect(approved, JSON.stringify(approved.body)).toMatchObject({ status: 200, body: { status: "applied", alwaysTwoPeople: false, pendingLoosening: false } });
    const events = policyEvents(audit);
    expect(events.map((event) => event.action)).toEqual(["company.known_failing_policy_changed", "company.known_failing_policy_proposed", "company.known_failing_policy_changed"]);
    expect(events.at(-1)).toMatchObject({ actor: { id: MAYA.developerId }, facts: { fromAlwaysTwo: true, toAlwaysTwo: false, mode: "second_person" } });
  });

  it("needs the approving admin to have signed in within the last 10 minutes; an older sign-in is asked to sign in again and nothing changes", async () => {
    const { t, audit } = await withOn();
    const asked = await t.web(OMAR, "POST", PATH, { action: "set", alwaysTwoPeople: false });
    const changeId = (asked.body as { changeId: string }).changeId;
    t.ageSignIn(MAYA, 11);
    const stale = await t.web(MAYA, "POST", PATH, { action: "approve", changeId });
    expect(stale.status, JSON.stringify(stale.body)).toBe(403);
    expect(JSON.stringify(stale.body)).toContain("REAUTH_REQUIRED");
    t.ageSignIn(MAYA, undefined);
    expect((await t.web(MAYA, "POST", PATH, { action: "approve", changeId })).status).toBe(403);
    expect(await get(t)).toMatchObject({ body: { alwaysTwoPeople: true, pendingLoosening: true } });
    expect(policyEvents(audit).map((event) => event.action)).toEqual(["company.known_failing_policy_changed", "company.known_failing_policy_proposed"]);
    t.ageSignIn(MAYA, 9);
    expect((await t.web(MAYA, "POST", PATH, { action: "approve", changeId })).status).toBe(200);
    expect(await get(t)).toMatchObject({ body: { alwaysTwoPeople: false } });
  });

  it("a member cannot approve, and a second proposal while one waits is refused", async () => {
    const { t } = await withOn();
    await t.person(MAYA, "member");
    const asked = await t.web(OMAR, "POST", PATH, { action: "set", alwaysTwoPeople: false });
    expect(asked.status).toBe(202);
    // A member is told that something waits, never which proposal.
    const seen = (await get(t, MAYA)).body;
    expect(seen).toMatchObject({ pendingLoosening: true });
    expect(seen).not.toHaveProperty("pending");
    expect((await t.web(MAYA, "POST", PATH, { action: "approve", changeId: (asked.body as { changeId: string }).changeId })).status).toBe(403);
    expect((await t.web(OMAR, "POST", PATH, { action: "set", alwaysTwoPeople: false })).status).toBe(409);
    expect((await get(t)).body).toMatchObject({ alwaysTwoPeople: true });
  });
});

describe("a company of one", () => {
  it("can turn it on but never off alone: the sole-owner exception does not apply", async () => {
    const { t } = await bench();
    on();
    await t.web(OMAR, "POST", PATH, { action: "set", alwaysTwoPeople: true });
    const asked = await t.web(OMAR, "POST", PATH, { action: "set", alwaysTwoPeople: false });
    expect(asked.status).toBe(202);
    const refused = await t.web(OMAR, "POST", PATH, { action: "approve", changeId: (asked.body as { changeId: string }).changeId });
    expect(refused.status).toBe(403);
    expect((await get(t)).body).toMatchObject({ alwaysTwoPeople: true });
  });
});
