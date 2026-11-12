import { describe, expect, it } from "vitest";
import { REMOVED_UI_FLAG_NAMES, UI_FLAG_CATALOG, UI_FLAG_NAMES, orgUiFlagsKey, uiFlagDefaultOn, uiFlagEnabled, uiFlagState, type UiFlagName } from "@agentx/cloud-contracts";
import { type OrgId } from "@rovara-code/contracts";
import { ALL_OFF, adminAnswerOf, navUiFlags, readUiFlags, settingsFromItem, uiFlagsMapOf, writeUiFlags } from "../../packages/broker/src/org/ui-flags/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// Decision 116 (a finished screen may be on by default) and decision 125 (the eight finished screens are no flags any more): the store and the answers for the flags that are left (the screens still being
// finished, all off by default), the removed names in stored rows, "back to the default" (null), and the versions around both.

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const RESERVED = ["health", "setup", "publish", "billing", "agreement", "companies"] as const;
const none: ReadonlySet<UiFlagName> = new Set();
const forcing = (...names: UiFlagName[]): ReadonlySet<UiFlagName> => new Set(names);
const row = (flags: Record<string, unknown>, extra: Record<string, unknown> = {}) => settingsFromItem({ flags, previews: false, revision: 3, changedAt: "2026-11-10T09:00:00.000Z", ...extra });
const storeDeps = () => { const db = new FakeDynamoDb();return { db, deps: { documentClient: db, tableName: "state", now: () => Date.UTC(2026, 10, 12, 9), audit: capturingAuditDeps({ db }).audit } }; };
const ME = "a".repeat(64);

/** How a broker from before decision 116 (0.5.14) turned a stored row into the navigation answer: absent = off, over the fourteen names it knew. */
const OLDER_NAMES = ["look", "nav", "home", "work", "spending", "leadingHeader", "health", "setup", "insights", "publish", "billing", "agreement", "companies", "continue"] as const;
const olderBrokerMap = (flags: Record<string, unknown>, previews: boolean) =>
  Object.fromEntries(OLDER_NAMES.map((name) => [name, uiFlagState({ enabled: flags[name] === true, previews, forcedOff: false })]));

describe("the default", () => {
  it("is off for every flag that is left (none is finished yet), and only a wired screen may be on by default", () => {
    expect(UI_FLAG_NAMES.filter(uiFlagDefaultOn)).toEqual([]);
    for (const entry of UI_FLAG_CATALOG) {
      if (entry.defaultOn) expect(entry.wired, entry.name).toBe(true);
      expect(uiFlagDefaultOn(entry.name), entry.name).toBe(entry.wired && entry.defaultOn);
    }
  });

  it("a stored choice wins over the default, both ways", () => {
    for (const name of UI_FLAG_NAMES) {
      expect(uiFlagEnabled(name, undefined), name).toBe(uiFlagDefaultOn(name));
      expect(uiFlagEnabled(name, false), name).toBe(false);
      expect(uiFlagEnabled(name, true), name).toBe(true);
    }
  });
});

describe("the matrix, for every flag, as the navigation answer says it", () => {
  for (const name of RESERVED) {
    it(`${name}: nothing stored is off; stored off is off (preview with previews); stored on is on; forced off is off over all of them`, () => {
      expect(uiFlagsMapOf(settingsFromItem(undefined), none)[name]).toBe("off");
      expect(uiFlagsMapOf(row({ [name]: false }), none)[name]).toBe("off");
      expect(uiFlagsMapOf(row({ [name]: false }, { previews: true }), none)[name]).toBe("preview");
      expect(uiFlagsMapOf(row({ [name]: true }), none)[name]).toBe("on");
      expect(uiFlagsMapOf(row({ [name]: true }, { previews: true }), forcing(name))[name]).toBe("off");
      expect(uiFlagsMapOf(row({}, { previews: true }), forcing(name))[name]).toBe("off");
    });
  }

  it("the navigation answer and the admin answer name only the flags that are left: never a removed name", () => {
    const stored = row(Object.fromEntries<boolean>([...REMOVED_UI_FLAG_NAMES.map((name): [string, boolean] => [name, false]), ["health", true]]), { previews: true });
    const map = uiFlagsMapOf(stored, none);
    expect(Object.keys(map)).toEqual([...RESERVED]);
    expect(map.health).toBe("on");
    const answer = adminAnswerOf(stored, forcing("setup"));
    expect(answer.flags.map((entry) => entry.name)).toEqual([...RESERVED]);
    expect(answer.flags.find((entry) => entry.name === "setup")).toMatchObject({ enabled: false, forcedOff: true, state: "off" });
    expect(answer.flags.find((entry) => entry.name === "health")).toMatchObject({ enabled: true, forcedOff: false, state: "on" });
    expect(Object.keys(ALL_OFF)).toEqual([...RESERVED]);
  });
});

