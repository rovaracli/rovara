import { describe, expect, it } from "vitest";
import { UI_FLAG_CATALOG, UI_FLAG_NAMES, orgUiFlagsKey, uiFlagDefaultOn, uiFlagEnabled, uiFlagState, type UiFlagName } from "@agentx/cloud-contracts";
import { type OrgId } from "@rovara-code/contracts";
import { ALL_OFF, adminAnswerOf, navUiFlags, readUiFlags, settingsFromItem, uiFlagsMapOf, writeUiFlags } from "../../packages/broker/src/org/ui-flags/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// Decision 116 (NEW-SCREENS-ON-BY-DEFAULT): a finished (wired) screen is on for a company that never chose; a company's pressed `off` still wins; the operator's override wins over both;
// an unfinished screen stays off. And the versions around it: rows written before decision 116, an older broker reading rows this one wrote (a rollback).

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const WIRED = ["look", "nav", "home", "work", "spending", "leadingHeader", "insights", "continue"] as const;
const UNFINISHED = ["health", "setup", "publish", "billing", "agreement", "companies"] as const;
const none: ReadonlySet<UiFlagName> = new Set();
const forcing = (...names: UiFlagName[]): ReadonlySet<UiFlagName> => new Set(names);
const row = (flags: Record<string, unknown>, extra: Record<string, unknown> = {}) => settingsFromItem({ flags, previews: false, revision: 3, changedAt: "2026-11-10T09:00:00.000Z", ...extra });

/** How a broker from before decision 116 turned a stored row into the navigation answer (absent = off). */
const olderBrokerMap = (flags: Record<string, unknown>, previews: boolean, forced: ReadonlySet<string>) =>
  Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, uiFlagState({ enabled: flags[name] === true, previews, forcedOff: forced.has(name) })]));

describe("the default", () => {
  it("is on for exactly the wired screens, and an explicit per-name default says so in the catalog", () => {
    expect(UI_FLAG_NAMES.filter(uiFlagDefaultOn)).toEqual([...WIRED]);
    for (const entry of UI_FLAG_CATALOG) {
      // Only a wired screen may be on by default.
      if (entry.defaultOn) expect(entry.wired, entry.name).toBe(true);
      expect(uiFlagDefaultOn(entry.name), entry.name).toBe(entry.wired && entry.defaultOn);
    }
    for (const name of UNFINISHED) expect(uiFlagDefaultOn(name), name).toBe(false);
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
  for (const name of UI_FLAG_NAMES) {
    const wired = (WIRED as readonly string[]).includes(name);
    it(`${name}: nothing stored is ${wired ? "on" : "off"}; stored off is off (preview with previews); stored on is on; forced off is off over all of them`, () => {
      expect(uiFlagsMapOf(settingsFromItem(undefined), none)[name]).toBe(wired ? "on" : "off");
      expect(uiFlagsMapOf(row({ [name]: false }), none)[name]).toBe("off");
      expect(uiFlagsMapOf(row({ [name]: false }, { previews: true }), none)[name]).toBe("preview");
      expect(uiFlagsMapOf(row({ [name]: true }), none)[name]).toBe("on");
      // The operator's override beats the new default, a pressed on, and a preview.
      expect(uiFlagsMapOf(settingsFromItem(undefined), forcing(name))[name]).toBe("off");
      expect(uiFlagsMapOf(row({ [name]: true }, { previews: true }), forcing(name))[name]).toBe("off");
      expect(uiFlagsMapOf(row({}, { previews: true }), forcing(name))[name]).toBe("off");
    });
  }

  it("`all` forced off is every flag off for a company on the defaults: the old screens for everyone", () => {
    expect(uiFlagsMapOf(settingsFromItem(undefined), new Set(UI_FLAG_NAMES))).toEqual(ALL_OFF);
  });

  it("the admin answer agrees: `enabled` is the switch in force (the default included), `state` what people get", () => {
    const answer = adminAnswerOf(row({ home: false, health: true }), forcing("look"));
    const of = (name: UiFlagName) => answer.flags.find((entry) => entry.name === name);
    expect(of("look")).toMatchObject({ enabled: true, forcedOff: true, state: "off" });
    expect(of("nav")).toMatchObject({ enabled: true, forcedOff: false, state: "on" });
    expect(of("home")).toMatchObject({ enabled: false, forcedOff: false, state: "off" });
    expect(of("health")).toMatchObject({ enabled: true, state: "on" });
    expect(of("companies")).toMatchObject({ enabled: false, state: "off" });
  });
});

describe("across versions", () => {
  it("a row written before decision 116 keeps its pressed values (a pressed off is the company's choice of the old screen); names nobody pressed take the new default", () => {
    // What a 0.5.14 broker stored after an admin turned look and insights on, then nav on and off again.
    const before = row({ look: true, insights: true, nav: false });
    expect(uiFlagsMapOf(before, none)).toEqual({ ...Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, uiFlagDefaultOn(name) ? "on" : "off"])), nav: "off" });
  });

  it("this broker stores only what was pressed, so a rollback to an older broker reads every unpressed name as it always did (off) and keeps every pressed value", async () => {
    const db = new FakeDynamoDb();
    const deps = { documentClient: db, tableName: "state", now: () => Date.UTC(2026, 10, 12, 9), audit: capturingAuditDeps({ db }).audit };
    await writeUiFlags(deps, { orgId: ORG, developerId: "a".repeat(64), expectedRevision: 0, change: { flags: { home: false, health: true } } });
    const stored = db.get(orgUiFlagsKey(ORG)) as { flags: Record<string, unknown>; previews: boolean; revision: number };
    expect(stored.flags).toEqual({ home: false, health: true });
    // The older broker: today's screens for every name, except the one the company turned on.
    expect(olderBrokerMap(stored.flags, stored.previews, new Set())).toEqual({ ...ALL_OFF, health: "on" });
    // The older broker writes the same way (the row's map plus the pressed name), so rolling forward again reads that company's choices, and the defaults for the rest.
    db.set({ ...orgUiFlagsKey(ORG), ...stored, flags: { ...stored.flags, nav: false }, revision: stored.revision + 1 });
    expect(uiFlagsMapOf(await readUiFlags(deps, ORG), none)).toMatchObject({ home: "off", nav: "off", health: "on", look: "on", work: "on", setup: "off" });
  });

  it("a failed read is still the old screens (ALL_OFF), not the defaults: it cannot tell whether the company chose the old screen", async () => {
    const broken = { documentClient: { send: async () => { throw new Error("down"); } }, tableName: "state", now: () => 0 } as never;
    expect(await navUiFlags(broken, ORG, {})).toEqual(ALL_OFF);
  });
});
