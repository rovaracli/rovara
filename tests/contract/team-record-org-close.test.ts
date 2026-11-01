// wire-team-record fix round 1, B2: the company's close runs the Team record's erase as a MANDATORY step. A failure stops the close (the company stays closing), and a fresh close finishes it.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { OrgId } from "../../packages/contracts/src/org.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const resolver = async (subject: { developerId: string }) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG);
const seed = async (h: Awaited<ReturnType<typeof createDeveloperTaskBroker>>) => {
  for (const [who, orgId] of [[MAYA, TEST_ORG], [OMAR, ORG_B]] as const) {
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId, role: "owner" });
  }
};

describe("closing a company with the Team record on", () => {
  it("stops the close when the record's erase cannot be started, and a repeat closes it after the erase was started", async () => {
    const calls: string[] = [];
    let failing = true;
    const teamRecord = { erase: { workspace: async (orgId: string) => { calls.push(orgId); if (failing) throw new Error("storage down"); }, project: async () => undefined, person: async () => undefined } };
    const h = await createDeveloperTaskBroker({ register: false, orgResolver: resolver, brokerExtra: { cloud: true, agents: { projectMembers: new FakeProjectMembers() }, teamRecord: teamRecord } });
    await seed(h);
    const first = await h.dev(MAYA, "POST", "/v1/app/org/leave", { requestId: randomUUID() });
    expect(first.status).not.toBe(200);
    expect(calls).toStrictEqual([TEST_ORG]);
    expect(h.db.get({ pk: `ORG#${TEST_ORG}`, sk: "META" }) ?? h.db.find((item) => item.orgId === TEST_ORG && item.closedAt !== undefined)[0]).not.toMatchObject({ closedAt: expect.anything() as unknown });
    failing = false;
    const second = await h.dev(MAYA, "POST", "/v1/app/org/leave", { requestId: randomUUID() });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({ orgClosed: true });
    expect(calls).toStrictEqual([TEST_ORG, TEST_ORG]);
  });

  it("closes as before when the record is off (no hook)", async () => {
    const h = await createDeveloperTaskBroker({ register: false, orgResolver: resolver, brokerExtra: { cloud: true, agents: { projectMembers: new FakeProjectMembers() } } });
    await seed(h);
    const left = await h.dev(MAYA, "POST", "/v1/app/org/leave", { requestId: randomUUID() });
    expect(left.body, JSON.stringify(left.body)).toMatchObject({ orgClosed: true });
  });
});

describe("the record's routes and archive hook reach the real /v1/app routes", () => {
  it("serves /v1/app/projects/{p}/record/* from the runtime for a member, with the org and project role of the session, and answers 404 when the record is off", async () => {
    const seen: Array<{ method: string; path: string; orgId: string; role: unknown }> = [];
    const teamRecord = { routes: async (request: { method: string; path: string; caller: { orgId: string; projectRole: unknown } }) => { seen.push({ method: request.method, path: request.path, orgId: request.caller.orgId, role: request.caller.projectRole }); return { status: 200, body: { sources: [] } }; }, erase: { project: async () => undefined } };
    const on = await createDeveloperTaskBroker({ register: true, orgResolver: resolver, brokerExtra: { cloud: true, agents: { projectMembers: new FakeProjectMembers() }, teamRecord: teamRecord } });
    await seed(on);
    const served = await on.dev(MAYA, "GET", "/v1/app/projects/payments/record/sources");
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    expect(served.body).toMatchObject({ sources: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", path: "/v1/app/projects/payments/record/sources", orgId: TEST_ORG });
    expect(seen[0]!.role).toBeDefined();
    const off = await createDeveloperTaskBroker({ register: true, orgResolver: resolver, brokerExtra: { cloud: true, agents: { projectMembers: new FakeProjectMembers() } } });
    await seed(off);
    expect((await off.dev(MAYA, "GET", "/v1/app/projects/payments/record/sources")).status).toBe(404);
  });
});
