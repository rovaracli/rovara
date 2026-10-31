// Stdio MCP host redesign, task T6: the install task's result is read as data. Only exactly what the install task sends is accepted.
import { describe, expect, it } from "vitest";
import { INSTALL_FAILURE_CODES, parseInstallOutcome } from "../../../packages/gateway/src/mcp-runner/install-result.js";
import { INSTALL_FAILURES } from "../../../packages/broker/src/mcp-runner/install-main.js";

const REPORT = { ok: true, integrity: `sha512-${"A".repeat(86)}==`, lockfileHash: "1".repeat(64), bundleHash: "2".repeat(64), packageCount: 3, unpackedBytes: 10, tarBytes: 20, bin: "bin/sim.js" };

describe("install result", () => {
  it("keeps the failure codes of the install task and the controller the same list", () => {
    expect([...INSTALL_FAILURE_CODES].sort()).toEqual(Object.keys(INSTALL_FAILURES).sort());
  });
  it("accepts a success and a failure exactly as the install task sends them", () => {
    expect(parseInstallOutcome(REPORT)).toEqual({ ok: true, report: { integrity: REPORT.integrity, lockfileHash: REPORT.lockfileHash, bundleHash: REPORT.bundleHash, packageCount: 3, unpackedBytes: 10, tarBytes: 20, bin: "bin/sim.js" } });
    expect(parseInstallOutcome({ ok: false, code: "lockfile_policy", sentence: "This package's dependencies are not allowed.", rule: "install_scripts", package: "node_modules/flagged-dep", computedIntegrity: REPORT.integrity }))
      .toEqual({ ok: false, code: "lockfile_policy", sentence: "This package's dependencies are not allowed.", rule: "install_scripts", package: "node_modules/flagged-dep", computedIntegrity: REPORT.integrity });
  });
  it("refuses anything else: another shape, an extra field, a value that is not what it should be", () => {
    const bad: unknown[] = [
      undefined, null, "x", [], 5, {}, { ok: "yes" },
      { ...REPORT, extra: 1 }, { ...REPORT, integrity: "sha1-abc" }, { ...REPORT, lockfileHash: "A".repeat(64) }, { ...REPORT, bundleHash: "2".repeat(63) }, { ...REPORT, packageCount: -1 }, { ...REPORT, packageCount: 5_001 },
      { ...REPORT, packageCount: 1.5 }, { ...REPORT, bin: "" }, { ...REPORT, bin: "a\nb" }, { ...REPORT, tarBytes: "20" }, { ...REPORT, unpackedBytes: 2 ** 41 },
      { ok: false, code: "nope", sentence: "x" }, { ok: false, code: "install_failed" }, { ok: false, code: "install_failed", sentence: "" }, { ok: false, code: "install_failed", sentence: "x".repeat(601) },
      { ok: false, code: "install_failed", sentence: "bell\u0007" }, { ok: false, code: "install_failed", sentence: "x", extra: true }, { ok: false, code: "install_failed", sentence: "x", package: "p".repeat(301) },
      { ok: false, code: "install_failed", sentence: "x", rule: "r".repeat(61) }, { ok: false, code: "install_failed", sentence: "x", computedIntegrity: "sha1-x" }, { ok: false, code: "install_failed", sentence: "x", package: "line\nbreak" },
    ];
    for (const value of bad) expect(parseInstallOutcome(value), JSON.stringify(value)).toBeUndefined();
  });
});
