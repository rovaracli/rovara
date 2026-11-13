import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ROLLOUT_FEATURE_NAMES } from "@agentx/cloud-contracts";
import { ROLLOUT_INSTALL_VARIABLE } from "../../packages/broker/src/org/feature-rollout.js";

// TE-A1: every evidence reader goes through the company gate. The four install readers (`proofEvidenceEnabled`, `verifyResultsEnabled`, `testEnvironmentEnabled`, `testServicesEnabled`) read only the install's variable;
// the company gate reaches them through the environment they are given (`companyGatedEnv`, `routeEnvOf`, a route's `deps.env`) or through the evidence port (`gatedEvidencePort`). This test reads the broker's source:
//   1. a call that gives its reader an environment is a company-aware call (the environment is the caller's to gate; the entry points that gate it are checked in 3);
//   2. a call with no environment, or with `process.env`, reads the install only, so its file must be listed here with the reason that is right;
//   3. each entry point that has a company in hand gates its environment: the markers below must stay in the source;
//   4. what is not gated yet is listed, and the list can only shrink.

const ROOT = join(__dirname, "..", "..", "packages", "broker", "src");
const READERS = ["proofEvidenceEnabled", "verifyResultsEnabled", "testEnvironmentEnabled", "testServicesEnabled"] as const;
const DEFINITIONS = new Set(["proof/switch.ts", "verification/switch.ts", "test-env/switch.ts", "test-env/test-services-switch.ts"]);

const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
});
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const codeOf = (line: string): string => line.replace(/\/\/.*$/u, "");

