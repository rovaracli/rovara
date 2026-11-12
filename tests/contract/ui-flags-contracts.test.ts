import { describe, expect, it } from "vitest";
import { z } from "zod";
import { forwardReader } from "@rovara-code/contracts";
import { AppNavReaderSchema, AppNavSchema, REMOVED_UI_FLAG_NAMES, UI_FLAG_CATALOG, UI_FLAG_NAMES, UiFlagsAdminAnswerReaderSchema, UiFlagsAdminAnswerSchema, UiFlagsBodySchema, UiFlagsMapSchema, isRemovedUiFlagName, uiFlagDefaultOn, uiFlagState, uiFlagsForcedOff } from "@agentx/cloud-contracts";
import * as web from "@agentx/cloud-contracts/web";

// Decision 125 (2026-11-12, "delete now"): the eight finished screens are no flags any more. Their names are kept, explicitly, only so that older values naming them are ignored.
const FINISHED = ["look", "nav", "home", "work", "spending", "leadingHeader", "insights", "continue"] as const;
const RESERVED = ["health", "setup", "publish", "billing", "agreement", "companies"] as const;

describe("the closed list of flag names", () => {
  it("holds only the screens still being finished, each once, with a catalog row each, none of them on by default yet", () => {
    expect([...UI_FLAG_NAMES]).toEqual([...RESERVED]);
    expect(new Set(UI_FLAG_NAMES).size).toBe(UI_FLAG_NAMES.length);
    expect(UI_FLAG_CATALOG.map((entry) => entry.name)).toEqual([...UI_FLAG_NAMES]);
    for (const entry of UI_FLAG_CATALOG) { expect(entry.label.length).toBeGreaterThan(0);expect(entry.label.length).toBeLessThanOrEqual(80);expect(entry.summary.length).toBeGreaterThan(0);expect(entry.summary.length).toBeLessThanOrEqual(240); }
    expect(UI_FLAG_CATALOG.filter((entry) => entry.wired)).toEqual([]);
    for (const name of UI_FLAG_NAMES) expect(uiFlagDefaultOn(name), name).toBe(false);
  });
  it("lists the eight removed names explicitly, apart from the closed list", () => {
    expect([...REMOVED_UI_FLAG_NAMES]).toEqual([...FINISHED]);
    for (const name of FINISHED) { expect(isRemovedUiFlagName(name)).toBe(true);expect((UI_FLAG_NAMES as readonly string[]).includes(name), name).toBe(false); }
    for (const name of [...RESERVED, "lok", "companyRules", "", "Look"]) expect(isRemovedUiFlagName(name), name).toBe(false);
  });
  it("is the same in the browser entry", () => { expect(web.UI_FLAG_NAMES).toEqual(UI_FLAG_NAMES);expect(web.REMOVED_UI_FLAG_NAMES).toEqual(REMOVED_UI_FLAG_NAMES); });
  it("refuses unknown names in the body and in the nav map, a removed name included (nothing is written for it)", () => {
    expect(UiFlagsBodySchema.safeParse({ expectedRevision: 0, flags: { health: true } }).success).toBe(true);
    expect(UiFlagsBodySchema.safeParse({ expectedRevision: 0, flags: { companyRules: true } }).success).toBe(false);
    for (const name of FINISHED) expect(UiFlagsBodySchema.safeParse({ expectedRevision: 0, flags: { [name]: false } }).success, name).toBe(false);
    expect(UiFlagsMapSchema.safeParse({ companyRules: "on" }).success).toBe(false);
    expect(UiFlagsMapSchema.safeParse({ look: "on" }).success).toBe(false);
  });
  it("takes null for a name: back to the default (F2), and nothing else", () => {
    expect(UiFlagsBodySchema.parse({ expectedRevision: 2, flags: { health: null } }).flags).toEqual({ health: null });
    expect(UiFlagsBodySchema.safeParse({ expectedRevision: 2, flags: { health: "default" } }).success).toBe(false);
    // An older broker's body schema (booleans only) refuses null: it never misreads it as false.
    const older = z.object({ expectedRevision: z.number(), flags: z.object({ health: z.boolean().optional() }).strict().optional() }).strict();
    expect(older.safeParse({ expectedRevision: 2, flags: { health: null } }).success).toBe(false);
  });
  it("answers parse their own schema", () => {
    expect(UiFlagsAdminAnswerSchema.safeParse({ revision: 0, previews: false, flags: UI_FLAG_CATALOG.map((entry) => ({ name: entry.name, label: entry.label, summary: entry.summary, wired: entry.wired, enabled: false, forcedOff: false, state: "off" })) }).success).toBe(true);
  });
});

