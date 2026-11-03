// DG-3 (Opus review of diag-kit-fixes): what Rovara can spend on Fix with agent's light diagnoses in Public is a hard ceiling.
//   1. one Rovara-paid key per diagnosis (a retry or a redelivery mints nothing);
//   2. an install-wide daily ceiling across all companies, counted atomically, with a safe default and a packed setting;
//   3. the turn cap and the cents cap agree (the cents figure binds);
//   4. the UTC day comes from the broker's own clock only, and a clock a little ahead never resets a counter;
//   5. an erase never leaves an error blocked.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BROKER_SETTINGS, DIAGNOSIS_LIGHT_BUDGET_USD, DIAGNOSIS_RATE, DIAGNOSIS_REFUSALS, DIAGNOSIS_ROVARA_PAID_GLOBAL_DEFAULT_CENTS, DIAGNOSIS_ROVARA_PAID_ORG_LIMITS, ErrorRefSchema, diagnosisGlobalDayKey,
  diagnosisKey, diagnosisOpenKey, diagnosisRovaraPaidGlobalCents, errorRefKey, type OrgId,
} from "../../packages/contracts/src/index.js";
import { brokerSettingsFromEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { startLightDiagnosis } from "../../packages/broker/src/diagnosis/light.js";
import { admitDiagnosis, claimDiagnosisKey, eraseDiagnosisPerson, readDiagnosisRequest } from "../../packages/broker/src/diagnosis/store.js";
import { ARJUN, ORG_A, PRIYA, diagnosisWorld, type DiagnosisWorld } from "../support/diagnosis-world.js";

const DAY = 86_400_000;
const TURN_CENTS = Math.round(DIAGNOSIS_LIGHT_BUDGET_USD * 100);
const errorRef = (n: number) => ErrorRefSchema.parse({ kind: "operation_failed", code: `TASK_FAILED_${String(n)}`, subject: { taskId: randomUUID() }, at: "2026-10-22T09:00:00.000Z" });
const orgs = Array.from({ length: 12 }, (_, index) => `org_${String(index).padStart(2, "0")}${"a".repeat(18)}`);
const people = Array.from({ length: 12 }, (_, index) => `${String(index % 10)}${String(index)}`.padEnd(64, "a"));
const big = { turnsPerDay: 100_000, centsPerDay: 10_000_000 };

const admit = (w: DiagnosisWorld, orgId: OrgId, n: number, options: { global?: number; cap?: { turnsPerDay: number; centsPerDay: number }; who?: string } = {}) =>
  admitDiagnosis(w.diagnosis, {
    orgId, developerId: options.who ?? people[n % people.length]!, requestId: randomUUID(), tier: "light", errorRef: errorRef(n), project: `project-${String(n)}`,
    rovaraPaid: options.cap ?? big, ...(options.global === undefined ? {} : { rovaraPaidGlobalCentsPerDay: options.global }),
  });
const refused = (words: string) => expect.objectContaining({ code: "TOO_MANY_REQUESTS", message: expect.stringContaining(words) as string }) as unknown;
const today = (w: DiagnosisWorld) => new Date(w.w.clock.now).toISOString().slice(0, 10);
const globalCounter = (w: DiagnosisWorld, day = today(w)) => w.w.db.get(diagnosisGlobalDayKey(day));

describe("DG-3 one Rovara-paid key per diagnosis", () => {
  it("the first claim wins and every later one (a repeat of the call, a redelivery) is refused; another diagnosis has its own", async () => {
    const w = diagnosisWorld({ edition: "public" });
    const first = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    await expect(claimDiagnosisKey(w.diagnosis, ORG_A, first.diagnosisId)).resolves.toBe(true);
    await expect(claimDiagnosisKey(w.diagnosis, ORG_A, first.diagnosisId)).resolves.toBe(false);
    await expect(Promise.all([claimDiagnosisKey(w.diagnosis, ORG_A, first.diagnosisId), claimDiagnosisKey(w.diagnosis, ORG_A, first.diagnosisId)])).resolves.toEqual([false, false]);
    w.retried();
    const second = await startLightDiagnosis(w.diagnosis, w.caller(ARJUN), { requestId: randomUUID(), errorRef: w.ref() });
    await expect(claimDiagnosisKey(w.diagnosis, ORG_A, second.diagnosisId)).resolves.toBe(true);
  });

  it("two calls at the same moment cannot both take the key", async () => {
    const w = diagnosisWorld({ edition: "public" });
    const status = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    const results = await Promise.all(Array.from({ length: 6 }, () => claimDiagnosisKey(w.diagnosis, ORG_A, status.diagnosisId)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a diagnosis that is gone, answered or another org's cannot be claimed", async () => {
    const w = diagnosisWorld({ edition: "public" });
    const status = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    await expect(claimDiagnosisKey(w.diagnosis, "org_bbbbbbbbbbbbbbbbbbbb", status.diagnosisId)).resolves.toBe(false);
    await expect(claimDiagnosisKey(w.diagnosis, ORG_A, "dgn_zzzzzzzzzzzzzzzzzzzz")).resolves.toBe(false);
    const request = w.w.db.get(diagnosisKey(ORG_A, status.diagnosisId, "REQUEST"))!;
    request["state"] = "ready";
    await expect(claimDiagnosisKey(w.diagnosis, ORG_A, status.diagnosisId)).resolves.toBe(false);
  });
});

describe("DG-3 an install-wide daily ceiling across all companies", () => {
  it("counts every company's Rovara-paid turn (25 cents each) in one item for the UTC day, and refuses the turn that would pass the ceiling in its own words", async () => {
    const w = diagnosisWorld();
    for (let n = 0; n < 4; n += 1) await admit(w, orgs[n]!, n, { global: 100 });
    expect(globalCounter(w)).toMatchObject({ count: 4, cents: 100 });
    await expect(admit(w, orgs[5]!, 5, { global: 100 })).rejects.toEqual(refused(DIAGNOSIS_REFUSALS.globalRateLimited));
    expect(globalCounter(w)).toMatchObject({ count: 4, cents: 100 });
    // A refused request spent nothing anywhere: the company's own counter did not move either.
    const orgCounter = w.w.db.get({ pk: `ORG#${orgs[5]!}#DIAGNOSISRATE`, sk: "light_org#all" });
    expect(orgCounter).toBeUndefined();
  });

  it("holds under parallel requests from many companies: of eight at once, exactly the ones that fit are admitted", async () => {
    const w = diagnosisWorld();
    const results = await Promise.allSettled(orgs.slice(0, 8).map((orgId, n) => admit(w, orgId, n, { global: 100 })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    expect(globalCounter(w)).toMatchObject({ count: 4, cents: 100 });
  });

  it("the company's own ceiling, the person's and the project's are answered in their own words before the install-wide one", async () => {
    const w = diagnosisWorld();
    await admit(w, orgs[0]!, 0, { global: 25, cap: { turnsPerDay: 100, centsPerDay: 1_500 } });
    // The install is full, and so is this person: their own words.
    await expect(admit(w, orgs[1]!, 1, { global: 25, who: people[0]! })).rejects.toEqual(refused(DIAGNOSIS_REFUSALS.globalRateLimited));
    const small = { turnsPerDay: 1, centsPerDay: 1_500 };
    await admit(w, orgs[2]!, 2, { global: 1_000, cap: small });
    await expect(admit(w, orgs[2]!, 3, { global: 25, cap: small })).rejects.toEqual(refused(DIAGNOSIS_REFUSALS.orgRateLimited));
  });

  it("is counted for Public only: a request with no Rovara payment does not touch it", async () => {
    const w = diagnosisWorld();
    await admitDiagnosis(w.diagnosis, { orgId: orgs[0]!, developerId: people[0]!, requestId: randomUUID(), tier: "light", errorRef: errorRef(1), project: "web" });
    expect(globalCounter(w)).toBeUndefined();
  });

  it("an open diagnosis of the same error and a repeat of a request spend nothing against it", async () => {
    const w = diagnosisWorld({ edition: "public" });
    await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    await startLightDiagnosis(w.diagnosis, w.caller(ARJUN), { requestId: randomUUID(), errorRef: w.ref() });
    expect(globalCounter(w)).toMatchObject({ count: 1, cents: 25 });
  });

  it("has a safe default that the route uses when nothing is configured, and the dependencies' figure when it is", async () => {
    expect(DIAGNOSIS_ROVARA_PAID_GLOBAL_DEFAULT_CENTS).toBe(10_000);
    const w = diagnosisWorld({ edition: "public" });
    // Default: the ceiling is the contract's, so a day with 9,975 cents counted takes one more turn and not two.
    w.w.db.set({ ...diagnosisGlobalDayKey(today(w)), entityType: "DIAGNOSIS_RATE_GLOBAL", count: 399, cents: 9_975 });
    await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    expect(globalCounter(w)).toMatchObject({ count: 400, cents: 10_000 });
    w.retried();
    await expect(startLightDiagnosis(w.diagnosis, w.caller(ARJUN), { requestId: randomUUID(), errorRef: w.ref() })).rejects.toEqual(refused(DIAGNOSIS_REFUSALS.globalRateLimited));
    // Configured: 0 pauses Rovara-paid diagnoses altogether, and queues nothing.
    const paused = diagnosisWorld({ edition: "public" });
    paused.diagnosis.rovaraPaidGlobalCents = 0;
    await expect(startLightDiagnosis(paused.diagnosis, paused.caller(PRIYA), { requestId: randomUUID(), errorRef: paused.ref() })).rejects.toEqual(refused(DIAGNOSIS_REFUSALS.globalRateLimited));
    expect(paused.sent).toHaveLength(0);
    expect(globalCounter(paused)).toBeUndefined();
  });

  it("the Enterprise edition (the customer pays) never counts against it", async () => {
    const w = diagnosisWorld({ edition: "enterprise" });
    w.diagnosis.rovaraPaidGlobalCents = 0;
    await expect(startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() })).resolves.toMatchObject({ state: "queued" });
    expect(globalCounter(w)).toBeUndefined();
  });

  it("logs the day's spend as a share of the ceiling, which the 80 percent alarm watches", async () => {
    const w = diagnosisWorld();
    const lines: Array<Record<string, unknown>> = [];
    w.diagnosis.log = (entry) => { lines.push(entry); };
    await admit(w, orgs[0]!, 0, { global: 100 });
    await admit(w, orgs[1]!, 1, { global: 100 });
    await admit(w, orgs[2]!, 2, { global: 100 });
    await admit(w, orgs[3]!, 3, { global: 100 });
    const paid = lines.filter((line) => line["event"] === "diagnosis.rovara_paid");
    expect(paid.map((line) => line["globalDayPercent"])).toEqual([25, 50, 75, 100]);
    await expect(admit(w, orgs[4]!, 4, { global: 100 })).rejects.toThrow();
    expect(lines.some((line) => line["event"] === "diagnosis.rovara_paid_global_full")).toBe(true);
  });
});

describe("DG-3 the ceiling's setting", () => {
  it("is a whole number of cents, and anything else is the default (never unlimited)", () => {
    expect(diagnosisRovaraPaidGlobalCents("2500")).toBe(2_500);
    expect(diagnosisRovaraPaidGlobalCents("0")).toBe(0);
    expect(diagnosisRovaraPaidGlobalCents("1000000")).toBe(1_000_000);
    for (const bad of [undefined, "", "-5", "1.5", "1e9", "1000001", "99999999", " 5", "abc", "0x10"]) expect(diagnosisRovaraPaidGlobalCents(bad), String(bad)).toBe(DIAGNOSIS_ROVARA_PAID_GLOBAL_DEFAULT_CENTS);
  });

  it("is a packed broker setting (AGENTX_SETTINGS, code fg), not a Lambda variable of its own", () => {
    expect(BROKER_SETTINGS.liveFixRovaraPaidCents).toEqual({ code: "fg", variable: "LIVE_FIX_ROVARA_PAID_DAILY_CENTS" });
    const read = brokerSettingsFromEnvironment({ AGENTX_SETTINGS: "fd=1,fg=2500" });
    expect(read.find((entry) => entry.spec.code === "fg")).toMatchObject({ value: "2500", spec: { variable: "LIVE_FIX_ROVARA_PAID_DAILY_CENTS" } });
  });
});

describe("DG-3 which cap binds", () => {
  it("the cents figure binds: a turn is counted at its key's full cap, so $15 ends the day at 60 turns and the 100-turn figure is only a backstop", () => {
    const binding = Math.floor(DIAGNOSIS_ROVARA_PAID_ORG_LIMITS.centsPerDay / TURN_CENTS);
    expect(binding).toBe(60);
    expect(binding).toBeLessThan(DIAGNOSIS_ROVARA_PAID_ORG_LIMITS.turnsPerDay);
    // The install-wide default is a whole number of turns too, and is at least one company's day.
    expect(DIAGNOSIS_ROVARA_PAID_GLOBAL_DEFAULT_CENTS % TURN_CENTS).toBe(0);
    expect(DIAGNOSIS_ROVARA_PAID_GLOBAL_DEFAULT_CENTS).toBeGreaterThanOrEqual(DIAGNOSIS_ROVARA_PAID_ORG_LIMITS.centsPerDay);
  });

  it("in the store: with the contract's limits a company is refused at the 61st turn by cents, not at the 100th by count", async () => {
    const w = diagnosisWorld();
    for (let n = 0; n < 60; n += 1) await admit(w, orgs[0]!, n, { cap: DIAGNOSIS_ROVARA_PAID_ORG_LIMITS, who: people[n % 12]!, global: 1_000_000 }).catch((error: unknown) => { throw new Error(`turn ${String(n + 1)} refused: ${String(error)}`); });
    const counter = w.w.db.get({ pk: `ORG#${orgs[0]!}#DIAGNOSISRATE`, sk: "light_org#all" });
    expect(counter).toMatchObject({ count: 60, cents: 1_500 });
  });
});

describe("DG-3 the UTC day is the broker's own clock, and a clock ahead never resets a counter", () => {
  const orgKey = (orgId: OrgId) => ({ pk: `ORG#${orgId}#DIAGNOSISRATE`, sk: "light_org#all" });

  it("the install-wide day changes exactly at UTC midnight: 23:59:59.999 is one item and 00:00:00.000 the next", async () => {
    const w = diagnosisWorld();
    const midnight = Math.ceil(w.w.clock.now / DAY) * DAY;
    w.w.clock.now = midnight - 1;
    await admit(w, orgs[0]!, 0, { global: 100 });
    w.w.clock.now = midnight;
    await admit(w, orgs[1]!, 1, { global: 100 });
    expect(globalCounter(w, new Date(midnight - 1).toISOString().slice(0, 10))).toMatchObject({ count: 1, cents: 25 });
    expect(globalCounter(w, new Date(midnight).toISOString().slice(0, 10))).toMatchObject({ count: 1, cents: 25 });
    // The day before is not reopened by anything that happens on the next, and the new day starts from nothing.
    for (let n = 2; n < 5; n += 1) await admit(w, orgs[n]!, n, { global: 100 });
    await expect(admit(w, orgs[6]!, 6, { global: 100 })).rejects.toThrow();
    w.w.clock.now = midnight + DAY;
    await expect(admit(w, orgs[6]!, 7, { global: 100 })).resolves.toMatchObject({ created: true });
  });

  it("an instance whose clock is a second ahead has already written the next day's window: an instance on time keeps counting in it, and the company's day is not reset", async () => {
    const w = diagnosisWorld();
    const midnight = Math.ceil(w.w.clock.now / DAY) * DAY;
    const cap = { turnsPerDay: 100, centsPerDay: 75 };
    // Two turns on the old day, on time.
    w.w.clock.now = midnight - 5_000;
    await admit(w, orgs[0]!, 0, { cap, global: 100_000 });
    await admit(w, orgs[0]!, 1, { cap, global: 100_000 });
    // A fast instance (its clock is 2 s past midnight) writes the next window.
    w.w.clock.now = midnight + 1_000;
    await admit(w, orgs[0]!, 2, { cap, global: 100_000 });
    expect(w.w.db.get(orgKey(orgs[0]!))).toMatchObject({ windowStart: midnight, count: 1, cents: 25 });
    // An instance on time (1 s before midnight) must not take that as an old window and start again from zero.
    w.w.clock.now = midnight - 1_000;
    await admit(w, orgs[0]!, 3, { cap, global: 100_000 });
    await admit(w, orgs[0]!, 4, { cap, global: 100_000 });
    expect(w.w.db.get(orgKey(orgs[0]!))).toMatchObject({ windowStart: midnight, count: 3, cents: 75 });
    await expect(admit(w, orgs[0]!, 5, { cap, global: 100_000 })).rejects.toEqual(refused(DIAGNOSIS_REFUSALS.orgRateLimited));
  });

  it("the person's hour and the project's day are kept the same way", async () => {
    const w = diagnosisWorld();
    const hour = 3_600_000;
    const nextHour = Math.ceil(w.w.clock.now / hour) * hour;
    const person = people[0]!;
    const personKey = { pk: `ORG#${orgs[0]!}#DIAGNOSISRATE`, sk: `light_person#${person}` };
    w.w.clock.now = nextHour + 500;
    for (let n = 0; n < DIAGNOSIS_RATE.lightPerPersonPerHour; n += 1) await admit(w, orgs[0]!, n, { who: person });
    expect(w.w.db.get(personKey)).toMatchObject({ windowStart: nextHour, count: DIAGNOSIS_RATE.lightPerPersonPerHour });
    // The same person, on an instance whose clock is just before that hour: still the same hour, so still full.
    w.w.clock.now = nextHour - 500;
    await expect(admit(w, orgs[0]!, 50, { who: person })).rejects.toEqual(refused(DIAGNOSIS_REFUSALS.rateLimited));
    expect(w.w.db.get(personKey)).toMatchObject({ windowStart: nextHour, count: DIAGNOSIS_RATE.lightPerPersonPerHour });
  });

  it("a window that is far ahead (not skew) is not trusted: the counter starts again in this instance's own window", async () => {
    const w = diagnosisWorld();
    const day = Math.floor(w.w.clock.now / DAY) * DAY;
    w.w.db.set({ ...orgKey(orgs[0]!), entityType: "DIAGNOSIS_RATE", orgId: orgs[0]!, windowStart: day + 5 * DAY, count: 100, cents: 1_500 });
    await expect(admit(w, orgs[0]!, 0, { cap: DIAGNOSIS_ROVARA_PAID_ORG_LIMITS, global: 100_000 })).resolves.toMatchObject({ created: true });
    expect(w.w.db.get(orgKey(orgs[0]!))).toMatchObject({ windowStart: day, count: 1, cents: 25 });
  });

  it("takes the day from the broker's clock only: the request carries no time the counters read", async () => {
    // The start body is strict (a request id and the error reference the app showed); nothing in it is a time.
    const w = diagnosisWorld({ edition: "public" });
    await expect(startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref(), now: Date.now() + 5 * DAY })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("DG-3 erase never leaves an error blocked", () => {
  const openOf = (w: DiagnosisWorld, errorRefValue = w.ref()) => w.w.db.get(diagnosisOpenKey(ORG_A, "light", errorRefKey(errorRefValue)));
  const blocked = (w: DiagnosisWorld) => { const open = openOf(w); return open !== undefined && (open["expiresAt"] as number) > w.w.clock.now; };

  it("frees the error's open place together with the request, so the error can be asked about again at once", async () => {
    const w = diagnosisWorld();
    await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    expect(blocked(w)).toBe(true);
    await eraseDiagnosisPerson(w.diagnosis, ORG_A, PRIYA);
    expect(blocked(w)).toBe(false);
    const again = await startLightDiagnosis(w.diagnosis, w.caller(ARJUN), { requestId: randomUUID(), errorRef: w.ref() });
    expect(again.state).toBe("queued");
    expect(w.sent).toHaveLength(2);
  });

  it("a pass that cannot read the request stops there: nothing is deleted, the index stays, and the next pass finishes it", async () => {
    const w = diagnosisWorld();
    const status = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    const real = w.w.db;
    let failReads = true;
    const flaky = { send: async (command: { constructor: { name: string }; input?: { Key?: { sk?: string } } }) => {
      if (failReads && command.constructor.name === "GetCommand" && command.input?.Key?.sk === "REQUEST") throw new Error("throttled");
      return real.send(command as never);
    } };
    await expect(eraseDiagnosisPerson({ documentClient: flaky, tableName: "state" }, ORG_A, PRIYA)).rejects.toThrow("throttled");
    expect(real.get(diagnosisKey(ORG_A, status.diagnosisId, "REQUEST"))).toBeDefined();
    expect([...real.items.keys()].some((key) => key.includes(`DIAGNOSISBY#${PRIYA}`))).toBe(true);
    failReads = false;
    await expect(eraseDiagnosisPerson({ documentClient: flaky, tableName: "state" }, ORG_A, PRIYA)).resolves.toMatchObject({ complete: true, removed: 1 });
    expect(blocked(w)).toBe(false);
    expect(real.get(diagnosisKey(ORG_A, status.diagnosisId, "REQUEST"))).toBeUndefined();
  });

  it("a pass that fails while letting go of the place stops there (the place is not left behind a deleted request)", async () => {
    const w = diagnosisWorld();
    const status = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    const real = w.w.db;
    let failUpdates = true;
    const flaky = { send: async (command: { constructor: { name: string } }) => {
      if (failUpdates && command.constructor.name === "UpdateCommand") throw new Error("throttled");
      return real.send(command as never);
    } };
    await expect(eraseDiagnosisPerson({ documentClient: flaky, tableName: "state" }, ORG_A, PRIYA)).rejects.toThrow("throttled");
    expect(real.get(diagnosisKey(ORG_A, status.diagnosisId, "REQUEST"))).toBeDefined();
    failUpdates = false;
    await eraseDiagnosisPerson({ documentClient: flaky, tableName: "state" }, ORG_A, PRIYA);
    expect(blocked(w)).toBe(false);
  });

  it("a pass that stops after the place was freed and before the request went is finished by the next one, and the place is never left held", async () => {
    const w = diagnosisWorld();
    const status = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    const real = w.w.db;
    let stop = true;
    const flaky = { send: async (command: { constructor: { name: string }; input?: { Key?: { sk?: string } } }) => {
      if (stop && command.constructor.name === "DeleteCommand" && command.input?.Key?.sk === "REQUEST") throw new Error("lambda timed out");
      return real.send(command as never);
    } };
    await expect(eraseDiagnosisPerson({ documentClient: flaky, tableName: "state" }, ORG_A, PRIYA)).rejects.toThrow("lambda timed out");
    expect(blocked(w)).toBe(false);
    stop = false;
    await expect(eraseDiagnosisPerson({ documentClient: flaky, tableName: "state" }, ORG_A, PRIYA)).resolves.toMatchObject({ complete: true });
    expect(await readDiagnosisRequest(w.diagnosis, ORG_A, status.diagnosisId)).toBeUndefined();
  });

  it("does not free a place that now belongs to another diagnosis of the same error", async () => {
    const w = diagnosisWorld();
    const first = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    // The first one is over (its place let go) and another person asks about the same error.
    w.w.db.get(diagnosisKey(ORG_A, first.diagnosisId, "REQUEST"))!["state"] = "failed";
    openOf(w)!["expiresAt"] = 0;
    const second = await startLightDiagnosis(w.diagnosis, w.caller(ARJUN), { requestId: randomUUID(), errorRef: w.ref() });
    expect(second.diagnosisId).not.toBe(first.diagnosisId);
    await eraseDiagnosisPerson(w.diagnosis, ORG_A, PRIYA);
    expect(openOf(w)).toMatchObject({ diagnosisId: second.diagnosisId });
    expect(blocked(w)).toBe(true);
  });
});
