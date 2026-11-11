// Convergence plan W0-5: guards around the conformance target, so it cannot go quiet. Every vendored suite is either wired to a port or exempt with a reason; a registration is well
// formed; the vendor copy carries the suites; CI runs the target (early, and in the test shards).
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { INCLUDE, parsePin, PIN_FILE } from "../../scripts/vendor/rovara-code-vendor.js";
import config from "../../vitest.config.js";
import { CLOUD_ADAPTERS } from "./adapters/index.js";
import { CODE_FAKES } from "./code-fakes.js";
import { PENDING_LANE } from "./pending-lanes.js";
import { EXEMPT_SUITES, RUN_SUITE, SUITE_FILE, type PortName } from "./ports.js";
import { defineCloudAdapter, registrationProblems } from "./registry.js";

const SUITES_DIR = "vendor/rovara-code/tests/support/ports";
const ports = Object.keys(RUN_SUITE) as PortName[];

describe("the vendored suites", () => {
  const files = readdirSync(SUITES_DIR).filter((file) => file.endsWith("-conformance.ts"));

  it("are all wired to a port or exempt with a reason, so a pin bump that brings a suite cannot leave it unrun", () => {
    const wired = new Set(Object.values(SUITE_FILE));
    expect(files.filter((file) => !wired.has(file) && !(file in EXEMPT_SUITES))).toEqual([]);
  });

  it("exist for every port and every exemption named here (a suite the pin dropped is a stale entry)", () => {
    for (const file of [...Object.values(SUITE_FILE), ...Object.keys(EXEMPT_SUITES)]) expect(files, file).toContain(file);
    expect(Object.keys(EXEMPT_SUITES).filter((file) => Object.values(SUITE_FILE).includes(file))).toEqual([]);
  });

  it("are part of the pinned copy's include list, which verify-rovara-code.ts checks byte for byte against the pinned sha", () => {
    expect(INCLUDE).toContain("tests/support/ports");
    expect(parsePin(readFileSync(PIN_FILE, "utf8")).pin?.include).toContain("tests/support/ports");
  });
});

describe("the ports", () => {
  it("each have a suite, a vendored file, a positive control from Code's fakes and a named pending lane", () => {
    for (const port of ports) {
      expect(typeof RUN_SUITE[port], port).toBe("function");
      expect(SUITE_FILE[port], port).toBeDefined();
      expect(CODE_FAKES[port].length, port).toBeGreaterThan(0);
      expect(PENDING_LANE[port], port).toBeDefined();
    }
    expect(Object.keys(SUITE_FILE).sort()).toEqual([...ports].sort());
    expect(Object.keys(CODE_FAKES).sort()).toEqual([...ports].sort());
    expect(Object.keys(PENDING_LANE).sort()).toEqual([...ports].sort());
  });

  it("have fakes named once each, so the report tells them apart", () => {
    for (const port of ports) {
      const names = CODE_FAKES[port].map((fake) => fake.name);
      expect(new Set(names).size, port).toBe(names.length);
    }
  });
});

describe("the adapter registry", () => {
  it("holds registrations that are well formed", () => {
    expect(registrationProblems(CLOUD_ADAPTERS, ports)).toEqual([]);
  });

  it("refuses an unknown port, an odd name and a second registration of one adapter", () => {
    const fake = CODE_FAKES.queue[0]!;
    const queue = defineCloudAdapter({ port: "queue", name: "SQS", harness: fake.harness });
    expect(registrationProblems([queue], ports)).toEqual([]);
    expect(registrationProblems([queue, queue], ports)).toEqual(["queue / SQS: registered twice"]);
    expect(registrationProblems([defineCloudAdapter({ port: "queue", name: "multi\nline", harness: fake.harness })], ports)).toHaveLength(1);
    expect(registrationProblems([{ ...queue, port: "dispatch" } as never], ports)[0]).toMatch(/no conformance suite for the port "dispatch"/);
  });
});

describe("CI", () => {
  const workflow = YAML.parse(readFileSync(".github/workflows/ci.yml", "utf8")) as { jobs: Record<string, { steps: Array<{ name?: string; if?: string; run?: string }> }> };

  it("runs the target in the checks job, after the build, so it fails before the shards start (they wait for checks)", () => {
    const steps = workflow.jobs.checks!.steps;
    const index = steps.findIndex((step) => step.run === "npx vitest run tests/conformance");
    expect(index).toBeGreaterThan(steps.findIndex((step) => step.run === "npm run typecheck"));
    expect(steps[index]!.if).toBe("hashFiles('tests/conformance/conformance.test.ts') != ''");
  });

  it("leaves the target in the test shards: the shard run takes every test file, and the config excludes none of this folder", () => {
    expect(workflow.jobs.test!.steps.some((step) => step.run === "npm test -- --shard=${{ matrix.shard }}/${{ strategy.job-total }}")).toBe(true);
    const test = (config as { test?: { include?: string[]; exclude?: string[] } }).test;
    expect(test?.include).toContain("tests/**/*.test.ts");
    expect((test?.exclude ?? []).filter((pattern) => /conformance/.test(pattern))).toEqual([]);
  });
});
