import { describe, expect, it } from "vitest";
import { z } from "zod";
import { forwardReader } from "@rovara-code/contracts";
import { AppNavReaderSchema, UI_FLAG_CATALOG, UI_FLAG_NAMES, UiFlagsAdminAnswerReaderSchema, UiFlagsAdminAnswerSchema, UiFlagsBodySchema, UiFlagsMapSchema, uiFlagState, uiFlagsForcedOff } from "@agentx/cloud-contracts";
import * as web from "@agentx/cloud-contracts/web";

describe("the closed list of flag names", () => {
  it("has the switches that exist today and the reserved names, each once, with a catalog row each", () => {
    expect([...UI_FLAG_NAMES]).toEqual(["look", "nav", "home", "work", "spending", "leadingHeader", "health", "setup", "insights", "publish", "billing", "agreement", "companies", "continue"]);
    expect(new Set(UI_FLAG_NAMES).size).toBe(UI_FLAG_NAMES.length);
    expect(UI_FLAG_CATALOG.map((entry) => entry.name)).toEqual([...UI_FLAG_NAMES]);
    for (const entry of UI_FLAG_CATALOG) { expect(entry.label.length).toBeGreaterThan(0);expect(entry.summary.length).toBeGreaterThan(0); }
    expect(UI_FLAG_CATALOG.filter((entry) => entry.wired).map((entry) => entry.name)).toEqual(["look", "nav", "home", "work", "spending", "leadingHeader", "insights", "continue"]);
  });
  it("is the same list in the browser entry", () => { expect(web.UI_FLAG_NAMES).toEqual(UI_FLAG_NAMES); });
  it("refuses unknown names in the body and in the nav map", () => {
    expect(UiFlagsBodySchema.safeParse({ expectedRevision: 0, flags: { look: true } }).success).toBe(true);
    expect(UiFlagsBodySchema.safeParse({ expectedRevision: 0, flags: { companyRules: true } }).success).toBe(false);
    expect(UiFlagsMapSchema.safeParse({ companyRules: "on" }).success).toBe(false);
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
  it("reads the operator's value, failing closed", () => {
    expect(uiFlagsForcedOff(undefined)).toEqual({ names: new Set(), unreadable: false });
    expect(uiFlagsForcedOff("none").names.size).toBe(0);
    expect(uiFlagsForcedOff("all").names.size).toBe(UI_FLAG_NAMES.length);
    expect([...uiFlagsForcedOff("look-nav").names]).toEqual(["look", "nav"]);
    expect(uiFlagsForcedOff("look-typo")).toMatchObject({ unreadable: true });
    expect(uiFlagsForcedOff("look-typo").names.size).toBe(UI_FLAG_NAMES.length);
  });
});

describe("the company switcher and Continue in your own tool (decision 98), across versions", () => {
  // The twelve names a broker or browser from before decision 98 knows.
  const OLDER = ["look", "nav", "home", "work", "spending", "leadingHeader", "health", "setup", "insights", "publish", "billing", "agreement"] as const;
  const navWith = (uiFlags: Record<string, string>) => ({
    me: { developerId: "a".repeat(64), name: "Maya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] },
    features: { localAgents: false, usage: false, admin: true, chains: false, notices: false, describe: false }, uiFlags,
  });
  const row = (name: string, extra: Record<string, unknown> = {}) => ({ name, label: name, summary: name, wired: true, enabled: false, forcedOff: false, state: "off", ...extra });

  it("names both with plain words (continue wired, companies not yet), within the admin answer's limits", () => {
    // Not offered in New screens until the broker answers /v1/app/companies; the name is still accepted, stored and sent.
    expect(UI_FLAG_CATALOG.find((entry) => entry.name === "companies")).toMatchObject({ label: "Companies", wired: false });
    expect(UI_FLAG_CATALOG.find((entry) => entry.name === "continue")).toMatchObject({ label: "Continue in your own tool", wired: true });
    for (const entry of UI_FLAG_CATALOG) { expect(entry.label.length).toBeLessThanOrEqual(80);expect(entry.summary.length).toBeLessThanOrEqual(240); }
    expect(UiFlagsBodySchema.safeParse({ expectedRevision: 0, flags: { companies: true, continue: false } }).success).toBe(true);
    expect(UiFlagsMapSchema.safeParse({ companies: "on", continue: "preview" }).success).toBe(true);
    // The operator's value: the names are letters only, so they join with a hyphen like the others.
    expect([...uiFlagsForcedOff("companies-continue").names]).toEqual(["companies", "continue"]);
  });

  it("a newer browser reads an older broker's navigation answer (neither name) and admin answer (twelve rows)", () => {
    const nav = AppNavReaderSchema.parse(navWith(Object.fromEntries(OLDER.map((name) => [name, "on"]))));
    expect(nav.uiFlags?.companies).toBeUndefined();expect(nav.uiFlags?.continue).toBeUndefined();
    const admin = UiFlagsAdminAnswerReaderSchema.parse({ revision: 1, previews: false, flags: OLDER.map((name) => row(name)) });
    expect(admin.flags.map((entry) => entry.name)).toEqual([...OLDER]);
  });

  it("an older browser reads a newer broker's answers: its readers are forward readers, so the two names are ignored, not refused", () => {
    // Built the way the older contract built its readers: the same schemas with the twelve older names.
    const olderMap = z.object(Object.fromEntries(OLDER.map((name) => [name, z.enum(["on", "preview", "off"]).optional()]))).strict();
    const olderNavReader = forwardReader(z.object({ uiFlags: olderMap.optional() }).strict());
    const olderAdminReader = forwardReader(z.object({ revision: z.number().int().min(0), previews: z.boolean(), flags: z.array(z.object({ name: z.enum(OLDER), label: z.string(), summary: z.string(), wired: z.boolean(), enabled: z.boolean(), forcedOff: z.boolean(), state: z.enum(["on", "preview", "off"]) }).strict()).max(OLDER.length) }).strict());
    const newer = Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, "on"]));
    expect(olderNavReader.safeParse({ uiFlags: newer }).success).toBe(true);
    const admin = olderAdminReader.safeParse({ revision: 1, previews: false, flags: UI_FLAG_NAMES.map((name) => row(name)) });
    expect(admin.success).toBe(true);
    // The rows it does not know read with the name "unknown" (the screen hides them), and the row limit is not enforced by a reader.
    expect(admin.data?.flags).toHaveLength(UI_FLAG_NAMES.length);
    expect(admin.data?.flags.slice(OLDER.length).map((entry) => entry.name)).toEqual(["unknown", "unknown"]);
    // And the strict schema (what an older broker's own checks would apply) does refuse them: only the readers are open.
    expect(olderMap.safeParse(newer).success).toBe(false);
  });

  it("this browser reads a later broker's answers the same way: a name it does not know is ignored, and more rows still read", () => {
    const nav = AppNavReaderSchema.safeParse(navWith({ ...Object.fromEntries(UI_FLAG_NAMES.map((name) => [name, "off"])), laterScreen: "on", companies: "sideways" }));
    expect(nav.success).toBe(true);
    const admin = UiFlagsAdminAnswerReaderSchema.safeParse({ revision: 1, previews: false, flags: [...UI_FLAG_NAMES.map((name) => row(name)), row("laterScreen", { state: "on" })] });
    expect(admin.success).toBe(true);
    expect(admin.data?.flags).toHaveLength(UI_FLAG_NAMES.length + 1);
  });
});
