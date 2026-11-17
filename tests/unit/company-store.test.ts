// Cloud's company data (company-store.ts, company-dynamo.ts): the same cases against the memory store, the DynamoDB store on an
// in-memory table that evaluates the store's own condition expressions, and the DynamoDB store on DynamoDB Local in Docker (when Docker
// runs, as on CI). Company isolation is checked per row: a row whose company attribute is not the one its key names reads as nothing.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { ConditionalCheckFailedException, CreateTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMPANY_TABLE, CompanyStoreConflict, DynamoCompanyStore, LocalCompanyStore, StoreCompanyRules, StoreHookInstalls, cloudDocumentClient, defaultCompanySettings, hookRulesOf,
  validHookInstall, type CompanyStore, type HookInstall, type InviteRecord, type PendingSettingsChange,
} from "../../packages/cloud-server/src/index.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa";
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

// ---- An in-memory table that runs the store's own expressions (the small grammar the store uses, and nothing more) ----
type Item = Record<string, unknown>;
function memoryTable() {
  const items = new Map<string, Item>();
  const key = (k: { pk: unknown; sk: unknown }) => `${String(k.pk)}\u0000${String(k.sk)}`;
  const holds = (expression: string | undefined, item: Item | undefined, values: Record<string, unknown> = {}): boolean => {
    if (expression === undefined) return true;
    return expression.split(" OR ").some((any) => any.split(" AND ").every((atom) => {
      const exists = /^attribute_(not_)?exists\((\w+)\)$/u.exec(atom.trim());
      if (exists !== null) return (item?.[exists[2]!] === undefined) === (exists[1] !== undefined);
      const compare = /^(\w+) (=|<=|<|>=|>) (:\w+)$/u.exec(atom.trim());
      if (compare === null) throw new Error(`the fake table can't read: ${atom}`);
      const left = item?.[compare[1]!], right = values[compare[3]!];
      if (left === undefined) return false;
      if (compare[2] === "=") return left === right;
      const [l, r] = [left as number, right as number];
      return compare[2] === "<=" ? l <= r : compare[2] === "<" ? l < r : compare[2] === ">=" ? l >= r : l > r;
    }));
  };
  const failed = () => new ConditionalCheckFailedException({ message: "The conditional request failed", $metadata: {} });
  const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  interface Op {
    Item?: Item & { pk: unknown; sk: unknown }; Key?: { pk: unknown; sk: unknown }; ConditionExpression?: string; ExpressionAttributeValues?: Record<string, unknown>;
    KeyConditionExpression?: string; ReturnValues?: string; TransactItems?: Array<{ Put?: Op; Delete?: Op }>;
  }
  const send = async (command: { constructor: { name: string }; input: Op }) => {
    const input = command.input;
    switch (command.constructor.name) {
      case "GetCommand": { const item = items.get(key(input.Key!)); return { Item: item === undefined ? undefined : json(item) }; }
      case "PutCommand": {
        if (!holds(input.ConditionExpression, items.get(key(input.Item!)), input.ExpressionAttributeValues)) throw failed();
        items.set(key(input.Item!), json(input.Item!)); return {};
      }
      case "DeleteCommand": {
        const before = items.get(key(input.Key!));
        if (!holds(input.ConditionExpression, before, input.ExpressionAttributeValues)) throw failed();
        items.delete(key(input.Key!)); return input.ReturnValues === "ALL_OLD" ? { Attributes: before } : {};
      }
      case "QueryCommand": {
        const match = /^pk = :pk(?: AND begins_with\(sk, :prefix\))?$/u.exec(input.KeyConditionExpression ?? "");
        if (match === null) throw new Error("the fake table can't read the key condition");
        const pk = input.ExpressionAttributeValues?.[":pk"], prefix = (input.ExpressionAttributeValues?.[":prefix"] as string | undefined) ?? "";
        const found = [...items.values()].filter((item) => item.pk === pk && String(item.sk).startsWith(prefix)).sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
        return { Items: json(found) };
      }
      case "TransactWriteCommand": {
        const writes = input.TransactItems ?? [];
        const reasons = writes.map((write) => {
          const op = (write.Put ?? write.Delete)!;
          const target = items.get(key(write.Put !== undefined ? op.Item! : op.Key!));
          return holds(op.ConditionExpression, target, op.ExpressionAttributeValues) ? { Code: "None" } : { Code: "ConditionalCheckFailed" };
        });
        if (reasons.some((reason) => reason.Code !== "None")) throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: reasons });
        for (const write of writes) {
          if (write.Put !== undefined) items.set(key(write.Put.Item!), json(write.Put.Item!));
          else items.delete(key(write.Delete!.Key!));
        }
        return {};
      }
      default: throw new Error(`the fake table has no ${command.constructor.name}`);
    }
  };
  return { send, items };
}

