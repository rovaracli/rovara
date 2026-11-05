// DG-3 (Opus review of diag-kit-fixes), after the owner's decision of 2026-11-03 that Rovara pays for no diagnosis (the install-wide Rovara-paid ceiling, the org counter and the `fg` setting are gone):
//   1. one model key per diagnosis (a retry or a redelivery mints nothing), now the company's key and the company's money;
//   2. the person's and the project's windows come from the broker's own clock only, and a clock a little ahead never resets a counter;
//   3. an erase never leaves an error blocked;
//   4. no counter of money is kept by Rovara: an admitted diagnosis writes the person, the project, the open place and the request, nothing else.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DIAGNOSIS_RATE, DIAGNOSIS_REFUSALS, ErrorRefSchema, diagnosisKey, diagnosisOpenKey, diagnosisRateKey, errorRefKey, type OrgId } from "../../packages/contracts/src/index.js";
import { startLightDiagnosis } from "../../packages/broker/src/diagnosis/light.js";
import { admitDiagnosis, claimDiagnosisKey, claimDiagnosisRetry, eraseDiagnosisPerson, readDiagnosisRequest } from "../../packages/broker/src/diagnosis/store.js";
import { ARJUN, ORG_A, PRIYA, diagnosisWorld, type DiagnosisWorld } from "../support/diagnosis-world.js";

const DAY = 86_400_000;
const errorRef = (n: number) => ErrorRefSchema.parse({ kind: "operation_failed", code: `TASK_FAILED_${String(n)}`, subject: { taskId: randomUUID() }, at: "2026-10-22T09:00:00.000Z" });
const orgs = Array.from({ length: 12 }, (_, index) => `org_${String(index).padStart(2, "0")}${"a".repeat(18)}`);
const people = Array.from({ length: 12 }, (_, index) => `${String(index % 10)}${String(index)}`.padEnd(64, "a"));

const admit = (w: DiagnosisWorld, orgId: OrgId, n: number, options: { who?: string } = {}) =>
  admitDiagnosis(w.diagnosis, { orgId, developerId: options.who ?? people[n % people.length]!, requestId: randomUUID(), tier: "light", errorRef: errorRef(n), project: `project-${String(n)}` });
const refused = (words: string) => expect.objectContaining({ code: "TOO_MANY_REQUESTS", message: expect.stringContaining(words) as string }) as unknown;

describe("DG-3 one model key per diagnosis", () => {
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

describe("QA6-14 the one retry after the provider refused the first model", () => {
  const chosen = { model: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-5-5" }, sourceId: "rovara" } as const;

  it("is given once, only after a first key was taken, and says which model was refused", async () => {
    const w = diagnosisWorld({ edition: "public" });
    const status = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    // No first key yet: nothing to retry.
    await expect(claimDiagnosisRetry(w.diagnosis, ORG_A, status.diagnosisId)).resolves.toBeUndefined();
    await expect(claimDiagnosisKey(w.diagnosis, ORG_A, status.diagnosisId, chosen)).resolves.toBe(true);
    const project = w.w.db.get(diagnosisKey(ORG_A, status.diagnosisId, "REQUEST"))!["project"] as string;
    const counter = () => w.w.db.get(diagnosisRateKey(ORG_A, "light_project", project))?.["count"];
    expect(counter()).toBe(1);
    await expect(claimDiagnosisRetry(w.diagnosis, ORG_A, status.diagnosisId)).resolves.toEqual({ rejected: chosen });
    // F4: the retry key is counted in the project's daily light count, once.
    expect(counter()).toBe(2);
    // A second retry, a repeat, or two at once: refused. The first claim stays refused too.
    await expect(claimDiagnosisRetry(w.diagnosis, ORG_A, status.diagnosisId)).resolves.toBeUndefined();
    expect(counter()).toBe(2);
    await expect(claimDiagnosisKey(w.diagnosis, ORG_A, status.diagnosisId, chosen)).resolves.toBe(false);
  });

  it("two retries at the same moment cannot both take it; another org's or a settled diagnosis cannot be retried", async () => {
    const w = diagnosisWorld({ edition: "public" });
    const status = await startLightDiagnosis(w.diagnosis, w.caller(PRIYA), { requestId: randomUUID(), errorRef: w.ref() });
    await claimDiagnosisKey(w.diagnosis, ORG_A, status.diagnosisId, chosen);
    await expect(claimDiagnosisRetry(w.diagnosis, "org_bbbbbbbbbbbbbbbbbbbb", status.diagnosisId)).resolves.toBeUndefined();
    const results = await Promise.all(Array.from({ length: 5 }, () => claimDiagnosisRetry(w.diagnosis, ORG_A, status.diagnosisId)));
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
    w.w.db.get(diagnosisKey(ORG_A, status.diagnosisId, "REQUEST"))!["retryClaimedAt"] = undefined;
    delete w.w.db.get(diagnosisKey(ORG_A, status.diagnosisId, "REQUEST"))!["retryClaimedAt"];
    w.w.db.get(diagnosisKey(ORG_A, status.diagnosisId, "REQUEST"))!["state"] = "failed";
    await expect(claimDiagnosisRetry(w.diagnosis, ORG_A, status.diagnosisId)).resolves.toBeUndefined();
  });
});

describe("DG-3 the windows are the broker's own clock, and a clock ahead never resets a counter", () => {
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

  it("a window that is far ahead (not skew) is not trusted: the person's counter starts again in this instance's own window", async () => {
    const w = diagnosisWorld();
    const hour = 3_600_000;
    const now = Math.floor(w.w.clock.now / hour) * hour;
    const personKey = { pk: `ORG#${orgs[0]!}#DIAGNOSISRATE`, sk: `light_person#${people[0]!}` };
    w.w.db.set({ ...personKey, entityType: "DIAGNOSIS_RATE", orgId: orgs[0]!, windowStart: now + 5 * hour, count: DIAGNOSIS_RATE.lightPerPersonPerHour });
    await expect(admit(w, orgs[0]!, 0, { who: people[0]! })).resolves.toMatchObject({ created: true });
    expect(w.w.db.get(personKey)).toMatchObject({ windowStart: now, count: 1 });
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

describe("no counter of money is kept for a diagnosis (the company pays, 2026-11-03)", () => {
  it("an admitted diagnosis writes the person's and the project's counters, the open place, the request and the person link, and no organization or install-wide money item", async () => {
    const w = diagnosisWorld({ edition: "public" });
    await admit(w, ORG_A, 0);
    const keys = [...w.w.db.items.keys()];
    expect(keys.filter((key) => key.includes("light_org") || key.includes("DIAGNOSISGLOBAL"))).toEqual([]);
    expect(keys.some((key) => key.includes("light_person#")), "person counter").toBe(true);
    expect(keys.some((key) => key.includes("light_project#")), "project counter").toBe(true);
  });

  it("the refusal words for an organization's day and an install-wide pause no longer exist", () => {
    expect(DIAGNOSIS_REFUSALS).not.toHaveProperty("orgRateLimited");
    expect(DIAGNOSIS_REFUSALS).not.toHaveProperty("globalRateLimited");
  });
});
