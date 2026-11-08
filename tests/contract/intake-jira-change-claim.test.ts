// UX5 I1-R2: a Jira change id is used once per COMPANY. A real label-add that a person made, handed to a second project's hook (by someone who holds that hook's secret) must not start a task
// as that person. The claim is written only after Jira confirmed the change, so a made-up change id cannot use up a real one.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { intakeChangeKey, intakeItemIdOf, type CodeIntentRequest, type OrgId } from "@agentx/contracts";
import { ingestIntake, type IntakeCandidate, type IntakePorts } from "../../packages/broker/src/intake/engine.js";
import { claimIntakeChange } from "../../packages/broker/src/intake/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const MEMBER = "a".repeat(64);
const SITE = "https://acme.atlassian.net";

function world() {
  const db = new FakeDynamoDb();
  const clock = { now: Date.parse("2026-10-31T10:00:00.000Z") };
  const started: Array<{ orgId: OrgId; project: string; developerId: string }> = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const failNext: { error?: Error | undefined } = {};
  let tasks = 0;
  const ports: IntakePorts = {
    table: { documentClient: db, tableName: "state", now: () => clock.now },
    log: (event, fields) => { logs.push({ event, fields }); },
    memberOfAccount: async (_org, system, accountId) => (system === "jira" && accountId === "acct-dana" ? MEMBER : undefined),
    mayStart: async () => true,
    start: async (orgId, developerId, request: CodeIntentRequest) => {
      if (failNext.error !== undefined) { const error = failNext.error; failNext.error = undefined; throw error; }
      started.push({ orgId, project: request.project, developerId });
      tasks += 1;
      return { task: { taskId: `task-${String(tasks)}` }, sessionId: `ses_${String(tasks).padStart(20, "0")}` };
    },
    sessionOfTicket: async () => undefined,
  };
  return { db, clock, ports, started, logs, failNext };
}

const candidate = (over: Partial<IntakeCandidate> & { key?: string; change?: string } = {}): IntakeCandidate => {
  const key = over.key ?? "PAY-12";
  return {
    orgId: ORG, project: "web", channel: "jira", externalRef: { system: "jira", id: key, url: `${SITE}/browse/${key}` }, title: "Refunds fail", body: "Refunds fail.",
    actor: { kind: "person", accountId: "acct-dana", display: "Dana" }, act: { kind: "label", value: "rovara" },
    eventId: `jira:issue:10042:labeled:rovara:${over.change ?? "10124"}`, occurredAt: new Date(Date.parse("2026-10-31T10:00:00.000Z") - 5_000).toISOString(), ...over,
  };
};
const real = async () => "person" as const;

