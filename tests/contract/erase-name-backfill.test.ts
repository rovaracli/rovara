// 0.5.11 release step (owner decision 22): scripts/backfill-erased-names.ts erases the chosen name and the sign-in record's name of everyone erased before 0.5.11, through the broker's own
// `nameEraserOf(...).erase`. These tests run it over the fake DynamoDB: a dry run writes nothing, --apply erases, a second --apply changes nothing, a person who was not erased (or who was erased and
// rejoined with a new name) is untouched, no name or raw id reaches the output, and a failure gives a non-zero exit.
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EraseDeveloperNameRequest, EraseDeveloperNameResponse } from "../../packages/contracts/src/index.js";
import { FORMER_MEMBER_NAME, chosenNameKey, readChosenName, type ChosenNameClient } from "../../packages/broker/src/developer/chosen-name.js";
import { placeholderDisplayName } from "../../packages/broker/src/developer/person-name.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { parseEraseBackfillArgs, runEraseBackfillCommand, shortHash, type EraseBackfillPorts } from "../../scripts/backfill-erased-names.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const hex = (digit: string) => digit.repeat(64);
const OLD_ERASED = hex("1");
const ALSO_ERASED = hex("2");
const NEVER_ERASED = hex("3");
const REJOINED = hex("4");
const NO_NAME_ITEM = hex("5");
const NOW = Date.parse("2026-11-09T10:00:00.000Z");
const ERASED_AT = "2026-10-01T10:00:00.000Z";
const NAMES: Record<string, string> = { [OLD_ERASED]: "Priya Rao", [ALSO_ERASED]: "Arjun Mehta", [NEVER_ERASED]: "Mia Stone", [REJOINED]: "Zed Newname", [NO_NAME_ITEM]: "Ola Quiet" };
const REAL: Record<string, string> = { [OLD_ERASED]: "Priya Realname", [ALSO_ERASED]: "Arjun Realname", [NEVER_ERASED]: "Mia Realname", [REJOINED]: "Zed Realname", [NO_NAME_ITEM]: "Ola Realname" };
const BASE_ENV = { AUDIT_KEYS_TABLE_NAME: "keys", STATE_TABLE_NAME: "state", AWS_REGION: "us-west-2", DEVELOPER_IDENTITY_FUNCTION_NAME: "signin-fn" };

const nameItem = (developerId: string) => ({ ...chosenNameKey(developerId), entityType: "DEVELOPER_NAME", developerId, name: NAMES[developerId], chosenAt: "2026-09-01T09:00:00.000Z" });
const ledgerTombstone = (developerId: string, org = TEST_ORG) => ({ pk: `ORG#${org}`, sk: `SUBJECT#${developerId}`, erasedAt: ERASED_AT });
const signInRecordKey = (developerId: string) => ({ pk: `DEVELOPER#${developerId}`, sk: "META" });

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function world() {
  const db = new FakeDynamoDb();
  const signIn = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => NOW });
  for (const developerId of Object.keys(NAMES)) {
    await signIn.upsertDeveloper({ developerId, provider: "cloud", issuer: "https://idp.example.test", subject: `sub-${developerId.slice(0, 4)}`, displayName: REAL[developerId]!, email: `${developerId.slice(0, 4)}@example.test` });
  }
  // Erased in the ledger before 0.5.11, with the chosen name still stored (the case the backfill exists for).
  for (const developerId of [OLD_ERASED, ALSO_ERASED, NEVER_ERASED, REJOINED]) db.set(nameItem(developerId));
  for (const developerId of [OLD_ERASED, ALSO_ERASED, REJOINED, NO_NAME_ITEM]) db.set(ledgerTombstone(developerId));
  // A live key item of a person who is NOT erased: no `erasedAt`, so it is no tombstone.
  db.set({ pk: `ORG#${TEST_ORG}`, sk: `SUBJECT#${NEVER_ERASED}`, wrapped: "sealed-details-placeholder" });
  // One erased then rejoined with a new name: the tombstone and the new name sit in one item (ERASED-REJOIN-NAME).
  db.set({ ...nameItem(REJOINED), erased: true, erasedAt: ERASED_AT, chosenAt: "2026-10-20T09:00:00.000Z", rejoinedAt: "2026-10-20T09:00:00.000Z" });
  const calls: EraseDeveloperNameRequest[] = [];
  let signInAnswer: "ok" | "unavailable" = "ok";
  const ports = (extra: Partial<EraseBackfillPorts> = {}): EraseBackfillPorts => ({
    documentClient: db,
    now: () => NOW,
    sleep: async () => undefined,
    eraseSignInName: async (request): Promise<EraseDeveloperNameResponse> => {
      calls.push(request);
      if (signInAnswer === "unavailable") return { ok: false, error: "unavailable" };
      return (await signIn.eraseDisplayName(request.developerId, request.at)) === "erased" ? { ok: true } : { ok: false, error: "not_found" };
    },
    ...extra,
  });
  const run = async (argv: string[], extra?: Partial<EraseBackfillPorts>, env: Record<string, string | undefined> = BASE_ENV) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runEraseBackfillCommand(argv, env, () => ports(extra), (line) => out.push(line), (line) => err.push(line));
    return { code, out, err, summary: out.length === 0 ? undefined : JSON.parse(out[0]!) as Record<string, unknown> };
  };
  const snapshot = () => JSON.stringify([...db.items.entries()]);
  return { db, signIn, calls, run, snapshot, failSignIn: () => { signInAnswer = "unavailable"; }, restoreSignIn: () => { signInAnswer = "ok"; } };
}

