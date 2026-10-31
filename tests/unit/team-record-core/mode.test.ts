import { describe, expect, it } from "vitest";
import { captureIsOn, lessonsLoad, tableModeReader } from "../../../packages/broker/src/team-record/mode.js";
import { ORG_A, ORG_B, setLock, setMode, world } from "../../support/team-record-core.js";

describe("learning mode", () => {
  it("defaults to Suggest, reads the project's value, and lets a company lock win", async () => {
    const w = world();
    const reader = tableModeReader(w.table);
    expect(await reader.effectiveMode(ORG_A, "web")).toBe("suggest");
    setMode(w, ORG_A, "web", "collect");
    expect(await reader.effectiveMode(ORG_A, "web")).toBe("collect");
    setLock(w, ORG_A, "off");
    expect(await reader.effectiveMode(ORG_A, "web")).toBe("off");
    expect(await reader.effectiveMode(ORG_B, "web")).toBe("suggest");
  });
  it("a company lock only makes the mode stricter, never looser (M8)", async () => {
    const w = world();
    const reader = tableModeReader(w.table);
    setMode(w, ORG_A, "web", "off");
    setLock(w, ORG_A, "on");
    expect(await reader.effectiveMode(ORG_A, "web")).toBe("off");
    setMode(w, ORG_A, "web", "collect");
    setLock(w, ORG_A, "suggest");
    expect(await reader.effectiveMode(ORG_A, "web")).toBe("collect");
    setMode(w, ORG_A, "web", "on");
    setLock(w, ORG_A, "collect");
    expect(await reader.effectiveMode(ORG_A, "web")).toBe("collect");
    // no project value: the default (suggest) under a lock of on stays suggest
    setLock(w, ORG_A, "on");
    expect(await reader.effectiveMode(ORG_A, "other")).toBe("suggest");
  });
  it("reads a value that does not parse, or a failed read, as Off", async () => {
    const w = world();
    setMode(w, ORG_A, "web", "turbo");
    expect(await tableModeReader(w.table).effectiveMode(ORG_A, "web")).toBe("off");
    const failing = world();
    failing.db.injectFault({ command: "GetCommand", error: { name: "InternalServerError" } });
    expect(await tableModeReader(failing.table).effectiveMode(ORG_A, "web")).toBe("off");
  });
  it("captures in Collect, Suggest and On, loads lessons only in Suggest and On", () => {
    expect(["off", "collect", "suggest", "on"].map((mode) => captureIsOn(mode as never))).toEqual([false, true, true, true]);
    expect(["off", "collect", "suggest", "on"].map((mode) => lessonsLoad(mode as never))).toEqual([false, false, true, true]);
  });
});