describe("what a person gets", () => {
  it("is off unless the company turned it on or allows previews, and the operator's hold wins over both", () => {
    expect(uiFlagState({ enabled: false, previews: false, forcedOff: false })).toBe("off");
    expect(uiFlagState({ enabled: true, previews: false, forcedOff: false })).toBe("on");
    expect(uiFlagState({ enabled: false, previews: true, forcedOff: false })).toBe("preview");
    expect(uiFlagState({ enabled: true, previews: true, forcedOff: false })).toBe("on");
    expect(uiFlagState({ enabled: true, previews: true, forcedOff: true })).toBe("off");
    expect(uiFlagState({ enabled: false, previews: true, forcedOff: true })).toBe("off");
  });
});

describe("the operator's override (`uo`)", () => {
  it("reads none, all and a list of known names", () => {
    expect(uiFlagsForcedOff(undefined)).toEqual({ names: new Set(), unreadable: false });
    expect(uiFlagsForcedOff("").names.size).toBe(0);
    expect(uiFlagsForcedOff("none").names.size).toBe(0);
    expect(uiFlagsForcedOff("all")).toEqual({ names: new Set(RESERVED), unreadable: false });
    expect([...uiFlagsForcedOff("health-setup").names]).toEqual(["health", "setup"]);
  });
  it("ignores each of the eight removed names, alone or beside known names, and keeps the rest of the list", () => {
    for (const name of FINISHED) {
      expect(uiFlagsForcedOff(name), name).toEqual({ names: new Set(), unreadable: false });
      expect(uiFlagsForcedOff(`${name}-health`), name).toEqual({ names: new Set(["health"]), unreadable: false });
      expect(uiFlagsForcedOff(`billing-${name}`), name).toEqual({ names: new Set(["billing"]), unreadable: false });
    }
    // The value a pre-0.5.15 operator would have set to hold everything back by name.
    expect(uiFlagsForcedOff(FINISHED.join("-"))).toEqual({ names: new Set(), unreadable: false });
    expect(uiFlagsForcedOff([...FINISHED.slice(0, 3), "companies"].join("-"))).toEqual({ names: new Set(["companies"]), unreadable: false });
  });
  it("still fails CLOSED on any other unknown name: every remaining screen off", () => {
    for (const value of ["lok", "look-typo", "health-typo", "typo-look", "Look", "Health", "look-", "-look", "look--health", "look nav", "companyRules", "insight", "continues"]) {
      expect(uiFlagsForcedOff(value), value).toEqual({ names: new Set(RESERVED), unreadable: true });
    }
  });
});

describe("across versions", () => {
  const navWith = (extra: Record<string, unknown>) => ({
    me: { developerId: "a".repeat(64), name: "Maya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] },
    features: { localAgents: false, usage: false, admin: true, chains: false, notices: false, describe: false }, ...extra,
  });
  const row = (name: string, extra: Record<string, unknown> = {}) => ({ name, label: name, summary: name, wired: true, enabled: false, forcedOff: false, state: "off", ...extra });
  // The fourteen names the 0.5.15 default-on broker (and 0.5.14, which lacked companies and continue) sent.
  const OLDER = [...FINISHED.slice(0, 6), "health", "setup", "insights", "publish", "billing", "agreement", "companies", "continue"] as const;

  it("this browser reads an older broker's navigation answer (with the removed names) and admin answer (fourteen rows) without refusing them", () => {
    const nav = AppNavReaderSchema.safeParse(navWith({ uiFlags: Object.fromEntries(OLDER.map((name) => [name, "off"])) }));
    expect(nav.success).toBe(true);
    expect(nav.data?.uiFlags?.health).toBe("off");
    // No insights field from an older broker: absent, which the app reads as "ask, as before".
    expect(nav.data?.insights).toBeUndefined();
    const admin = UiFlagsAdminAnswerReaderSchema.safeParse({ revision: 1, previews: false, flags: OLDER.map((name) => row(name)) });
    expect(admin.success).toBe(true);
  });

  it("an older browser reads this broker's answers: the removed names are absent (its readers have every key optional) and the insights field is ignored", () => {
    const olderMap = z.object(Object.fromEntries(OLDER.map((name) => [name, z.enum(["on", "preview", "off"]).optional()]))).strict();
    const olderNavReader = forwardReader(z.object({ uiFlags: olderMap.optional() }).strict());
    const newer = Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, "off"]));
    const read = olderNavReader.safeParse({ uiFlags: newer, insights: false });
    expect(read.success).toBe(true);
    for (const name of FINISHED) expect((read.data?.uiFlags as Record<string, unknown> | undefined)?.[name], name).toBeUndefined();
  });

  it("this broker's own nav answer carries the insights switch as a boolean, additively", () => {
    expect(AppNavSchema.safeParse(navWith({ uiFlags: {}, insights: false })).success).toBe(true);
    expect(AppNavSchema.safeParse(navWith({ uiFlags: {}, insights: true })).success).toBe(true);
    expect(AppNavSchema.safeParse(navWith({ uiFlags: {}, insights: "1" })).success).toBe(false);
  });
});
