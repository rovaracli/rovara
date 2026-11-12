// Owner decision 123: `/v1/app/org/private-addresses` through the whole broker, with the real second-person records. Owners and admins only; writes from a live browser only; adding is a proposal a DIFFERENT admin
// approves after a fresh sign-in (no sole-owner path); removing applies at once; every change is audited without hosts in its facts.
import { describe, expect, it } from "vitest";
import { privateAddressListDigest } from "@agentx/cloud-contracts";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { setupWizardBench, type Bench } from "../support/setup-wizard-testenv.js";

const PATH = "/v1/app/org/private-addresses";
async function bench(options: { maya?: "admin" | "member" } = {}) {
  const audit = capturingAuditDeps();
  const t = await setupWizardBench({ audit });
  if (options.maya !== undefined) await t.person(MAYA, options.maya);
  return { t, audit };
}
const events = (audit: ReturnType<typeof capturingAuditDeps>) => audit.recorded().filter((event) => event.action.startsWith("company.private_addresses_"));
const get = async (t: Bench, who = OMAR) => t.web(who, "GET", PATH);
const ENTRIES = ["nexus.corp.example:8081", "10.20.0.15:443"];
const DIGEST = privateAddressListDigest(ENTRIES);

describe("reading and writing", () => {
  it("is for owners and admins only, writes from a live browser only, and starts empty", async () => {
    const { t, audit } = await bench({ maya: "member" });
    expect(await get(t)).toMatchObject({ status: 200, body: { revision: 0, entries: [], max: 16, canChange: true } });
    expect((await get(t, MAYA)).status).toBe(403);
    expect((await t.web(MAYA, "POST", PATH, { action: "propose", expectedRevision: 0, entries: ENTRIES })).status).toBe(403);
    const token = await t.dev(OMAR, "POST", PATH, { action: "propose", expectedRevision: 0, entries: ENTRIES });
    expect(token.status).toBe(403);
    expect(JSON.stringify(token.body)).toContain("Use a live browser session");
    expect(events(audit)).toEqual([]);
  });

  it("refuses a refused entry by its position and code, never echoing it, and a body that is not one of the actions", async () => {
    const { t } = await bench();
    const reply = await t.web(OMAR, "POST", PATH, { action: "propose", expectedRevision: 0, entries: ["10.20.0.15:443", "secret-mirror.corp.example"] });
    expect(reply.status).toBe(400);
    expect(JSON.stringify(reply.body)).toContain("Entry 2 has no port");
    expect(JSON.stringify(reply.body)).not.toContain("secret-mirror");
    expect((await t.web(OMAR, "POST", PATH, { action: "propose", expectedRevision: 0, entries: ["169.254.169.254:80"] })).status).toBe(400);
    expect((await t.web(OMAR, "POST", PATH, { action: "approve", changeId: "x" })).status).toBe(400);
    expect((await t.web(OMAR, "POST", PATH, { action: "propose", expectedRevision: 0, entries: ENTRIES, extra: true })).status).toBe(400);
  });
});

describe("adding", () => {
  it("is a proposal the proposer cannot approve; a different admin with a fresh sign-in approves the digest they were shown, audited", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    const asked = await t.web(OMAR, "POST", PATH, { action: "propose", expectedRevision: 0, entries: ENTRIES });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    const changeId = (asked.body as { changeId: string }).changeId;
    expect((await get(t)).body).toMatchObject({ entries: [], pending: { changeId, digest: DIGEST, added: ["10.20.0.15:443", "nexus.corp.example:8081"], removed: [], proposedByYou: true } });
    expect((await get(t, MAYA)).body).toMatchObject({ pending: { changeId, proposedByYou: false } });
    const self = await t.web(OMAR, "POST", PATH, { action: "approve", changeId, expectedDigest: DIGEST });
    expect(self.status).toBe(403);
    expect(JSON.stringify(self.body)).toContain("A different owner or admin has to approve this");
    t.ageSignIn(MAYA, 11);
    const stale = await t.web(MAYA, "POST", PATH, { action: "approve", changeId, expectedDigest: DIGEST });
    expect(JSON.stringify(stale.body)).toContain("REAUTH_REQUIRED");
    t.ageSignIn(MAYA, 2);
    expect((await t.web(MAYA, "POST", PATH, { action: "approve", changeId, expectedDigest: privateAddressListDigest(["10.20.0.15:443"]) })).status).toBe(409);
    expect((await get(t)).body).toMatchObject({ revision: 0, entries: [] });
    const approved = await t.web(MAYA, "POST", PATH, { action: "approve", changeId, expectedDigest: DIGEST });
    expect(approved, JSON.stringify(approved.body)).toMatchObject({ status: 200, body: { status: "applied", revision: 1, entries: ["10.20.0.15:443", "nexus.corp.example:8081"], digest: DIGEST } });
    expect(approved.body).not.toHaveProperty("pending");
    const recorded = events(audit);
    expect(recorded.map((event) => event.action)).toEqual(["company.private_addresses_proposed", "company.private_addresses_changed"]);
    expect(recorded[1]).toMatchObject({ actor: { id: MAYA.developerId }, facts: { mode: "second_person", entryCount: 2, added: 2, removed: 0, revision: 1, listDigest: DIGEST } });
    for (const event of recorded) expect(JSON.stringify(event.facts)).not.toMatch(/nexus|10\.20|8081/u);
  });

  it("gives a company of one admin no way to add alone", async () => {
    const { t } = await bench();
    const asked = await t.web(OMAR, "POST", PATH, { action: "propose", expectedRevision: 0, entries: ["10.20.0.15:443"] });
    expect(asked.status).toBe(202);
    const refused = await t.web(OMAR, "POST", PATH, { action: "approve", changeId: (asked.body as { changeId: string }).changeId, expectedDigest: privateAddressListDigest(["10.20.0.15:443"]) });
    expect(refused.status).toBe(403);
    expect((await get(t)).body).toMatchObject({ entries: [] });
  });

  it("is withdrawn by its proposer; removing applies at once by one admin", async () => {
    const { t, audit } = await bench({ maya: "admin" });
    const first = await t.web(OMAR, "POST", PATH, { action: "propose", expectedRevision: 0, entries: ENTRIES });
    expect((await t.web(OMAR, "POST", PATH, { action: "withdraw", changeId: (first.body as { changeId: string }).changeId })).body).toMatchObject({ status: "withdrawn", entries: [] });
    const second = await t.web(OMAR, "POST", PATH, { action: "propose", expectedRevision: 0, entries: ENTRIES });
    await t.web(MAYA, "POST", PATH, { action: "approve", changeId: (second.body as { changeId: string }).changeId, expectedDigest: DIGEST });
    const removed = await t.web(OMAR, "POST", PATH, { action: "propose", expectedRevision: 1, entries: ["10.20.0.15:443"] });
    expect(removed).toMatchObject({ status: 200, body: { status: "applied", revision: 2, entries: ["10.20.0.15:443"] } });
    expect(events(audit).at(-1)).toMatchObject({ action: "company.private_addresses_changed", facts: { mode: "direct", removed: 1, added: 0 } });
    expect((await t.web(OMAR, "POST", PATH, { action: "propose", expectedRevision: 1, entries: [] })).status).toBe(409);
  });
});