interface Call { file: string; line: number; reader: string; argument: string }
const calls: Call[] = files(ROOT).flatMap((path) => {
  const file = relative(ROOT, path);
  if (DEFINITIONS.has(file)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((raw, index) => {
    const line = codeOf(raw);
    if (/^\s*(\*|\/\*)/u.test(raw)) return [];
    return [...line.matchAll(new RegExp(`\\b(${READERS.join("|")})\\(([^)]*(?:\\([^)]*\\))?[^)]*)\\)`, "gu"))].map((match) => ({ file, line: index + 1, reader: match[1]!, argument: match[2]!.trim() }));
  });
});

/** Files that read the install's switch on purpose (no company is in hand, or the read can only be stricter), with why. */
const INSTALL_LEVEL: Record<string, string> = {
  "aws/developer-routes.ts": "the browser-only restriction on the known-failing marks route: it asks the install switch before the caller's company is read, so it is stricter than the gated route behind it, never looser",
  "aws/session-steps.ts": "the compute provisioner's own switch (a launch or cleanup of a machine has no company)",
  "aws/developer-tasks/evidence-risk-input.ts": "the default of `switchOn` when there is no evidence port at all (the install's proof switch off); with a port, `port.on(task)` is the company's answer",
  "test-env/shipped-catalog.ts": "the signed service catalog is the release's, not a company's; it is read behind a route or plan that is already gated",
  "aws/broker/company-image-login.ts": "a worker callback of one operation whose plan was made behind the company gate (`companyImageIds` is only set by a gated plan)",
  "aws/broker/fixture-delivery.ts": "a worker callback of one operation whose plan was made behind the company gate (`fixtureSetDigests` is only set by a gated plan)",
  "test-env/fixture-store-aws.ts": "the install's fixture store factory; every route and plan that uses it is gated before it is asked for a store",
  "aws/developer-routes/company-test-images.ts": "the helper `companyTestImagesEnabled(env)` is called by the route, whose environment is the company's (`routeEnvOf(deps)`)",
};

/** Not gated by company yet: the reader is given an environment that the caller builds from the install only. Add a row to DEFERRED-CHECKS when one is added here; a fixed one is removed. */
const NOT_GATED_YET: Record<string, string> = {
  "developer/autofix-messages.ts": "fixSetupWording(workflow, env): wording of the Fix setup line on an auto-fix card; its callers (workflow-messages, the Slack notifier, the task page) have no company in hand",
};

describe("the readers", () => {
  it("finds the calls this test reasons about (a positive control)", () => {
    expect(calls.length).toBeGreaterThan(30);
    for (const reader of READERS) expect(calls.some((call) => call.reader === reader), reader).toBe(true);
  });

  it("a call without an environment, or with process.env, is only in a file listed as install-level", () => {
    const bare = calls.filter((call) => call.argument === "" || /^process\.env$/u.test(call.argument));
    const unlisted = bare.filter((call) => INSTALL_LEVEL[call.file] === undefined).map((call) => `${call.file}:${call.line} ${call.reader}(${call.argument})`);
    expect(unlisted, "a call that reads the install switch only must be listed in INSTALL_LEVEL with its reason, or take the company's environment").toEqual([]);
  });

  it("every file listed as install-level still has such a call, and every one listed as not gated yet still has a call", () => {
    for (const file of Object.keys(INSTALL_LEVEL)) expect(calls.some((call) => call.file === file), file).toBe(true);
    for (const file of Object.keys(NOT_GATED_YET)) expect(calls.some((call) => call.file === file), file).toBe(true);
  });

  it("the install variable of each gated feature is the one its reader reads", () => {
    const names = ROLLOUT_FEATURE_NAMES.filter((name) => ROLLOUT_INSTALL_VARIABLE[name] !== undefined);
    expect(names).toEqual(["proofEvidence", "verifyResults", "testEnvironment", "testServices"]);
  });
});

describe("the entry points that have a company gate its environment", () => {
  const MARKERS: Array<[string, RegExp, string]> = [
    ["aws/developer-routes.ts", /deps = \{ \.\.\.deps, env: await companyGatedEnv\(/u, "every HTTP route: the request's environment is the caller's company's, set once after the caller is known"],
    ["aws/broker/task-operations.ts", /const gatedEnv = await companyGatedEnv\(/u, "a task's run: the plan, the evidence capture and the setup detection"],
    ["aws/broker/evidence-wiring.ts", /gatedEvidencePort\(createEvidencePort/u, "the evidence port every task route, Slack press and pull request rewrite reads"],
    ["aws/broker/evidence-wiring.ts", /const gated = await companyGatedEnv\(/u, "keeping the evidence of a finished check run"],
    ["aws/developer-tasks/testing-view.ts", /companyGatedEnv\(/u, "the four results of a task"],
    ["aws/developer-tasks/start.ts", /companyGatedEnv\(/u, "the environment a new task pins"],
    ["aws/developer-tasks/health-notice.ts", /companyGatedEnv\(/u, "the repair banner on a task"],
    ["aws/broker/workflow-items.ts", /companyGatedEnv\(/u, "the environment draft a setup run ends with"],
    ["aws/broker/fix-setup-wiring.ts", /companyGatedEnv\(/u, "the Fix setup cards an auto-fix opens"],
    ["test-env/health-wiring.ts", /companyGatedEnv\(/u, "the nightly result, the blocked-task count and the repaired setup"],
    ["test-env/nightly-wiring.ts", /companyGatedEnv\(/u, "a nightly fire"],
  ];
  for (const [file, marker, what] of MARKERS) {
    it(`${file}: ${what}`, () => { expect(read(file)).toMatch(marker); });
  }

  it("the routes that read an install switch default their environment to the request's (routeEnvOf), never to process.env", () => {
    for (const file of ["known-failing-policy", "known-failing-marks", "test-environment", "fixtures", "setup-agent", "test-health", "company-test-images", "decisions"]) {
      const source = read(`aws/developer-routes/${file}.ts`);
      expect(source, file).toMatch(/env: NodeJS\.ProcessEnv = routeEnvOf\(deps\)/u);
      // A function that takes the route's dependencies never defaults its environment to the process's.
      expect(source, file).not.toMatch(/deps: DeveloperRouteDependencies[^)]*env: NodeJS\.ProcessEnv = process\.env/u);
    }
  });
});