describe("the erased-names backfill", () => {
  it("a dry run (the default) writes nothing, calls nobody and lists counts and hashed ids only", async () => {
    const w = await world();
    const before = w.snapshot();
    const { code, out, err, summary } = await w.run([]);
    expect(code).toBe(0);
    expect(w.snapshot()).toBe(before);
    expect(w.calls).toEqual([]);
    // Positive control: the work it reports is real (two people hold a stored name; one is a rejoined person who is kept; one has no name item).
    expect(summary).toMatchObject({ mode: "dry-run", people: 4, toErase: 3, erased: 0, rejoinedKept: 1, alreadyErased: 0, failed: 0, finished: true });
    expect(summary?.toEraseIds).toEqual(expect.arrayContaining([shortHash(OLD_ERASED), shortHash(ALSO_ERASED), shortHash(NO_NAME_ITEM)]));
    const text = [...out, ...err].join("\n");
    for (const developerId of Object.keys(NAMES)) expect(text).not.toContain(developerId);
    for (const name of [...Object.values(NAMES), ...Object.values(REAL)]) expect(text).not.toContain(name);
    expect(await readChosenName(w.db, "state", OLD_ERASED)).toBe(NAMES[OLD_ERASED]);
  });

  it("--apply erases the chosen name and the sign-in record's name of each erased person, and prints no name or raw id", async () => {
    const w = await world();
    expect(await readChosenName(w.db, "state", OLD_ERASED)).toBe("Priya Rao");
    const { code, out, err, summary } = await w.run(["--apply"]);
    expect(code).toBe(0);
    expect(summary).toMatchObject({ mode: "apply", toErase: 3, erased: 3, failed: 0, rejoinedKept: 1, finished: true });
    for (const developerId of [OLD_ERASED, ALSO_ERASED, NO_NAME_ITEM]) {
      const stored = w.db.get(chosenNameKey(developerId));
      expect(stored, developerId).toMatchObject({ erased: true });
      expect(stored).not.toHaveProperty("name");
      expect(await readChosenName(w.db, "state", developerId)).toBe(FORMER_MEMBER_NAME);
      expect(w.db.get(signInRecordKey(developerId))).toMatchObject({ displayName: placeholderDisplayName(developerId) });
      expect(JSON.stringify([w.db.get(chosenNameKey(developerId)), w.db.get(signInRecordKey(developerId))])).not.toMatch(/Realname|Priya Rao|Arjun Mehta|Ola Quiet/);
    }
    const text = [...out, ...err].join("\n");
    for (const developerId of Object.keys(NAMES)) expect(text).not.toContain(developerId);
    for (const name of [...Object.values(NAMES), ...Object.values(REAL)]) expect(text).not.toContain(name);
  });

  it("a second --apply changes nothing and says so", async () => {
    const w = await world();
    await w.run(["--apply"]);
    const after = w.snapshot();
    const callsBefore = w.calls.length;
    const { code, err, summary } = await w.run(["--apply"]);
    expect(code).toBe(0);
    expect(w.snapshot()).toBe(after);
    // The sign-in erase is repeated for the three tombstones (it changes nothing the second time); the name items are not written again.
    expect(w.calls.length).toBe(callsBefore + 3);
    expect(summary).toMatchObject({ erased: 0, toErase: 0, alreadyErased: 3, signInConfirmed: 3, rejoinedKept: 1, failed: 0, finished: true });
    expect(err.join("\n")).toMatch(/Nothing to change/u);
  });

  it("leaves a person who was not erased alone, and keeps the new name of a person who was erased and rejoined", async () => {
    const w = await world();
    const never = [JSON.stringify(w.db.get(chosenNameKey(NEVER_ERASED))), JSON.stringify(w.db.get(signInRecordKey(NEVER_ERASED)))];
    const rejoined = [JSON.stringify(w.db.get(chosenNameKey(REJOINED))), JSON.stringify(w.db.get(signInRecordKey(REJOINED)))];
    await w.run(["--apply"]);
    expect([JSON.stringify(w.db.get(chosenNameKey(NEVER_ERASED))), JSON.stringify(w.db.get(signInRecordKey(NEVER_ERASED)))]).toEqual(never);
    expect([JSON.stringify(w.db.get(chosenNameKey(REJOINED))), JSON.stringify(w.db.get(signInRecordKey(REJOINED)))]).toEqual(rejoined);
    expect(await readChosenName(w.db, "state", NEVER_ERASED)).toBe("Mia Stone");
    expect(await readChosenName(w.db, "state", REJOINED)).toBe("Zed Newname");
    expect(w.calls.map((request) => request.developerId)).not.toContain(NEVER_ERASED);
    expect(w.calls.map((request) => request.developerId)).not.toContain(REJOINED);
  });

  it("a failed erase is counted by code, the run goes on, and the exit code is 1; a plain re-run then clears the sign-in records the failure left", async () => {
    const w = await world();
    w.failSignIn();
    const failed = await w.run(["--apply"]);
    expect(failed.code).toBe(1);
    expect(failed.summary).toMatchObject({ toErase: 3, erased: 0, failed: 3, failureCodes: { erase_name_sign_in_unavailable: 3 } });
    expect(failed.err.join("\n")).toMatch(/3 erases failed/u);
    const text = [...failed.out, ...failed.err].join("\n");
    for (const developerId of Object.keys(NAMES)) expect(text).not.toContain(developerId);
    // The tombstones are in place (no reader shows the name), but the sign-in records were not cleared.
    expect(await readChosenName(w.db, "state", OLD_ERASED)).toBe(FORMER_MEMBER_NAME);
    expect(w.db.get(signInRecordKey(OLD_ERASED))).toMatchObject({ displayName: REAL[OLD_ERASED] });
    // A re-run while the sign-in function is still down is not clean either (it does not say 'done').
    const stillDown = await w.run(["--apply"]);
    expect(stillDown.code).toBe(1);
    expect(stillDown.summary).toMatchObject({ alreadyErased: 3, signInConfirmed: 0, failed: 3 });
    // The sign-in function is back: the plain re-run clears the records and exits 0.
    w.restoreSignIn();
    const fixed = await w.run(["--apply"]);
    expect(fixed.code).toBe(0);
    expect(fixed.summary).toMatchObject({ alreadyErased: 3, signInConfirmed: 3, failed: 0 });
    for (const developerId of [OLD_ERASED, ALSO_ERASED, NO_NAME_ITEM]) expect(w.db.get(signInRecordKey(developerId))).toMatchObject({ displayName: placeholderDisplayName(developerId) });
  });

  it("an unread BatchGet key is read again by itself, so a rejoined person's new name is never mistaken for 'no item' and wiped", async () => {
    const w = await world();
    const rejoinedKey = chosenNameKey(REJOINED);
    const dropping: ChosenNameClient = { send: async (command) => {
      const answer = await w.db.send(command as never) as { Responses?: Record<string, Array<{ pk: string }>>; UnprocessedKeys?: Record<string, unknown> };
      if ((command as { constructor: { name: string } }).constructor.name !== "BatchGetCommand") return answer;
      for (const [table, items] of Object.entries(answer.Responses ?? {})) answer.Responses![table] = items.filter((item) => item.pk !== rejoinedKey.pk);
      answer.UnprocessedKeys = { state: { Keys: [rejoinedKey] } };
      return answer;
    } };
    const before = JSON.stringify(w.db.get(chosenNameKey(REJOINED)));
    const { code, summary } = await w.run(["--apply"], { documentClient: dropping });
    expect(code).toBe(0);
    expect(summary).toMatchObject({ rejoinedKept: 1, erased: 3 });
    expect(JSON.stringify(w.db.get(chosenNameKey(REJOINED)))).toBe(before);
    expect(await readChosenName(w.db, "state", REJOINED)).toBe("Zed Newname");
  });

  it("a page with a failure ends the run and the cursor stays at that page, so a re-run with the same cursor file retries it", async () => {
    const w = await world();
    const directory = await mkdtemp(join(tmpdir(), "erase-backfill-"));
    temporary.push(directory);
    const cursorFile = join(directory, "cursor.json");
    // Page size 1: the first tombstone is page 1 (written), the sign-in function is down for the rest of the pages we reach.
    w.failSignIn();
    const first = await w.run(["--apply", "--page-size", "1", "--cursor-file", cursorFile]);
    expect(first.code).toBe(1);
    expect(first.summary).toMatchObject({ finished: false, failed: 1 });
    expect((await stat(cursorFile)).isFile()).toBe(true);
    w.restoreSignIn();
    const second = await w.run(["--apply", "--page-size", "1", "--cursor-file", cursorFile]);
    expect(second.code).toBe(0);
    // Every erased person ends up with the sign-in name cleared, including the one whose page failed.
    for (const developerId of [OLD_ERASED, ALSO_ERASED, NO_NAME_ITEM]) expect(w.db.get(signInRecordKey(developerId))).toMatchObject({ displayName: placeholderDisplayName(developerId) });
  });

  it("a name item that cannot be read is a failure, not an erase and not a skip", async () => {
    const w = await world();
    w.db.injectFault({ command: "GetCommand", error: { name: "AccessDeniedException" }, times: 100 });
    const dropAll: ChosenNameClient = { send: async (command) => (command as { constructor: { name: string } }).constructor.name === "BatchGetCommand" ? { Responses: {} } : w.db.send(command as never) };
    const before = JSON.stringify([...w.db.items.entries()].filter(([key]) => key.includes("DEVELOPER_NAME")));
    const { code, summary } = await w.run(["--apply"], { documentClient: dropAll });
    expect(code).toBe(1);
    expect(summary).toMatchObject({ erased: 0, failed: 4, failureCodes: { AccessDeniedException: 4 } });
    expect(JSON.stringify([...w.db.items.entries()].filter(([key]) => key.includes("DEVELOPER_NAME")))).toBe(before);
  });

  it("counts shredded companies, whose erased people cannot be found, and says so", async () => {
    const w = await world();
    w.db.set({ pk: "ORG#org_shredded00000000000000", sk: "SHREDDED", at: ERASED_AT });
    const { code, summary, err } = await w.run(["--apply"]);
    expect(code).toBe(0);
    expect(summary).toMatchObject({ shreddedOrgs: 1, erased: 3 });
    expect(err.join("\n")).toMatch(/1 companies were shredded/u);
  });

  it("a failure of the Scan (not a person) stops the run with a non-zero exit and prints a code, not the error text", async () => {
    const w = await world();
    w.db.injectFault({ command: "ScanCommand", error: { name: "AccessDeniedException", message: `secret ${NAMES[OLD_ERASED]!} ${OLD_ERASED}` }, times: 10 });
    const { code, out, err, summary } = await w.run(["--apply"]);
    expect(code).toBe(1);
    expect(summary).toMatchObject({ abortedBy: "AccessDeniedException", finished: false, erased: 0 });
    const text = [...out, ...err].join("\n");
    expect(text).toContain("AccessDeniedException");
    expect(text).not.toContain(NAMES[OLD_ERASED]!);
    expect(text).not.toContain(OLD_ERASED);
  });

  it("retries throttling with a pause, on the Scan and on an erase", async () => {
    const w = await world();
    const pauses: number[] = [];
    w.db.injectFault({ command: "ScanCommand", error: { name: "ProvisionedThroughputExceededException" }, times: 2 });
    w.db.injectFault({ command: "PutCommand", match: (input) => (input.Item as { developerId?: string } | undefined)?.developerId === OLD_ERASED, error: { name: "ThrottlingException" }, times: 1 });
    const { code, summary } = await w.run(["--apply", "--pause-ms", "0"], { sleep: async (ms) => { pauses.push(ms); } });
    expect(code).toBe(0);
    expect(summary).toMatchObject({ erased: 3, failed: 0 });
    expect(pauses.length).toBeGreaterThanOrEqual(3);
  });

  it("is bounded: pages of one, a page limit and a cursor file resume where the run stopped, and the file is removed at the end", async () => {
    const w = await world();
    const directory = await mkdtemp(join(tmpdir(), "erase-backfill-"));
    temporary.push(directory);
    const cursorFile = join(directory, "cursor.json");
    const first = await w.run(["--apply", "--page-size", "1", "--max-pages", "2", "--cursor-file", cursorFile]);
    // Stopped at its limit: not done, so not exit 0.
    expect(first.code).toBe(3);
    expect(first.summary).toMatchObject({ finished: false, pages: 2 });
    expect(first.err.join("\n")).toMatch(/NOT done: run it again with the same --cursor-file/u);
    expect((await stat(cursorFile)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(cursorFile, "utf8"))).toMatchObject({ mode: "apply" });
    let erasedSoFar = Number(first.summary?.erased);
    let last = first;
    for (let round = 0; round < 10 && last.summary?.finished === false; round += 1) {
      last = await w.run(["--apply", "--page-size", "1", "--max-pages", "2", "--cursor-file", cursorFile]);
      erasedSoFar += Number(last.summary?.erased);
    }
    expect(last.summary?.finished).toBe(true);
    expect(last.code).toBe(0);
    expect(erasedSoFar).toBe(3);
    await expect(stat(cursorFile)).rejects.toThrow();
    // A cursor left by a dry run is refused by an apply run.
    const dry = await w.run(["--page-size", "1", "--max-pages", "1", "--cursor-file", cursorFile]);
    expect(dry.summary?.finished).toBe(false);
    expect(dry.code).toBe(3);
    const mixed = await w.run(["--apply", "--cursor-file", cursorFile]);
    expect(mixed.code).toBe(1);
    expect(mixed.err.join("\n")).toMatch(/belongs to a dry-run run/u);
  });

  it("a run stopped by --max-ms exits 3, and an unwritable cursor file stops the run with exit 1 and the counts so far", async () => {
    const w = await world();
    let clock = NOW;
    const slow = await w.run(["--apply", "--page-size", "1", "--max-ms", "1", "--pause-ms", "0"], { now: () => (clock += 1000) });
    expect(slow.code).toBe(3);
    expect(slow.summary).toMatchObject({ finished: false });
    const directory = await mkdtemp(join(tmpdir(), "erase-backfill-"));
    temporary.push(directory);
    const unwritable = await w.run(["--page-size", "1", "--cursor-file", join(directory, "missing", "cursor.json")]);
    expect(unwritable.code).toBe(1);
    expect(unwritable.summary).toMatchObject({ abortedBy: "Error", finished: false });
  });

  it("counts a tombstone whose id the sign-in function would refuse, and leaves it alone", async () => {
    const w = await world();
    w.db.set({ pk: `ORG#${TEST_ORG}`, sk: "SUBJECT#not-a-64-hex-id", erasedAt: ERASED_AT });
    const { summary } = await w.run(["--apply"]);
    expect(summary).toMatchObject({ invalidIds: 1, erased: 3, failed: 0 });
  });

  it("one person erased in two companies is erased once", async () => {
    const w = await world();
    w.db.set(ledgerTombstone(OLD_ERASED, "org_otherco0000000000000000"));
    const { summary } = await w.run(["--apply"]);
    expect(summary).toMatchObject({ tombstones: 5, people: 4, erased: 3 });
    expect(w.calls.filter((request) => request.developerId === OLD_ERASED)).toHaveLength(1);
  });
});

