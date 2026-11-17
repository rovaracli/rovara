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

    it("confirms an unconfirmed invite under Code's token hash in one write: the old hash names nothing, the new one names it (DEC 254h)", async () => {
      const store = make();
      const one = invite(A);
      await store.createInvite(one);
      const next = randomBytes(32).toString("hex");
      const confirmed: InviteRecord = { ...one, state: "pending", tokenHash: next, codeSecret: true };
      // Only from unconfirmed at its revision.
      await expect(store.confirmInvite({ ...one, revision: 1 }, { ...confirmed, revision: 1 })).rejects.toBeInstanceOf(CompanyStoreConflict);
      // Never another invite, another company, or a state other than pending.
      await expect(store.confirmInvite(one, { ...confirmed, inviteId: invite(A).inviteId })).rejects.toThrow();
      await expect(store.confirmInvite(one, { ...confirmed, companyId: B })).rejects.toThrow();
      await expect(store.confirmInvite(one, { ...confirmed, state: "accepted" })).rejects.toThrow();
      await expect(store.confirmInvite(one, { ...confirmed, requestId: invite(A).requestId })).rejects.toThrow();
      // Another invite already holds the new hash.
      const other = invite(A);
      await store.createInvite(other);
      await expect(store.confirmInvite(one, { ...confirmed, tokenHash: other.tokenHash })).rejects.toBeInstanceOf(CompanyStoreConflict);
      expect(await store.invite(A, one.inviteId)).toEqual(one);
      await store.confirmInvite(one, confirmed);
      expect(await store.invite(A, one.inviteId)).toEqual(confirmed);
      expect(await store.inviteByToken(next)).toEqual(confirmed);
      expect(await store.inviteByToken(one.tokenHash)).toBeUndefined();
      // Once: it isn't unconfirmed any more.
      await expect(store.confirmInvite(one, { ...confirmed, tokenHash: randomBytes(32).toString("hex") })).rejects.toBeInstanceOf(CompanyStoreConflict);
      expect(await store.inviteByToken(next)).toEqual(confirmed);
      // An invite already made pending (under its own token) is never re-keyed.
      const own = invite(A);
      await store.createInvite(own);
      await store.updateInvite({ ...own, state: "pending" }, { revision: 0, state: "unconfirmed" });
      await expect(store.confirmInvite(own, { ...own, state: "pending", tokenHash: randomBytes(32).toString("hex") })).rejects.toBeInstanceOf(CompanyStoreConflict);
      expect(await store.inviteByToken(own.tokenHash)).toMatchObject({ inviteId: own.inviteId, state: "pending" });
      // The other company's invite is untouched.
      expect(await store.inviteByToken(other.tokenHash)).toEqual(other);
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

    it("gives a GitHub account's one trial to the first company that connects it, and never moves it (guided onboarding PR 2)", async () => {
      const store = make();
      expect(await store.claimGithubTrial(4242, A, iso(NOW))).toBe("claimed");
      expect(await store.claimGithubTrial(4242, A, iso(NOW + 1))).toBe("held");
      expect(await store.claimGithubTrial(4242, B, iso(NOW + 2))).toBe("other");
      // Still A's after B asked.
      expect(await store.claimGithubTrial(4242, A, iso(NOW + 3))).toBe("held");
      expect(await store.claimGithubTrial(7, B, iso(NOW))).toBe("claimed");
      await expect(store.claimGithubTrial(0, A, iso(NOW))).rejects.toThrow();
      await expect(store.claimGithubTrial(1.5, A, iso(NOW))).rejects.toThrow();
      await expect(store.claimGithubTrial(9, "acme", iso(NOW))).rejects.toThrow();
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
