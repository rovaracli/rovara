// The opt-in TS-L self-test result as the worker reads and reports it (test-services-selftest.ts, and the `selfTest` key of the worker_start report in test-services-report.ts): the shape, the fixed words, the size cap, and that
// a report without the self-test is exactly what it was.
import { describe, expect, it } from "vitest";
import { checkReport, collectReport, reportLine, type TestServicesReport } from "../../packages/worker/src/test-services-report.js";
import { SELFTEST_ALWAYS_PENDING_IDS, SELFTEST_CI_ITEM_IDS, SELFTEST_EXTRA_IDS, SELFTEST_ITEM_IDS, SELFTEST_MAX_CHARS, parseSelfTest, type SelfTestResult } from "../../packages/worker/src/test-services-selftest.js";
import type { DockerCli } from "../../packages/worker/src/swebench/containers.js";

const row = (id: string): string => (SELFTEST_ALWAYS_PENDING_IDS as readonly string[]).includes(id) ? `${id}:pending:no_capture` : `${id}:pass:ok`;
const EXTRA = SELFTEST_EXTRA_IDS.map((id) => `${id}:pending:no_pin`);
const GOOD = { v: 1, state: "ran", reason: "ok", ami: "ami-0d2beaff07e79c24e", boot2: "b".repeat(64), docker: "25.0.18", instance: "i-08a32b24c7e3efe6c", secs: 93, items: SELFTEST_ITEM_IDS.map(row), extra: EXTRA };
const text = (over: Record<string, unknown> = {}): string => JSON.stringify({ ...GOOD, ...over });
const START = { phase: "worker_start", outcome: "booted", leftoverContainers: 0, leftoverNetworks: 0, runDirEmpty: true, runDirTmpfs: true, workingSandboxPaused: null } as const;
const FACTS = { metadataBlocked: true, runWalls: true, ipv6Drops: true, prepull: "off", prepulled: 0, loggedOut: false, dockerVersion: "25.0.18" };
const docker: DockerCli = { run: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }) };

describe("parseSelfTest", () => {
  it("reads a result in exactly the expected shape", () => {
    const parsed = parseSelfTest(text()) as SelfTestResult;
    expect(parsed).toMatchObject({ v: 1, state: "ran", reason: "ok", ami: "ami-0d2beaff07e79c24e", docker: "25.0.18", instance: "i-08a32b24c7e3efe6c", secs: 93 });
    expect(parsed.items).toHaveLength(SELFTEST_ITEM_IDS.length);
    expect(parsed.items[0]).toEqual({ id: "L1.walls", status: "pass", reason: "ok" });
    expect(parsed.extra).toEqual([{ id: "extra.redis-flush", status: "pending", reason: "no_pin" }, { id: "extra.http-reset", status: "pending", reason: "no_pin" }]);
  });

  it("says `absent` when the self-test is off (the normal case) and `unreadable` for anything else that is not the shape", () => {
    expect(parseSelfTest(undefined)).toBe("absent");
    expect(parseSelfTest("")).toBe("absent");
    const bad: Array<[string, string]> = [
      ["not json", "nope"], ["an array", "[]"], ["null", "null"],
      ["an extra key", text({ note: "free text" })],
      ["a missing key", JSON.stringify({ ...GOOD, secs: undefined })],
      ["a wrong version", text({ v: 2 })],
      ["an unknown state", text({ state: "done" })],
      ["a reason that is not a fixed word", text({ reason: "docker said no at 10.0.0.1" })],
      ["a bad AMI", text({ ami: "ami-XYZ" })],
      ["a bad hash", text({ boot2: "abc" })],
      ["a host name as a Docker version", text({ docker: "ip-10-0-0-5.ec2.internal" })],
      ["a bad instance id", text({ instance: "i-nope" })],
      ["negative seconds", text({ secs: -1 })],
      ["fractional seconds", text({ secs: 1.5 })],
      ["an unknown item id", text({ items: [...GOOD.items.slice(1), "L9.surprise:pass:ok"] })],
      ["an extra id among the items", text({ items: [...GOOD.items.slice(1), "extra.redis-flush:pending:no_pin"] })],
      ["an old RUN3 id in the extras", text({ extra: ["RUN3.redis-flush:pending:no_pin", "RUN3.http-reset:pending:no_pin"] })],
      ["a CI id among the extras", text({ extra: ["L1.walls:pass:ok", "extra.http-reset:pending:no_pin"] })],
      ["a run with an extra missing", text({ extra: [EXTRA[0]] })],
      ["no extra key", JSON.stringify({ ...GOOD, extra: undefined })],
      ["a duplicate item", text({ items: [...GOOD.items.slice(0, -1), GOOD.items[0]] })],
      ["an item with free text", text({ items: [...GOOD.items.slice(1), "L1.walls:fail:no rule at 172.30.0.2"] })],
      ["a pass with a reason that is not ok", text({ items: [...GOOD.items.slice(1), "L1.walls:pass:check_failed"] })],
      ["a fail with the reason ok", text({ items: [...GOOD.items.slice(1), "L1.walls:fail:ok"] })],
      ["an unknown status", text({ items: [...GOOD.items.slice(1), "L1.walls:great:ok"] })],
      ["an item that is not a string", text({ items: [...GOOD.items.slice(1), { id: "L1.walls" }] })],
      ["a run that finished with items missing", text({ items: GOOD.items.slice(1) })],
      ["a refusal with items", text({ state: "refused", reason: "not_staging" })],
      ["too long", text({ items: GOOD.items, pad: "x".repeat(SELFTEST_MAX_CHARS) })],
    ];
    for (const [name, value] of bad) expect(parseSelfTest(value), name).toBe("unreadable");
  });

  it("accepts the shorter results of a refusal, a start that did not happen, and a cleanup that failed", () => {
    for (const over of [{ state: "refused", reason: "not_staging", items: [], extra: [], secs: 0 }, { state: "refused", reason: "wrong_account", items: [], extra: [], secs: 0 }, { state: "refused", reason: "not_staging_image", items: [], extra: [], secs: 4 }, { state: "incomplete", reason: "no_time", items: [], extra: [], secs: 0 }, { state: "incomplete", reason: "budget", items: [row("L1.walls")], extra: EXTRA, secs: 170 }, { state: "unusable", reason: "cleanup_failed", items: [row("L1.walls")], extra: [], secs: 170 }, { state: "incomplete", reason: "too_large", items: [], extra: [], secs: 3 }]) {
      expect(parseSelfTest(text(over)), JSON.stringify(over)).toMatchObject({ state: over.state, reason: over.reason });
    }
    expect(parseSelfTest(text({ ami: "unknown", boot2: "unknown", docker: "unknown", instance: "unknown" }))).toMatchObject({ ami: "unknown", boot2: "unknown", docker: "unknown", instance: "unknown" });
  });

  it("the full list fits the size cap with room to spare, and the CI ids come first, in CI's order", () => {
    expect(text().length).toBeLessThan(SELFTEST_MAX_CHARS - 500);
    expect(SELFTEST_ITEM_IDS.slice(0, SELFTEST_CI_ITEM_IDS.length)).toEqual([...SELFTEST_CI_ITEM_IDS]);
    expect(new Set(SELFTEST_ITEM_IDS).size).toBe(SELFTEST_ITEM_IDS.length);
  });
});