describe("stored rows", () => {
  it("a removed name stored before decision 125 is ignored when read, whatever its value", () => {
    for (const name of REMOVED_UI_FLAG_NAMES) {
      const settings = row({ [name]: false });
      expect(settings.flags, name).toEqual({});
      expect(settings.malformed, name).toBeUndefined();
    }
  });

  it("this broker never writes a removed name: a later change drops the ones an older broker stored, and keeps the company's other choices", async () => {
    const { db, deps } = storeDeps();
    db.set({ ...orgUiFlagsKey(ORG), entityType: "UI_FLAGS", flags: { home: false, look: true, health: true }, previews: false, revision: 4, changedAt: "2026-11-10T09:00:00.000Z" });
    await writeUiFlags(deps, { orgId: ORG, developerId: ME, expectedRevision: 4, change: { flags: { setup: true } } });
    const stored = db.get(orgUiFlagsKey(ORG)) as { flags: Record<string, unknown> };
    expect(stored.flags).toEqual({ health: true, setup: true });
  });

  it("a value that is not a boolean reads as off (fail closed) but is not carried into the next write", async () => {
    const { db, deps } = storeDeps();
    db.set({ ...orgUiFlagsKey(ORG), entityType: "UI_FLAGS", flags: { health: "yes", billing: 1, setup: true, agreement: false }, previews: false, revision: 2, changedAt: "2026-11-10T09:00:00.000Z" });
    const read = await readUiFlags(deps, ORG);
    expect(read.flags).toEqual({ health: false, billing: false, setup: true, agreement: false });
    expect([...(read.malformed ?? [])].sort()).toEqual(["billing", "health"]);
    expect(uiFlagsMapOf(read, none)).toMatchObject({ health: "off", billing: "off", setup: "on" });
    await writeUiFlags(deps, { orgId: ORG, developerId: ME, expectedRevision: 2, change: { previews: true } });
    expect((db.get(orgUiFlagsKey(ORG)) as { flags: Record<string, unknown> }).flags).toEqual({ setup: true, agreement: false });
  });

  it("null for a name removes the stored choice (F2): an explicit true never pins a company against a later default", async () => {
    const { db, deps } = storeDeps();
    await writeUiFlags(deps, { orgId: ORG, developerId: ME, expectedRevision: 0, change: { flags: { health: true, setup: false } } });
    expect((db.get(orgUiFlagsKey(ORG)) as { flags: Record<string, unknown> }).flags).toEqual({ health: true, setup: false });
    const written = await writeUiFlags(deps, { orgId: ORG, developerId: ME, expectedRevision: 1, change: { flags: { health: null } } });
    const stored = db.get(orgUiFlagsKey(ORG)) as { flags: Record<string, unknown>; revision: number };
    expect(stored.flags).toEqual({ setup: false });
    expect(stored.revision).toBe(2);
    // Back on the default: whatever the catalog says now, and later.
    expect(uiFlagEnabled("health", written.flags.health)).toBe(uiFlagDefaultOn("health"));
    expect(adminAnswerOf(written, none).flags.find((entry) => entry.name === "health")).toMatchObject({ enabled: uiFlagDefaultOn("health") });
    // null on a name nobody pressed changes nothing stored (the write still moves the revision, as every write does).
    await writeUiFlags(deps, { orgId: ORG, developerId: ME, expectedRevision: 2, change: { flags: { billing: null } } });
    expect((db.get(orgUiFlagsKey(ORG)) as { flags: Record<string, unknown> }).flags).toEqual({ setup: false });
  });
});

describe("across versions", () => {
  it("a rollback to an older broker reads this broker's rows as it always did: the removed names are absent (off, its old screens) and every pressed value is kept", async () => {
    const { db, deps } = storeDeps();
    await writeUiFlags(deps, { orgId: ORG, developerId: ME, expectedRevision: 0, change: { flags: { health: true } } });
    const stored = db.get(orgUiFlagsKey(ORG)) as { flags: Record<string, unknown>; previews: boolean; revision: number };
    expect(stored.flags).toEqual({ health: true });
    const older = olderBrokerMap(stored.flags, stored.previews);
    expect(older).toEqual({ ...Object.fromEntries(OLDER_NAMES.map((name) => [name, "off"])), health: "on" });
    // The older broker writes the same way (the row's map plus the pressed name); rolling forward again ignores the removed name it wrote and keeps the rest.
    db.set({ ...orgUiFlagsKey(ORG), ...stored, flags: { ...stored.flags, nav: true }, revision: stored.revision + 1 });
    expect(uiFlagsMapOf(await readUiFlags(deps, ORG), none)).toEqual({ ...ALL_OFF, health: "on" });
  });

  it("a failed read is still every flag off (ALL_OFF)", async () => {
    const broken = { documentClient: { send: async () => { throw new Error("down"); } }, tableName: "state", now: () => 0 } as never;
    expect(await navUiFlags(broken, ORG, {})).toEqual(ALL_OFF);
  });
});