// ---- Fixtures ----
let made = 0;
const invite = (companyId: string, overrides: Partial<InviteRecord> = {}): InviteRecord => {
  made += 1;
  const n = String(made).padStart(12, "0");
  return {
    companyId, inviteId: `00000000-0000-4000-8000-${n}`, requestId: `11111111-0000-4000-8000-${n}`, role: "member", email: `p${n}@example.com`, tokenHash: randomBytes(32).toString("hex"),
    createdBy: "a".repeat(64), createdAt: iso(NOW + made), expiresAt: iso(NOW + 7 * DAY), state: "unconfirmed", revision: 0, ...overrides,
  };
};
const change = (companyId: string, baseVersion: number, overrides: Partial<PendingSettingsChange> = {}): PendingSettingsChange => ({
  companyId, changeId: `chg_${randomBytes(10).toString("hex")}`, settings: { ...defaultCompanySettings(), evalBudgetUsdMicros: 7 }, baseVersion, proposedBy: "dev_a",
  proposedAt: iso(NOW), expiresAt: iso(NOW + 7 * DAY), ...overrides,
});
const jwk = () => {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const { n, e } = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  return { kty: "RSA" as const, n, e, kid: `k${randomBytes(4).toString("hex")}` };
};
const KEY = jwk();
const install = (overrides: Partial<HookInstall> = {}): HookInstall => ({ issuer: "https://code.example.test", keys: [KEY], companyIds: [A], updatedAt: iso(NOW), ...overrides });