describe("the worker_start report", () => {
  it("has no selfTest key when the self-test is off: the report is exactly what it was", async () => {
    for (const selfTestText of [undefined, ""]) {
      const made = await collectReport({ docker, workspace: "w", phase: "worker_start", outcome: "booted", bootFactsText: JSON.stringify(FACTS), selfTestText });
      expect(Object.keys(made)).not.toContain("selfTest");
      expect(checkReport(made)).toBe(true);
    }
  });

  it("carries the parsed result when there is one, and `unreadable` when the value is not the shape", async () => {
    const made = await collectReport({ docker, workspace: "w", phase: "worker_start", outcome: "booted", bootFactsText: JSON.stringify(FACTS), selfTestText: text() });
    expect(made.selfTest).toMatchObject({ state: "ran", instance: "i-08a32b24c7e3efe6c" });
    expect(checkReport(made)).toBe(true);
    const line = reportLine(made);
    expect(line).toBeDefined();
    expect(JSON.stringify(line).length).toBeLessThan(SELFTEST_MAX_CHARS + 1_500);
    const odd = await collectReport({ docker, workspace: "w", phase: "worker_start", outcome: "booted", selfTestText: "free text from somewhere" });
    expect(odd.selfTest).toBe("unreadable");
    expect(checkReport(odd)).toBe(true);
    // A run_end report never carries it.
    const ended = await collectReport({ docker, workspace: "w", phase: "run_end", outcome: "completed", selfTestText: text() });
    expect(Object.keys(ended)).not.toContain("selfTest");
  });

  it("is checked on the way out: a selfTest that is not the shape, or on a run_end, is not a report and no line is written", () => {
    const base: TestServicesReport = { ...START, bootFacts: "absent" };
    expect(checkReport({ ...base, selfTest: parseSelfTest(text()) })).toBe(true);
    expect(checkReport({ ...base, selfTest: "unreadable" })).toBe(true);
    for (const bad of [{ ...(parseSelfTest(text()) as object), note: "x" }, { ...(parseSelfTest(text()) as object), ami: "10.0.0.1" }, "absent", "free text", 3, null]) {
      expect(checkReport({ ...base, selfTest: bad }), JSON.stringify(bad)).toBe(false);
      expect(reportLine({ ...base, selfTest: bad } as never)).toBeUndefined();
    }
    expect(checkReport({ ...base, phase: "run_end", outcome: "completed", selfTest: parseSelfTest(text()) })).toBe(false);
  });
});
