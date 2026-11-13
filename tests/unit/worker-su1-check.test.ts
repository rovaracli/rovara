import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSu1Check, su1CheckEvent, SU1_CHECK_REASONS, SU1_CHECK_STATES, SU1_CHECK_STATUSES } from "../../packages/worker/src/su1-check.js";

const rows = () => Array.from({ length: 11 }, (_, i) => `${i + 1}:${i === 8 || i === 9 ? "pending:needs_model_run" : "pass:ok"}`);
const result = (over: Record<string, unknown> = {}) => ({ v: 1, state: "ran", reason: "ok", ami: "unknown", boot2: "b".repeat(64), docker: "25.0.1", instance: "i-12345678", secs: 45, items: rows(), ...over });
const text = (over: Record<string, unknown> = {}) => JSON.stringify(result(over));

describe("the strictly fixed SU-1 worker log event", () => {
  it("control: accepts all eleven statuses and emits one separate event", () => {
    expect(parseSu1Check(text())).toEqual(result());
    expect(su1CheckEvent(text())).toEqual({ event: "su1_check", ...result() });
    expect(su1CheckEvent(undefined)).toBeUndefined();
    expect(su1CheckEvent("")).toBeUndefined();
    expect(su1CheckEvent("private text")).toEqual({ event: "su1_check", v: 1, state: "unusable", reason: "no_result" });
  });
  it("rejects extra/missing keys, versions, words, identities, numbers and oversized input", () => {
    for (const over of [{ extra: 1 }, { v: 2 }, { state: "secret" }, { reason: "private" }, { ami: "host" }, { boot2: "wrong" }, { docker: "private.host" }, { instance: "ip-10-0-0-1" }, { secs: -1 }, { secs: 1.5 }, { secs: 10000 }, { items: [] }]) expect(parseSu1Check(text(over)), JSON.stringify(over)).toBe("unreadable");
    expect(parseSu1Check(" ".repeat(3001))).toBe("unreadable");
    const missing = result() as Record<string, unknown>; delete missing.ami;
    expect(parseSu1Check(JSON.stringify(missing))).toBe("unreadable");
  });
  it("rejects duplicate/missing rows, bad statuses, false passes and any pass/fail for 9 or 10", () => {
    for (const bad of ["1:pass:no_result", "1:fail:ok", "1:unknown:ok", "12:pass:ok", "9:pass:ok", "10:fail:check_failed", "9:pending:no_result"]) {
      const items = rows(); items[Number(bad.split(":")[0]) - 1] = bad;
      expect(parseSu1Check(text({ items })), bad).toBe("unreadable");
    }
    expect(parseSu1Check(text({ items: [...rows().slice(1), rows()[1]] }))).toBe("unreadable");
  });
  it("fits the worst-case result and holds the word lists equal to boot", () => {
    const full = text({ state: "incomplete", reason: "not_staging_image", ami: `ami-${"a".repeat(17)}`, instance: `i-${"a".repeat(17)}`, docker: "999.999.999.999-abcdefghijkl", secs: 9999, items: rows().map((row, i) => i === 8 || i === 9 ? row : `${i + 1}:incomplete:docker_unavailable`) });
    expect(full.length).toBeLessThan(3000); expect(typeof parseSu1Check(full)).toBe("object");
    const boot = readFileSync(new URL("../../packages/worker/ec2/boot-stage2.sh", import.meta.url), "utf8");
    for (const [name, words] of [["STATES", SU1_CHECK_STATES], ["STATUSES", SU1_CHECK_STATUSES], ["REASONS", SU1_CHECK_REASONS]] as const) expect(new RegExp(`readonly SU1_${name}="([^"]+)"`, "u").exec(boot)?.[1]?.split(" ")).toEqual(words);
  });
  it("ships an independent byte-equal checker only in staging images", () => {
    const original = new URL("../../scripts/staging-checks/setup-agent-su1.sh", import.meta.url);
    const copy = new URL("../../packages/worker/ec2/su1/setup-agent-su1.sh", import.meta.url);
    expect(readFileSync(copy)).toEqual(readFileSync(original));
    expect(lstatSync(copy).isSymbolicLink()).toBe(false);
    expect(realpathSync.native(copy)).not.toBe(realpathSync.native(original));
    expect([lstatSync(copy).dev, lstatSync(copy).ino]).not.toEqual([lstatSync(original).dev, lstatSync(original).ino]);
    const dockerfile = readFileSync(new URL("../../environments/base/Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toMatch(/else rm -rf packages\/worker\/ec2\/tsl packages\/worker\/ec2\/su1; fi/u);
  });
});