function contract(name: string, make: () => CompanyStore) {
  describe(name, () => {
    it("saves settings under a version, guarding every write, one company at a time", async () => {
      const store = make();
      expect(await store.settings(A)).toBeUndefined();
      const settings = { ...defaultCompanySettings(), evalBudgetUsdMicros: 1 };
      expect(await store.putSettings(A, settings, 0, "dev_a", iso(NOW))).toBe(1);
      await expect(store.putSettings(A, settings, 0, "dev_a", iso(NOW))).rejects.toBeInstanceOf(CompanyStoreConflict);
      await expect(store.putSettings(A, settings, 2, "dev_a", iso(NOW))).rejects.toBeInstanceOf(CompanyStoreConflict);
      expect(await store.putSettings(A, { ...settings, evalBudgetUsdMicros: 2 }, 1, "dev_b", iso(NOW + 1))).toBe(2);
      expect(await store.settings(A)).toEqual({ companyId: A, settings: { ...settings, evalBudgetUsdMicros: 2 }, version: 2, updatedAt: iso(NOW + 1), updatedBy: "dev_b" });
      expect(await store.settings(B)).toBeUndefined();
      expect(await store.putSettings(B, settings, 0, "dev_x", iso(NOW))).toBe(1);
      expect((await store.settings(A))!.version).toBe(2);
    });

    it("keeps one change waiting per company, until it is applied, dropped or expires", async () => {
      const store = make();
      const first = change(A, 0);
      await store.proposeChange(first, NOW);
      expect(await store.pendingChange(A, NOW)).toEqual(first);
      expect(await store.pendingChange(B, NOW)).toBeUndefined();
      await expect(store.proposeChange(change(A, 0), NOW)).rejects.toBeInstanceOf(CompanyStoreConflict);
      await store.proposeChange(change(B, 0), NOW);
      expect(await store.dropChange(A, "chg_00000000000000000000")).toBe(false);
      expect(await store.dropChange(B, first.changeId)).toBe(false);
      expect(await store.pendingChange(A, NOW + 7 * DAY)).toBeUndefined();
      const later = change(A, 0, { expiresAt: iso(NOW + 14 * DAY) });
      await store.proposeChange(later, NOW + 7 * DAY);
      expect(await store.dropChange(A, later.changeId)).toBe(true);
      expect(await store.pendingChange(A, NOW)).toBeUndefined();
    });

    it("applies a change only on its own base version, dropping it in the same write", async () => {
      const store = make();
      const waiting = change(A, 0);
      await store.proposeChange(waiting, NOW);
      await store.putSettings(A, defaultCompanySettings(), 0, "dev_a", iso(NOW));
      await expect(store.applyChange(waiting, "dev_b", iso(NOW))).rejects.toBeInstanceOf(CompanyStoreConflict);
      expect((await store.settings(A))!.version).toBe(1);
      expect(await store.pendingChange(A, NOW)).toEqual(waiting);
      expect(await store.dropChange(A, waiting.changeId)).toBe(true);
      const fresh = change(A, 1);
      await store.proposeChange(fresh, NOW);
      expect(await store.applyChange(fresh, "dev_b", iso(NOW + 5))).toBe(2);
      expect(await store.settings(A)).toEqual({ companyId: A, settings: fresh.settings, version: 2, updatedAt: iso(NOW + 5), updatedBy: "dev_b" });
      expect(await store.pendingChange(A, NOW)).toBeUndefined();
      await expect(store.applyChange(fresh, "dev_b", iso(NOW))).rejects.toBeInstanceOf(CompanyStoreConflict);
    });

    it("keeps a profile under a version", async () => {
      const store = make();
      expect(await store.profile(A)).toBeUndefined();
      expect(await store.putProfile({ companyId: A, name: "Acme", plan: "pilot" }, 0)).toBe(1);
      await expect(store.putProfile({ companyId: A, name: "Acme 2", plan: "pilot" }, 0)).rejects.toBeInstanceOf(CompanyStoreConflict);
      expect(await store.profile(A)).toEqual({ companyId: A, name: "Acme", plan: "pilot", version: 1 });
      expect(await store.profile(B)).toBeUndefined();
    });

    it("stores an invite once per request, finds it by request and token, and only in its company", async () => {
      const store = make();
      const one = invite(A);
      await store.createInvite(one);
      await expect(store.createInvite({ ...invite(A), requestId: one.requestId })).rejects.toBeInstanceOf(CompanyStoreConflict);
      expect(await store.invite(A, one.inviteId)).toEqual(one);
      expect(await store.invite(B, one.inviteId)).toBeUndefined();
      expect(await store.inviteByRequest(A, one.requestId)).toEqual(one);
      expect(await store.inviteByRequest(B, one.requestId)).toBeUndefined();
      expect(await store.inviteByToken(one.tokenHash)).toEqual(one);
      expect(await store.inviteByToken("0".repeat(64))).toBeUndefined();
      // The same request id in another company is that company's own.
      const theirs = invite(B, { requestId: one.requestId });
      await store.createInvite(theirs);
      const two = invite(A);
      await store.createInvite(two);
      expect((await store.invites(A)).invites.map((each) => each.inviteId)).toEqual([two.inviteId, one.inviteId]);
      expect(await store.invites(B)).toEqual({ invites: [theirs], partial: false });
    });

    it("changes an invite only from the revision and state it was read at", async () => {
      const store = make();
      const one = invite(A);
      await store.createInvite(one);
      await expect(store.updateInvite({ ...one, state: "pending" }, { revision: 1, state: "unconfirmed" })).rejects.toBeInstanceOf(CompanyStoreConflict);
      await expect(store.updateInvite({ ...one, state: "pending" }, { revision: 0, state: "pending" })).rejects.toBeInstanceOf(CompanyStoreConflict);
      await expect(store.updateInvite({ ...one, companyId: B, state: "pending" }, { revision: 0, state: "unconfirmed" })).rejects.toBeInstanceOf(CompanyStoreConflict);
      await store.updateInvite({ ...one, state: "pending" }, { revision: 0, state: "unconfirmed" });
      expect((await store.invite(A, one.inviteId))!.state).toBe("pending");
      // Confirmed: taking it back does nothing.
      await store.removeInvite(one);
      expect(await store.invite(A, one.inviteId)).toBeDefined();
      const two = invite(A);
      await store.createInvite(two);
      await store.removeInvite(two);
      expect(await store.invite(A, two.inviteId)).toBeUndefined();
      expect(await store.inviteByRequest(A, two.requestId)).toBeUndefined();
      expect(await store.inviteByToken(two.tokenHash)).toBeUndefined();
      // Its request id may be used again.
      await store.createInvite({ ...invite(A), requestId: two.requestId });
    });

    it("keeps the hook's install allow-list, refusing an install that does not read", async () => {
      const store = make();
      expect(await store.hookInstall(install().issuer)).toBeUndefined();
      await store.putHookInstall(install());
      expect(await store.hookInstall(install().issuer)).toEqual(install());
      expect(await store.hookInstall("https://other.example.test")).toBeUndefined();
      await expect(store.putHookInstall(install({ companyIds: ["acme"] }))).rejects.toThrow();
      await store.removeHookInstall(install().issuer);
      expect(await store.hookInstall(install().issuer)).toBeUndefined();
    });

    it("unlocks a company's trial for the first company that connects a GitHub account, and never moves it (L2-8)", async () => {
      const store = make();
      expect(await store.trial(A)).toBeUndefined();
      expect(await store.unlockTrial(4242, A, iso(NOW))).toBe("unlocked");
      expect(await store.trial(A)).toEqual({ companyId: A, githubUserId: 4242, unlockedAt: iso(NOW) });
      // A replay changes nothing (the first time stays).
      expect(await store.unlockTrial(4242, A, iso(NOW + 1))).toBe("held");
      expect(await store.trial(A)).toEqual({ companyId: A, githubUserId: 4242, unlockedAt: iso(NOW) });
      // Another company with the same GitHub account gets no trial; nothing is written for it.
      expect(await store.unlockTrial(4242, B, iso(NOW + 2))).toBe("used");
      expect(await store.trial(B)).toBeUndefined();
      expect(await store.unlockTrial(4242, A, iso(NOW + 3))).toBe("held");
      // A different GitHub account for B still can.
      expect(await store.unlockTrial(7, B, iso(NOW))).toBe("unlocked");
      expect(await store.trial(B)).toEqual({ companyId: B, githubUserId: 7, unlockedAt: iso(NOW) });
      await expect(store.unlockTrial(0, A, iso(NOW))).rejects.toThrow();
      await expect(store.unlockTrial(1.5, A, iso(NOW))).rejects.toThrow();
      await expect(store.unlockTrial(9, "acme", iso(NOW))).rejects.toThrow();
      await expect(store.trial("acme")).rejects.toThrow();
    });

    it("gives a company one trial only: a second GitHub account of an unlocked company claims nothing (L2-8)", async () => {
      const store = make();
      expect(await store.unlockTrial(1, A, iso(NOW))).toBe("unlocked");
      expect(await store.unlockTrial(2, A, iso(NOW + 1))).toBe("already");
      expect((await store.trial(A))!.githubUserId).toBe(1);
      // GitHub account 2 was not claimed by A's second try: B can still unlock with it.
      expect(await store.unlockTrial(2, B, iso(NOW + 2))).toBe("unlocked");
      // A held-by-another account and an unlocked company: the company's own trial is the answer, not "used".
      expect(await store.unlockTrial(2, A, iso(NOW + 3))).toBe("already");
    });

    it("lets exactly one of many companies racing for one GitHub account unlock, and one GitHub account of one company win (L2-8)", async () => {
      const store = make();
      const companies = ["c", "d", "e", "f", "g", "h"].map((letter) => `org_${letter.repeat(20)}`);
      const answers = await Promise.all(companies.map((company, index) => store.unlockTrial(555, company, iso(NOW + index))));
      expect(answers.filter((answer) => answer === "unlocked")).toHaveLength(1);
      expect(answers.filter((answer) => answer === "used")).toHaveLength(companies.length - 1);
      const holders = (await Promise.all(companies.map((company) => store.trial(company)))).filter((trial) => trial !== undefined);
      expect(holders).toHaveLength(1);
      // One company, many GitHub accounts at once: one trial, and the losers' accounts stay free for others.
      const accounts = [11, 12, 13, 14];
      const mine = await Promise.all(accounts.map((account) => store.unlockTrial(account, A, iso(NOW))));
      expect(mine.filter((answer) => answer === "unlocked")).toHaveLength(1);
      expect(mine.filter((answer) => answer === "already")).toHaveLength(accounts.length - 1);
      const won = (await store.trial(A))!.githubUserId;
      const losers = accounts.filter((one) => one !== won);
      expect(await store.unlockTrial(losers[0]!, B, iso(NOW))).toBe("unlocked");
    });

    it("answers the hook from the store: defaults, saved settings, and nothing for a row that does not read", async () => {
      const store = make();
      const rules = new StoreCompanyRules(store);
      expect(await rules.read(A)).toEqual(hookRulesOf(defaultCompanySettings()));
      expect(await rules.read("acme")).toBeUndefined();
      await store.putSettings(A, { ...defaultCompanySettings(), start: { allow: false, maxEstimateUsdMicros: null }, locks: { extra_review: true } }, 0, "dev", iso(NOW));
      expect(await rules.read(A)).toEqual({ start: { allow: false }, decisions: [{ what: "setting.loosen", secondPerson: true }], locks: { extra_review: true } });
      expect(await rules.read(B)).toEqual(hookRulesOf(defaultCompanySettings()));
      await store.putSettings(B, { ...defaultCompanySettings(), locks: { not_a_field: 1 } }, 0, "dev", iso(NOW));
      expect(await rules.read(B)).toBeUndefined();
      const installs = new StoreHookInstalls(store);
      await store.putHookInstall(install());
      expect(await installs.keysFor(install().issuer)).toEqual({ keys: [KEY], companyIds: [A] });
      expect(await installs.keysFor("https://code.example.test/")).toBeUndefined();
    });
  });
}