describe("the backfill's options", () => {
  it("does not need --profile, reads the tables, the region and the sign-in function from the environment, and takes flags over it", () => {
    const args = parseEraseBackfillArgs([], BASE_ENV);
    expect(args).toMatchObject({ keysTable: "keys", stateTable: "state", region: "us-west-2", identityFunction: "signin-fn", apply: false });
    expect(args).not.toHaveProperty("profile");
    expect(parseEraseBackfillArgs(["--keys-table", "keys2", "--state-table", "state2", "--region", "eu-west-1", "--identity-function", "fn2", "--apply"], BASE_ENV)).toMatchObject({ keysTable: "keys2", stateTable: "state2", region: "eu-west-1", identityFunction: "fn2", apply: true });
    expect(parseEraseBackfillArgs(["--profile", "p"], BASE_ENV)).toMatchObject({ profile: "p" });
  });

  it("has no default table or region, refuses unknown or repeated options and a mix of --apply and --dry-run", () => {
    expect(() => parseEraseBackfillArgs([], {})).toThrow(/--keys-table/u);
    expect(() => parseEraseBackfillArgs([], { AUDIT_KEYS_TABLE_NAME: "keys" })).toThrow(/--state-table/u);
    expect(() => parseEraseBackfillArgs([], { AUDIT_KEYS_TABLE_NAME: "keys", STATE_TABLE_NAME: "state" })).toThrow(/--region/u);
    expect(() => parseEraseBackfillArgs([], { ...BASE_ENV, DEVELOPER_IDENTITY_FUNCTION_NAME: undefined })).toThrow(/--identity-function/u);
    expect(parseEraseBackfillArgs(["--no-sign-in"], { ...BASE_ENV, DEVELOPER_IDENTITY_FUNCTION_NAME: undefined })).not.toHaveProperty("identityFunction");
    expect(() => parseEraseBackfillArgs(["--bogus"], BASE_ENV)).toThrow(/unknown option/u);
    expect(() => parseEraseBackfillArgs(["--apply", "--apply"], BASE_ENV)).toThrow(/twice/u);
    expect(() => parseEraseBackfillArgs(["--region", "us-west-2", "--region", "us-west-2"], BASE_ENV)).toThrow(/twice/u);
    expect(() => parseEraseBackfillArgs(["--apply", "--dry-run"], BASE_ENV)).toThrow(/not both/u);
    expect(() => parseEraseBackfillArgs(["--max-ms", "soon"], BASE_ENV)).toThrow(/whole number/u);
    expect(() => parseEraseBackfillArgs(["--region", "west"], { ...BASE_ENV, AWS_REGION: undefined })).toThrow(/--region/u);
  });

  it("bad options exit with 2 and touch nothing", async () => {
    const w = await world();
    const before = w.snapshot();
    const { code, out } = await w.run(["--bogus"]);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(w.snapshot()).toBe(before);
  });
});
