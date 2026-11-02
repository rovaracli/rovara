// EV-2: a Go cover profile or a JaCoCo report named by a check is read from disk only through `readContainedReport` (workspace containment, plain file, no links, size cap, written in this round: modification AND
// change time in the round, neither in the future). The parsers themselves take text and never open a file.
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLineCoverageReport } from "../../packages/worker/src/verification/line-coverage-report.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "line-coverage-report-")); await mkdir(join(root, "svc"), { recursive: true }); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const GO = "mode: set\nexample.com/acme/match/a.go:1.1,2.2 1 1\n";
const GO_OPTIONS = { goModules: [{ path: "example.com/acme/match", dir: "." }] };
const JACOCO = '<?xml version="1.0"?><!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd"><report name="m"><package name="com/acme"><sourcefile name="A.java"><line nr="3" mi="0" ci="2" mb="0" cb="0"/></sourcefile></package></report>';
const input = (argument: string, over: Record<string, unknown> = {}) => ({ root, cwd: "svc", argument, notBeforeMs: Date.now() - 5_000, options: { ...GO_OPTIONS, javaSourceRoots: ["src/main/java"] }, ...over });

describe("a Go or JaCoCo report is read through the contained, fresh-file rules", () => {
  it("reads a fresh profile and a fresh JaCoCo report the check wrote in this round", async () => {
    await writeFile(join(root, "svc/cover.out"), GO);
    await writeFile(join(root, "svc/jacoco.xml"), JACOCO);
    const go = await readLineCoverageReport(input("cover.out"));
    expect(go).toMatchObject({ ok: true, format: "go" });
    const java = await readLineCoverageReport(input("jacoco.xml"));
    expect(java).toMatchObject({ ok: true, format: "jacoco" });
  });

  it("refuses a report from before the round, one with no round start, one dated in the future, one outside the workspace, a link, and a missing one", async () => {
    await writeFile(join(root, "svc/cover.out"), GO);
    expect(await readLineCoverageReport(input("cover.out", { notBeforeMs: undefined }))).toEqual({ ok: false, reason: "stale" });
    const old = new Date(Date.now() - 3_600_000);
    await utimes(join(root, "svc/cover.out"), old, old);
    expect(await readLineCoverageReport(input("cover.out"))).toEqual({ ok: false, reason: "stale" });
    const future = new Date(Date.now() + 3_600_000);
    await utimes(join(root, "svc/cover.out"), future, future);
    expect(await readLineCoverageReport(input("cover.out"))).toEqual({ ok: false, reason: "stale" });
    expect(await readLineCoverageReport(input("../../etc/passwd"))).toMatchObject({ ok: false });
    await symlink(join(root, "svc/cover.out"), join(root, "svc/link.out"));
    expect(await readLineCoverageReport(input("link.out"))).toEqual({ ok: false, reason: "unsafe_path" });
    expect(await readLineCoverageReport(input("none.out"))).toEqual({ ok: false, reason: "missing" });
  });

  it("is not measured for a file that is neither format, or whose options are missing; and a profile over the Go cap is refused even though JaCoCo's cap is larger", async () => {
    await writeFile(join(root, "svc/other.txt"), "hello");
    expect(await readLineCoverageReport(input("other.txt"))).toEqual({ ok: false, reason: "unparsable" });
    await writeFile(join(root, "svc/cover.out"), GO);
    expect(await readLineCoverageReport(input("cover.out", { options: {} }))).toEqual({ ok: false, reason: "unparsable" });
    await writeFile(join(root, "svc/big.out"), `${GO}${"x".repeat(8 * 1024 * 1024)}`);
    expect(await readLineCoverageReport(input("big.out"))).toMatchObject({ ok: false });
  });

  it("is the only reader of such a file: the parsers import no file system module", () => {
    const parsers = readFileSync("packages/worker/src/verification/changed-coverage.ts", "utf8");
    expect(parsers).not.toMatch(/from "node:fs|from "fs/u);
    expect(readFileSync("packages/worker/src/verification/line-coverage-report.ts", "utf8")).toContain("readContainedReport");
  });
});