contract("LocalCompanyStore", () => new LocalCompanyStore());
contract("DynamoCompanyStore (in-memory table)", () => new DynamoCompanyStore(memoryTable() as never, "companies"));

describe("DynamoCompanyStore: a row's company is checked on every read", () => {
  it("reads nothing from a row whose company attribute is not the one its key names", async () => {
    const table = memoryTable();
    const store = new DynamoCompanyStore(table as never, "companies");
    const db = table as never as { send: (command: unknown) => Promise<unknown> };
    const theirs = invite(B, { state: "pending" });
    await db.send(new PutCommand({ TableName: "companies", Item: { pk: `COMPANY#${A}`, sk: "SETTINGS", companyId: B, settings: defaultCompanySettings(), version: 1 } }));
    await db.send(new PutCommand({ TableName: "companies", Item: { pk: `COMPANY#${A}`, sk: `INVITE#${theirs.inviteId}`, companyId: A, invite: theirs, revision: 0, inviteState: "pending" } }));
    await db.send(new PutCommand({ TableName: "companies", Item: { pk: `COMPANY#${A}`, sk: "PROFILE", companyId: A, profile: { companyId: B, name: "x", plan: "y" }, version: 1 } }));
    await db.send(new PutCommand({ TableName: "companies", Item: { pk: `COMPANY#${A}`, sk: "PENDING", companyId: A, change: change(B, 0), pendingUntil: NOW / 1000 + 100 } }));
    // A token row that names company A while the invite it points at is B's.
    await db.send(new PutCommand({ TableName: "companies", Item: { pk: `INVITETOKEN#${theirs.tokenHash}`, sk: "INVITE", companyId: A, inviteId: theirs.inviteId } }));
    expect(await store.settings(A)).toBeUndefined();
    expect(await store.invite(A, theirs.inviteId)).toBeUndefined();
    expect((await store.invites(A)).invites).toEqual([]);
    expect(await store.profile(A)).toBeUndefined();
    expect(await store.pendingChange(A, NOW)).toBeUndefined();
    expect(await store.inviteByToken(theirs.tokenHash)).toBeUndefined();
    // A token row that points at a real invite of its own company, but not the invite that token belongs to.
    const mine = invite(A, { state: "pending" });
    await store.createInvite(mine);
    const forged = "f".repeat(64);
    await db.send(new PutCommand({ TableName: "companies", Item: { pk: `INVITETOKEN#${forged}`, sk: "INVITE", companyId: A, inviteId: mine.inviteId } }));
    expect(await store.inviteByToken(forged)).toBeUndefined();
    expect(await store.inviteByToken(mine.tokenHash)).toEqual(mine);
  });

  it("lets TTL remove every invite in the end: 90 days after it closed, or after it lapsed, with its request and token rows", async () => {
    const table = memoryTable();
    const store = new DynamoCompanyStore(table as never, "companies");
    const open = invite(A);
    await store.createInvite(open);
    await store.updateInvite({ ...open, state: "pending" }, { revision: 0, state: "unconfirmed" });
    const row = () => [...table.items.values()].find((item) => item.sk === `INVITE#${open.inviteId}`)!;
    // Open: 90 days after it lapses (it is never sent to Code or accepted once lapsed).
    expect(row().expiresAt).toBe(Date.parse(open.expiresAt) / 1000 + 90 * 86_400);
    for (const sk of [`INVITEREQUEST#${open.requestId}`, "INVITE"]) expect([...table.items.values()].find((item) => item.sk === sk)!.expiresAt).toBe(Date.parse(open.expiresAt) / 1000 + 90 * 86_400);
    await store.updateInvite({ ...open, state: "revoked", revision: 1, revokedAt: iso(NOW) }, { revision: 0, state: "pending" });
    expect(row().expiresAt).toBe(NOW / 1000 + 90 * 86_400);
  });

  it("unlocks a trial in one transaction: the account's claim and the company's trial are written together or not at all (L2-8)", async () => {
    const table = memoryTable();
    const store = new DynamoCompanyStore(table as never, "companies");
    const db = table as never as { send: (command: unknown) => Promise<unknown> };
    expect(await store.unlockTrial(4242, A, iso(NOW))).toBe("unlocked");
    expect([...table.items.values()].map((item) => `${String(item.pk)}|${String(item.sk)}`).sort()).toEqual([`COMPANY#${A}|TRIAL`, "GITHUBTRIAL#4242|TRIAL"]);
    // B loses on the account: it leaves no trial row for B and no second claim.
    expect(await store.unlockTrial(4242, B, iso(NOW + 1))).toBe("used");
    expect(table.items.size).toBe(2);
    // A second account of A loses on A's own trial: it claims nothing (account 9 stays free).
    expect(await store.unlockTrial(9, A, iso(NOW + 2))).toBe("already");
    expect(table.items.size).toBe(2);
    expect(await store.unlockTrial(9, B, iso(NOW + 3))).toBe("unlocked");
    // The first #92 build wrote only the account's claim: its company unlocks from it, any other company is still refused.
    await db.send(new PutCommand({ TableName: "companies", Item: { pk: "GITHUBTRIAL#31", sk: "TRIAL", companyId: A, githubUserId: 31, claimedAt: iso(NOW) } }));
    expect(await store.unlockTrial(31, B, iso(NOW))).toBe("already");
    const fresh = "org_" + "d".repeat(20);
    expect(await store.unlockTrial(31, fresh, iso(NOW))).toBe("used");
    const stale = "org_" + "e".repeat(20);
    await db.send(new PutCommand({ TableName: "companies", Item: { pk: "GITHUBTRIAL#33", sk: "TRIAL", companyId: stale, githubUserId: 33, claimedAt: iso(NOW) } }));
    expect(await store.unlockTrial(33, stale, iso(NOW))).toBe("unlocked");
    expect(await store.trial(stale)).toEqual({ companyId: stale, githubUserId: 33, unlockedAt: iso(NOW) });
    // A replay of an unlocked company, or a second account of it, is answered from its own trial row and sends no write.
    const sent: string[] = [];
    const watched = new DynamoCompanyStore({ send: async (command: { constructor: { name: string } }) => { sent.push(command.constructor.name); return db.send(command); } } as never, "companies");
    expect(await watched.unlockTrial(33, stale, iso(NOW + 5))).toBe("held");
    expect(await watched.unlockTrial(34, stale, iso(NOW + 5))).toBe("already");
    expect(sent).toEqual(["GetCommand", "GetCommand"]);
    // A claim row that does not name a company is never a free trial.
    await db.send(new PutCommand({ TableName: "companies", Item: { pk: "GITHUBTRIAL#32", sk: "TRIAL" } }));
    expect(await store.unlockTrial(32, fresh, iso(NOW))).toBe("used");
    expect(await store.trial(fresh)).toBeUndefined();
  });

  it("reads a company's trial only from a row that is its own and names a GitHub account (L2-8)", async () => {
    const table = memoryTable();
    const store = new DynamoCompanyStore(table as never, "companies");
    const db = table as never as { send: (command: unknown) => Promise<unknown> };
    await db.send(new PutCommand({ TableName: "companies", Item: { pk: `COMPANY#${A}`, sk: "TRIAL", companyId: B, githubUserId: 5, unlockedAt: iso(NOW) } }));
    expect(await store.trial(A)).toBeUndefined();
    // A row that does not read leaves the company without a free trial: the unlock answers "used" and writes nothing.
    expect(await store.unlockTrial(5, A, iso(NOW))).toBe("used");
    expect(table.items.size).toBe(1);
    await db.send(new PutCommand({ TableName: "companies", Item: { pk: `COMPANY#${B}`, sk: "TRIAL", companyId: B, githubUserId: "5", unlockedAt: iso(NOW) } }));
    expect(await store.trial(B)).toBeUndefined();
  });

  it("reads an install by a hash of its issuer and checks the issuer it holds", async () => {
    const table = memoryTable();
    const store = new DynamoCompanyStore(table as never, "companies");
    await store.putHookInstall(install());
    const [row] = [...table.items.values()];
    expect(String(row!.pk)).toMatch(/^HOOKINSTALL#[0-9a-f]{64}$/u);
    row!.install = { ...install(), issuer: "https://evil.example.test" };
    expect(await store.hookInstall(install().issuer)).toBeUndefined();
  });
});

describe("validHookInstall", () => {
  const cases: Array<[string, unknown]> = [
    ["an http issuer", install({ issuer: "http://code.example.test" })],
    ["no keys", install({ keys: [] })],
    ["three keys", install({ keys: [KEY, { ...KEY, kid: "k2" }, { ...KEY, kid: "k3" }] })],
    ["a repeated kid", install({ keys: [KEY, { ...KEY }] })],
    ["a short modulus", install({ keys: [{ ...KEY, n: KEY.n.slice(0, 200) }] })],
    ["an EC key", install({ keys: [{ ...KEY, kty: "EC" } as never] })],
    ["another algorithm", install({ keys: [{ ...KEY, alg: "RS512" } as never] })],
    ["an extra key field", install({ keys: [{ ...KEY, d: "private" } as never] })],
    ["no companies", install({ companyIds: [] })],
    ["a company id that does not read", install({ companyIds: ["acme"] })],
    ["a repeated company", install({ companyIds: [A, A] })],
    ["an extra field", { ...install(), jwksUrl: "https://x" }],
    ["a bad time", install({ updatedAt: "yesterday" })],
  ];
  for (const [name, value] of cases) it(`refuses ${name}`, () => { expect(validHookInstall(value)).toBe(false); });
});

const docker = (() => { try { execFileSync("docker", ["info"], { stdio: "ignore" }); return true; } catch { return false; } })();
if (!docker) console.warn("company-store.test.ts: Docker isn't running, so the DynamoDB store is not tested on DynamoDB Local here.");
describe.skipIf(!docker)("DynamoCompanyStore on DynamoDB Local", () => {
  let container = "", client: DynamoDBClient | undefined, tables = 0;
  beforeAll(async () => {
    container = execFileSync("docker", ["run", "-d", "--rm", "-p", "127.0.0.1::8000", "amazon/dynamodb-local:2.6.1", "-jar", "DynamoDBLocal.jar", "-inMemory"], { encoding: "utf8" }).trim();
    const port = execFileSync("docker", ["port", container, "8000/tcp"], { encoding: "utf8" }).trim().split(":").at(-1)!;
    client = new DynamoDBClient({ endpoint: `http://127.0.0.1:${port}`, region: "us-east-1", credentials: { accessKeyId: "local", secretAccessKey: "local" } });
    for (let tries = 0; ; tries += 1) {
      try { await client.send(new CreateTableCommand({ TableName: "ready", BillingMode: "PAY_PER_REQUEST", AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }], KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }] })); break; }
      catch (error) { if (tries > 50) throw error; await new Promise((resolve) => setTimeout(resolve, 200)); }
    }
  }, 60_000);
  afterAll(() => { if (container) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); });
  const fresh = async () => {
    const name = `companies-${String(tables++)}`;
    await client!.send(new CreateTableCommand({
      TableName: name, BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [{ AttributeName: COMPANY_TABLE.partitionKey, AttributeType: "S" }, { AttributeName: COMPANY_TABLE.sortKey, AttributeType: "S" }],
      KeySchema: [{ AttributeName: COMPANY_TABLE.partitionKey, KeyType: "HASH" }, { AttributeName: COMPANY_TABLE.sortKey, KeyType: "RANGE" }],
    }));
    return new DynamoCompanyStore(cloudDocumentClient(client!), name);
  };
  // Each case gets its own table; the store is made lazily so `contract` can stay synchronous.
  const lazy = (): CompanyStore => {
    let store: Promise<DynamoCompanyStore> | undefined;
    return new Proxy({} as CompanyStore, { get: (_target, name) => async (...args: unknown[]) => { store ??= fresh(); const real = await store; return (real as never as Record<string, (...a: unknown[]) => unknown>)[name as string]!(...args); } });
  };
  contract("on DynamoDB Local", lazy);
});
