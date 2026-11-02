// Lane team-record-links: `/v1/app/org/tracker-people`, the admin's page for the Linear and Jira people the automatic linker could not match. The runtime's behaviour is proved in
// tests/unit/team-record-wiring/tracker-people.test.ts; here is the ROUTE: who may read and change, from where, how fresh a sign-in, what a body may say, and what each answer is.
import { describe, expect, it, vi } from "vitest";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { errorOf, setupWizardBench } from "../support/setup-wizard-testenv.js";

const PATH = "/v1/app/org/tracker-people";
const REQ = "8f3f2f5e-1c1b-4a53-9d0c-0b1f2a3b4c5d";

function fakePeople() {
  return {
    list: vi.fn(async () => ({
      unmatched: [{ system: "linear", sourceId: "lin-sam", displayName: "Sam K", seenAt: "2026-11-02T10:00:00.000Z" }, { system: "jira:acme.atlassian.net", sourceId: "acc-9", displayName: "Nine", seenAt: "2026-11-02T10:00:00.000Z" }],
      linked: [{ system: "linear", sourceId: "lin-priya", developerId: "dev-priya", displayName: "Priya R", via: "admin", at: "2026-11-02T10:00:00.000Z" }],
      truncated: false,
    })),
    map: vi.fn(async (): Promise<"mapped" | "not_found" | "not_member" | "audit_unavailable"> => "mapped"),
    unmap: vi.fn(async (): Promise<"unmapped" | "not_found" | "audit_unavailable"> => "unmapped"),
    syncConnection: vi.fn(async () => undefined),
  };
}
async function bench(options: { maya?: "admin" | "member" } = {}) {
  const people = fakePeople();
  const t = await setupWizardBench({ trackerPeople: people });
  if (options.maya !== undefined) await t.person(MAYA, options.maya);
  return { t, people };
}
const mapBody = { action: "map", requestId: REQ, system: "linear", sourceId: "lin-sam", developerId: "dev-sam" };

describe("the Team record is off", () => {
  it("is not found for a read and a change", async () => {
    const t = await setupWizardBench({ teamRecord: false });
    expect((await t.web(OMAR, "GET", PATH)).status).toBe(404);
    expect((await t.web(OMAR, "POST", PATH, mapBody)).status).toBe(404);
  });
});

describe("reading", () => {
  it("is for an owner or admin; a member is refused; the answer holds names, tool ids and member ids and nothing else", async () => {
    const { t, people } = await bench({ maya: "member" });
    const read = await t.web(OMAR, "GET", PATH);
    expect(read.status).toBe(200);
    const { requestId: _requestId, ...answer } = read.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the web boundary's own request id
    expect(answer).toStrictEqual({
      unmatched: [{ tool: "Linear", system: "linear", sourceId: "lin-sam", displayName: "Sam K" }, { tool: "Jira", system: "jira:acme.atlassian.net", sourceId: "acc-9", displayName: "Nine" }],
      linked: [{ tool: "Linear", system: "linear", sourceId: "lin-priya", displayName: "Priya R", developerId: "dev-priya", via: "admin" }],
      truncated: false,
    });
    expect(people.list).toHaveBeenCalledWith(expect.stringMatching(/^org_/));
    const member = await t.web(MAYA, "GET", PATH);
    expect(member.status).toBe(403);
    expect(people.list).toHaveBeenCalledTimes(1);
  });
});

describe("changing", () => {
  it("is refused from a token and from a member in a browser, and changes nothing", async () => {
    const { t, people } = await bench({ maya: "member" });
    const token = await t.dev(OMAR, "POST", PATH, mapBody);
    expect(token.status).toBe(403);
    expect(JSON.stringify(token.body)).toContain("Use a live browser session");
    expect((await t.web(MAYA, "POST", PATH, mapBody)).status).toBe(403);
    expect(people.map).not.toHaveBeenCalled();
  });

  it("needs a sign-in within the last 10 minutes: an old one, or none, is REAUTH_REQUIRED, and nothing is changed", async () => {
    const { t, people } = await bench();
    t.ageSignIn(OMAR, 11);
    const old = await t.web(OMAR, "POST", PATH, mapBody);
    expect(old.status, JSON.stringify(old.body)).toBe(403);
    expect(JSON.stringify(old.body)).toContain("REAUTH_REQUIRED");
    t.ageSignIn(OMAR, undefined);
    expect(JSON.stringify((await t.web(OMAR, "POST", PATH, mapBody)).body)).toContain("REAUTH_REQUIRED");
    expect(people.map).not.toHaveBeenCalled();
    t.ageSignIn(OMAR, 2);
    expect((await t.web(OMAR, "POST", PATH, mapBody)).status).toBe(200);
  });

  it("maps with the caller's own org and id (never taken from the body), and unmaps", async () => {
    const { t, people } = await bench();
    expect(await t.web(OMAR, "POST", PATH, mapBody)).toMatchObject({ status: 200, body: { status: "mapped" } });
    expect(people.map).toHaveBeenCalledWith(expect.stringMatching(/^org_/), { system: "linear", sourceId: "lin-sam", developerId: "dev-sam", by: OMAR.developerId, requestId: REQ });
    expect(await t.web(OMAR, "POST", PATH, { action: "unmap", requestId: REQ, system: "linear", sourceId: "lin-priya" })).toMatchObject({ status: 200, body: { status: "unmapped" } });
    expect(people.unmap).toHaveBeenCalledWith(expect.stringMatching(/^org_/), { system: "linear", sourceId: "lin-priya", by: OMAR.developerId, requestId: REQ });
  });

  it("answers each outcome in fixed words", async () => {
    const { t, people } = await bench();
    people.map.mockResolvedValueOnce("not_found");
    expect(errorOf(await t.web(OMAR, "POST", PATH, mapBody)).code).toBe("NOT_FOUND");
    people.map.mockResolvedValueOnce("not_member");
    const notMember = await t.web(OMAR, "POST", PATH, mapBody);
    expect(notMember.status).toBe(400);
    expect(errorOf(notMember).message).toContain("pick a member of your company");
    people.map.mockResolvedValueOnce("audit_unavailable");
    expect(errorOf(await t.web(OMAR, "POST", PATH, mapBody)).code).toBe("AUDIT_UNAVAILABLE");
    people.unmap.mockResolvedValueOnce("not_found");
    expect(errorOf(await t.web(OMAR, "POST", PATH, { action: "unmap", requestId: REQ, system: "linear", sourceId: "lin-x" })).code).toBe("NOT_FOUND");
  });

  it("refuses a body that is not one of the two actions, with field names only", async () => {
    const { t, people } = await bench();
    for (const body of [
      { ...mapBody, orgId: "org_aaaaaaaaaaaaaaaaaaaa" }, { ...mapBody, system: "slack:T1" }, { ...mapBody, requestId: "not-a-uuid" }, { ...mapBody, sourceId: "has space" },
      { action: "unmap", requestId: REQ, system: "linear" }, { action: "mapp" }, {},
    ]) {
      const reply = await t.web(OMAR, "POST", PATH, body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(reply.body)).not.toContain("has space");
    }
    expect(people.map).not.toHaveBeenCalled();
  });
});