describe("a Jira change is used once per company (I1-R2)", () => {
  it("refuses the same change handed to a second project's hook in the company, and starts no second task", async () => {
    const w = world();
    expect(await ingestIntake(w.ports, candidate({ project: "web" }), { confirmActor: real })).toMatchObject({ outcome: "started" });
    const second = await ingestIntake(w.ports, candidate({ project: "api", key: "API-3" }), { confirmActor: real });
    expect(second).toEqual({ outcome: "skipped", reason: "change_replayed" });
    expect(w.started).toEqual([expect.objectContaining({ project: "web", developerId: MEMBER })]);
    expect(w.logs.filter((entry) => entry.event === "intake.change_replayed")).toEqual([{ event: "intake.change_replayed", fields: { orgId: ORG, project: "api", system: "jira" } }]);
  });

  it("refuses the same change for another ticket of the same project too", async () => {
    const w = world();
    await ingestIntake(w.ports, candidate(), { confirmActor: real });
    expect(await ingestIntake(w.ports, candidate({ key: "PAY-99" }), { confirmActor: real })).toEqual({ outcome: "skipped", reason: "change_replayed" });
    expect(w.started).toHaveLength(1);
  });

  it("allows the same change id in two different companies (it is a different Jira site's change)", async () => {
    const w = world();
    expect(await ingestIntake(w.ports, candidate(), { confirmActor: real })).toMatchObject({ outcome: "started" });
    expect(await ingestIntake(w.ports, candidate({ orgId: OTHER_ORG }), { confirmActor: real })).toMatchObject({ outcome: "started" });
    expect(w.started.map((entry) => entry.orgId)).toEqual([ORG, OTHER_ORG]);
  });

  it("allows the same change id on a different Jira site of one company", async () => {
    const w = world();
    await ingestIntake(w.ports, candidate(), { confirmActor: real });
    const other = candidate({ project: "api", key: "API-3" });
    other.externalRef = { system: "jira", id: "API-3", url: "https://other.atlassian.net/browse/API-3" };
    expect(await ingestIntake(w.ports, other, { confirmActor: real })).toMatchObject({ outcome: "started" });
  });

  it("keeps a retry of the same delivery to the same hook idempotent: one task, a duplicate, no error", async () => {
    const w = world();
    expect(await ingestIntake(w.ports, candidate(), { confirmActor: real })).toMatchObject({ outcome: "started" });
    expect(await ingestIntake(w.ports, candidate(), { confirmActor: real })).toMatchObject({ outcome: "duplicate" });
    expect(await ingestIntake(w.ports, candidate(), { confirmActor: real })).toMatchObject({ outcome: "duplicate" });
    expect(w.started).toHaveLength(1);
  });

  it("lets a second label of the same change on the same ticket through (one change may add several labels)", async () => {
    const w = world();
    await ingestIntake(w.ports, candidate(), { confirmActor: real });
    const again = candidate({ eventId: "jira:issue:10042:labeled:other:10124" });
    expect(await ingestIntake(w.ports, again, { confirmActor: real })).toMatchObject({ outcome: "duplicate" });
  });

  it("starts exactly one task when two deliveries of one change race, to two projects or to one", async () => {
    const twoProjects = world();
    const results = await Promise.all([
      ingestIntake(twoProjects.ports, candidate({ project: "web" }), { confirmActor: real }),
      ingestIntake(twoProjects.ports, candidate({ project: "api", key: "API-3" }), { confirmActor: real }),
    ]);
    expect(results.filter((outcome) => outcome.outcome === "started")).toHaveLength(1);
    expect(twoProjects.started).toHaveLength(1);
    const oneProject = world();
    await Promise.all([1, 2, 3].map(() => ingestIntake(oneProject.ports, candidate(), { confirmActor: real })));
    expect(oneProject.started).toHaveLength(1);
  });

  it("does not use a change up when the tracker did not confirm it (a made-up change id cannot burn a real one)", async () => {
    const w = world();
    expect(await ingestIntake(w.ports, candidate({ project: "api", key: "API-3" }), { confirmActor: async () => "unverified" })).toMatchObject({ outcome: "waiting", reason: "unverified" });
    expect(await ingestIntake(w.ports, candidate({ project: "web" }), { confirmActor: real })).toMatchObject({ outcome: "started" });
    expect(w.started).toHaveLength(1);
  });

  it("uses a change up when the member could not start in the first project (a replay into one they can is refused)", async () => {
    const w = world();
    w.ports.mayStart = async (_org, _developer, project) => project === "web";
    expect(await ingestIntake(w.ports, candidate({ project: "api", key: "API-3" }), { confirmActor: real })).toMatchObject({ outcome: "waiting", reason: "no_authority" });
    expect(await ingestIntake(w.ports, candidate({ project: "web" }), { confirmActor: real })).toEqual({ outcome: "skipped", reason: "change_replayed" });
    expect(w.started).toEqual([]);
  });

  it("gives the change back when the start has a fault that may pass, so the redelivery starts the task", async () => {
    const w = world();
    w.failNext.error = Object.assign(new Error("away"), { statusCode: 503 });
    await expect(ingestIntake(w.ports, candidate(), { confirmActor: real })).rejects.toThrow("away");
    expect(await ingestIntake(w.ports, candidate({ project: "web" }), { confirmActor: real })).toMatchObject({ outcome: "started" });
    expect(w.started).toHaveLength(1);
  });

  it("keeps the claim for longer than the 24 hour replay window, and keys it by company, site and change", async () => {
    const w = world();
    await ingestIntake(w.ports, candidate(), { confirmActor: real });
    const key = intakeChangeKey(ORG, "jira", "acme.atlassian.net", "10124");
    const stored = (await w.db.send(new GetCommand({ TableName: "state", Key: key }))) as { Item?: Record<string, unknown> };
    expect(stored.Item).toMatchObject({ entityType: "INTAKE_CHANGE", project: "web", itemId: intakeItemIdOf("jira", "PAY-12") });
    expect(Number(stored.Item?.["indexExpiresAt"])).toBeGreaterThan(w.clock.now / 1000 + 2 * 86_400);
    expect(intakeChangeKey(ORG, "jira", "acme.atlassian.net", "10124")).not.toEqual(intakeChangeKey(OTHER_ORG, "jira", "acme.atlassian.net", "10124"));
    expect(intakeChangeKey(ORG, "jira", "acme.atlassian.net", "10124")).not.toEqual(intakeChangeKey(ORG, "jira", "other.atlassian.net", "10124"));
    expect(await claimIntakeChange(w.ports.table, { orgId: ORG, system: "jira", site: "acme.atlassian.net", changeId: "10124", project: "api", itemId: intakeItemIdOf("jira", "API-3") })).toBe("taken");
  });

  it("asks nobody and claims nothing for an outsider's act", async () => {
    const w = world();
    let asked = 0;
    const outsider = candidate({ actor: { kind: "person", accountId: "acct-stranger" } });
    expect(await ingestIntake(w.ports, outsider, { confirmActor: async () => { asked += 1; return "person"; } })).toMatchObject({ outcome: "waiting", reason: "unlinked" });
    expect(asked).toBe(0);
  });
});
