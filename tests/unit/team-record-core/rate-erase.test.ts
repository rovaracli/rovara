// 057 lane, register SRL-9: the record's hourly and per-minute rate items keep a developer id in their sort key (`RATE#search|person:<id>#<window>`, `RATE#source-options|person:<id>#<window>`).
// Person erase must remove them. The positive control: the real limiter wrote them, so the test follows the writer's own key shape.
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
});
