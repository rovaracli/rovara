import { describe, expect, it } from "vitest";
import { UI_FLAG_CATALOG, UI_FLAG_NAMES, UiFlagsAdminAnswerSchema, UiFlagsBodySchema, UiFlagsMapSchema, uiFlagState, uiFlagsForcedOff } from "@agentx/contracts";
import * as web from "@agentx/contracts/web";

describe("the closed list of flag names", () => {
  it("has the switches that exist today and the reserved names, each once, with a catalog row each", () => {
    expect([...UI_FLAG_NAMES]).toEqual(["look", "nav", "home", "work", "spending", "leadingHeader", "health", "setup", "insights", "publish", "billing", "agreement"]);
    expect(new Set(UI_FLAG_NAMES).size).toBe(UI_FLAG_NAMES.length);
    expect(UI_FLAG_CATALOG.map((entry) => entry.name)).toEqual([...UI_FLAG_NAMES]);
    for (const entry of UI_FLAG_CATALOG) { expect(entry.label.length).toBeGreaterThan(0);expect(entry.summary.length).toBeGreaterThan(0); }
    expect(UI_FLAG_CATALOG.filter((entry) => entry.wired).map((entry) => entry.name)).toEqual(["look", "nav", "home", "work", "spending", "leadingHeader"]);
  });
  it("is the same list in the browser entry", () => { expect(web.UI_FLAG_NAMES).toEqual(UI_FLAG_NAMES); });
  it("refuses unknown names in the body and in the nav map", () => {
    expect(UiFlagsBodySchema.safeParse({ expectedRevision: 0, flags: { look: true } }).success).toBe(true);
    expect(UiFlagsBodySchema.safeParse({ expectedRevision: 0, flags: { companyRules: true } }).success).toBe(false);
    expect(UiFlagsMapSchema.safeParse({ companyRules: "on" }).success).toBe(false);
  });
  it("answers parse their own schema", () => {
    expect(UiFlagsAdminAnswerSchema.safeParse({ revision: 0, previews: false, flags: UI_FLAG_CATALOG.map((entry) => ({ ...entry, enabled: false, forcedOff: false, state: "off" })) }).success).toBe(true);
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
