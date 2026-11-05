// 057 lane, register SRL-9: the record's hourly and per-minute rate items keep a developer id in their sort key (`RATE#search|person:<id>#<window>`, `RATE#source-options|person:<id>#<window>`).
// Person erase must remove them. The positive control: the real limiter wrote them, so the test follows the writer's own key shape.
import { createHash } from "node:crypto";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { teamRecordPk } from "@agentx/contracts";
import { erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { dynamoRateLimiter } from "../../../packages/broker/src/team-record/query.js";
import { PERSON_FIELDS } from "../../../packages/broker/src/team-record/person-fields.js";
import { ORG_A, ORG_B, world } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const rateKeys = (w: ReturnType<typeof world>) => w.db.find((item) => typeof item.sk === "string" && item.sk.startsWith("RATE#")).map((item) => `${item.pk as string}|${item.sk as string}`);
const withDev = (keys: string[], developerId: string) => keys.filter((key) => key.includes(developerId));

async function seed(w: ReturnType<typeof world>): Promise<void> {
  const limiter = dynamoRateLimiter(w.table, () => w.clock.ms);
  for (const what of ["search", "facts", "past_work", "stats"]) {
    await limiter.take(`${ORG_A}|${what}|person:dev-1`, 120, 3_600);
    await limiter.take(`${ORG_A}|${what}|person:dev-2`, 120, 3_600);
  }
  await limiter.take(`${ORG_A}|source-options|person:dev-1`, 12, 60);
  await limiter.take(`${ORG_A}|source-options|person:dev-2`, 12, 60);
  // what is not a person: a task's key, a project's shared key, the company's own page counters
  await limiter.take(`${ORG_A}|search|task:tsk_1`, 60, 3_600);
  await limiter.take(`${ORG_A}|search|shared:web`, 60, 3_600);
  await limiter.take(`${ORG_A}|source-options-slack|org`, 60, 60);
  // the same developer id in another company
  await limiter.take(`${ORG_B}|search|person:dev-1`, 120, 3_600);
}

describe("SRL-9 person erase removes the rate items that carry the developer id", () => {
  it("removes every search, facts, past-work, stats and picker item of the person, and nothing of anyone else", async () => {
    const w = world();
    await seed(w);
    // positive control: the writer did put the id in the key
    expect(withDev(rateKeys(w), "person:dev-1").length).toBe(6);
    const d = deleteDeps(w);
    const result = await erasePerson(d.deps, ORG_A, { developerId: "dev-1" }, "erase-rate-1");
    expect(result.complete).toBe(true);
    expect(result.steps?.config).toBe(true);
    const left = rateKeys(w);
    expect(withDev(left.filter((key) => key.startsWith(`${teamRecordPk(ORG_A)}|`)), "dev-1")).toEqual([]);
    // other people, tasks, the project's key, the company's counter and the other company's item are untouched
    expect(withDev(left, "person:dev-2").length).toBe(5);
    expect(left.some((key) => key.includes("task:tsk_1"))).toBe(true);
    expect(left.some((key) => key.includes("shared:web"))).toBe(true);
    expect(left.some((key) => key.includes("source-options-slack|org"))).toBe(true);
    expect(left.filter((key) => key.startsWith(`${teamRecordPk(ORG_B)}|`)).length).toBe(1);
  });

  it("the second pass removes an item a request wrote after the first pass", async () => {
    const w = world();
    const d = deleteDeps(w);
    await erasePerson(d.deps, ORG_A, { developerId: "dev-1" }, "erase-rate-2");
    await dynamoRateLimiter(w.table, () => w.clock.ms).take(`${ORG_A}|search|person:dev-1`, 120, 3_600);
    expect(withDev(rateKeys(w), "person:dev-1").length).toBe(1);
    await erasePerson(d.deps, ORG_A, { developerId: "dev-1" }, "erase-rate-2", undefined, { sweep: true });
    expect(withDev(rateKeys(w), "person:dev-1")).toEqual([]);
  });

  it("a person known only by a source identity has no rate items to remove (and nothing else is removed)", async () => {
    const w = world();
    await seed(w);
    const before = rateKeys(w).length;
    await erasePerson(deleteDeps(w).deps, ORG_A, { identities: [{ system: "slack.com", sourceId: "U123" }] }, "erase-rate-3");
    expect(rateKeys(w).length).toBe(before);
  });

  it("the registry says rate items hold a developer id and are erased by a step", () => {
    const entry = PERSON_FIELDS.find((field) => field.path.includes("RATE#"));
    expect(entry).toMatchObject({ store: "hot", step: "config" });
  });

  it("an id that merely starts with the person's, or contains # (dev-10, dev-1#x), keeps its items", async () => {
    const w = world();
    const limiter = dynamoRateLimiter(w.table, () => w.clock.ms);
    for (const id of ["dev-1", "dev-10", "dev-1#x"]) { await limiter.take(`${ORG_A}|search|person:${id}`, 120, 3_600); await limiter.take(`${ORG_A}|source-options|person:${id}`, 12, 60); }
    expect(rateKeys(w).length).toBe(6);
    await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-1" }, "erase-rate-4");
    const left = rateKeys(w);
    expect(left.length).toBe(4);
    expect(left.filter((key) => key.includes("person:dev-1#x#")).length).toBe(2);
    expect(left.filter((key) => key.includes("person:dev-10#")).length).toBe(2);
    expect(left.some((key) => key.includes("person:dev-1#") && !key.includes("person:dev-1#x#"))).toBe(false);
  });

  it("walks past the first page: 1,200 items of the person are all removed", async () => {
    const w = world();
    for (let n = 0; n < 1_200; n += 1) w.db.set({ pk: teamRecordPk(ORG_A), sk: `RATE#search|person:dev-1#${String(10_000 + n)}`, count: 1, indexExpiresAt: 9_999_999_999 });
    w.db.set({ pk: teamRecordPk(ORG_A), sk: "RATE#search|person:dev-2#1", count: 1, indexExpiresAt: 9_999_999_999 });
    const result = await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-1" }, "erase-rate-5");
    expect(result.steps?.config).toBe(true);
    expect(rateKeys(w)).toEqual([`${teamRecordPk(ORG_A)}|RATE#search|person:dev-2#1`]);
  });

  it("a failed delete fails the config step (privacy over best effort) and the next run finishes it", async () => {
    const w = world();
    await seed(w);
    const d = deleteDeps(w);
    const real = w.table.documentClient;
    let broken = true;
    const flaky = { ...d.deps, table: { ...w.table, documentClient: { send: async (command: unknown) => {
      if (broken && command instanceof DeleteCommand && String((command.input.Key as { sk?: unknown }).sk).startsWith("RATE#")) throw new Error("table unavailable");
      return real.send(command);
    } } as never } };
    const first = await erasePerson(flaky, ORG_A, { developerId: "dev-1" }, "erase-rate-6");
    expect(first.steps?.config).toBe(false);
    expect(first.complete).toBe(false);
    broken = false;
    const second = await erasePerson(flaky, ORG_A, { developerId: "dev-1" }, "erase-rate-6");
    expect(second.steps?.config).toBe(true);
    expect(withDev(rateKeys(w).filter((key) => key.startsWith(`${teamRecordPk(ORG_A)}|`)), "person:dev-1#")).toEqual([]);
  });
});

// Unkeyed hashes of enumerable ids are personal data. The formulas are written out again here (not imported), so the test notices if a writer changes its key.
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
describe("SRL-9 the picker sessions and the slack-add rate items are erased too", () => {
  const SLACK_A = "U0AAAAAAAA", SLACK_B = "U0BBBBBBBB";
  it("removes the sessions the person opened (by their hash) and the slack-add items of each of their Slack ids, and nobody else's", async () => {
    const w = world();
    const session = (org: typeof ORG_A, id: string, person: string | undefined) => w.db.set({ pk: teamRecordPk(org), sk: `SRCOPT#${id}`, entityType: "TEAM_RECORD_SOURCE_OPTIONS", kind: "slack-private", project: "web", ...(person === undefined ? {} : { person }), pages: 1, indexExpiresAt: 9_999_999_999 });
    session(ORG_A, "s1", sha(`source-options|${ORG_A}|dev-1`));
    session(ORG_A, "s2", sha(`source-options|${ORG_A}|dev-2`));
    session(ORG_A, "s3", undefined);
    session(ORG_B, "s4", sha(`source-options|${ORG_B}|dev-1`));
    const limiter = dynamoRateLimiter(w.table, () => w.clock.ms);
    const add = async (org: typeof ORG_A, user: string, channel: string) => limiter.take(`${org}|slack-add|${sha(`slack-add\0${org}\0${user}`)}|${channel}`, 1, 600);
    await add(ORG_A, SLACK_A, "C0CHAN001"); await add(ORG_A, SLACK_A, "C0CHAN002"); await add(ORG_A, SLACK_B, "C0CHAN001"); await add(ORG_B, SLACK_A, "C0CHAN001");
    expect(rateKeys(w).length).toBe(4);
    const result = await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: "dev-1", identities: [{ system: "slack:T1", sourceId: SLACK_A }] }, "erase-rate-7");
    expect(result.steps?.config).toBe(true);
    const sessions = w.db.find((item) => typeof item.sk === "string" && item.sk.startsWith("SRCOPT#")).map((item) => `${item.pk as string}|${item.sk as string}`).sort();
    expect(sessions).toEqual([`${teamRecordPk(ORG_A)}|SRCOPT#s2`, `${teamRecordPk(ORG_A)}|SRCOPT#s3`, `${teamRecordPk(ORG_B)}|SRCOPT#s4`].sort());
    const left = rateKeys(w);
    expect(left.length).toBe(2);
    expect(left.some((key) => key.startsWith(`${teamRecordPk(ORG_A)}|`) && key.includes(sha(`slack-add\0${ORG_A}\0${SLACK_B}`)))).toBe(true);
    expect(left.some((key) => key.startsWith(`${teamRecordPk(ORG_B)}|`))).toBe(true);
  });

  it("a Slack-only person (no developer id) still loses the slack-add items", async () => {
    const w = world();
    const limiter = dynamoRateLimiter(w.table, () => w.clock.ms);
    await limiter.take(`${ORG_A}|slack-add|${sha(`slack-add\0${ORG_A}\0${SLACK_A}`)}|C0CHAN001`, 1, 600);
    expect(rateKeys(w).length).toBe(1);
    await erasePerson(deleteDeps(w).deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: SLACK_A }, { system: "github.com", sourceId: "12345" }] }, "erase-rate-8");
    expect(rateKeys(w)).toEqual([]);
  });

  it("the registry names both", () => {
    const paths = PERSON_FIELDS.filter((field) => field.step === "config").map((field) => field.path).join("\n");
    expect(paths).toContain("SRCOPT#");
    expect(paths).toContain("RATE#slack-add");
  });
});
