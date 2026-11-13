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

// ---- One level up: a helper whose environment defaults to process.env and that reaches a reader ---------------------------------------------------------------------------------------------------------------------------
// A route or a hook that calls such a helper without an environment hands the reader the install's switch. The helpers are found in the files that read an install switch with an environment argument: a function (or an arrow
// constant) there with a parameter `env: NodeJS.ProcessEnv = process.env`. Every call of one outside its own file must give that parameter (counting arguments), or its file must be listed with the reason.

interface Helper { name: string; file: string; index: number }
const sourceOf = (path: string): string => readFileSync(path, "utf8").split("\n").map(codeOf).join("\n");

/** The text between the parenthesis that opens at `open` and its match, and the position after it. */
function balanced(text: string, open: number): { inner: string; end: number } {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") { depth -= 1; if (depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 }; }
  }
  return { inner: text.slice(open + 1), end: text.length };
}
/** Top-level arguments (commas inside brackets, braces, angle brackets of a type, strings and template strings do not split). */
function splitArguments(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0, angle = 0, quote = "", current = "";
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]!;
    if (quote !== "") { current += char; if (char === quote && inner[i - 1] !== "\\") quote = ""; continue; }
    if (char === '"' || char === "'" || char === "`") { quote = char; current += char; continue; }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") depth -= 1;
    if (char === "<" && inner[i + 1] !== "=") angle += 1;
    if (char === ">" && inner[i - 1] !== "=" && angle > 0) angle -= 1;
    if (char === "," && depth === 0 && angle === 0) { parts.push(current.trim()); current = ""; continue; }
    current += char;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

const readerFiles = [...new Set(calls.filter((call) => call.argument !== "" && !/^process\.env$/u.test(call.argument)).map((call) => call.file))];
const helpers: Helper[] = readerFiles.flatMap((file) => {
  const text = sourceOf(join(ROOT, file));
  return [...text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(|export\s+const\s+(\w+)\s*=\s*(?:async\s*)?\(/gu)].flatMap((match) => {
    const name = match[1] ?? match[2]!;
    const open = match.index + match[0].length - 1;
    const parameters = splitArguments(balanced(text, open).inner);
    const index = parameters.findIndex((parameter) => /\benv\??\s*:\s*NodeJS\.ProcessEnv\s*=\s*process\.env\b/u.test(parameter));
    return index < 0 ? [] : [{ name, file, index }];
  });
});

/** Files that call such a helper without an environment on purpose, with why. */
const HELPER_CALLERS_INSTALL_LEVEL: Record<string, string> = {
  "aws/broker/callbacks.ts handleCompanyImageLogin": "a worker callback of one operation whose plan was made behind the company gate (`companyImageIds` is set only by a gated plan)",
  "aws/broker/callbacks.ts handleFixtureSetCallback": "a worker callback of one operation whose plan was made behind the company gate (`fixtureSetDigests` is set only by a gated plan)",
  "aws/broker/dependency-wiring.ts releaseServiceCatalogSource": "the release's signed catalog, not a company's; every route and plan that uses it is gated",
  "aws/broker/dispatch.ts blockedByEnvironmentHook": "builds the hook from the install; the hook reads the task's company's gates itself (health-wiring.ts)",
  "aws/broker/handler.ts fireTestEnvNightly": "the nightly fire reads the fire's company's gate itself (nightly-wiring.ts)",
  "aws/broker/pull-request-reconcile.ts evidenceRouteDependencies": "the evidence port is made once and gated per task company on every read (evidence-gate.ts)",
  "aws/broker/pull-request-reconcile.ts nightlyHeadReaderOf": "builds the reader from the install; the testing view that uses it reads the task's company's gate itself",
  "aws/broker/pull-request-reconcile.ts loadTestingView": "reads the task's company's gate itself (testing-view.ts)",
  "aws/broker/workflow-items.ts keepEvidenceAfterChecks": "reads the task's company's gate itself (evidence-wiring.ts)",
  "aws/developer-routes.ts companyTestImagesEnabled": "the browser-only restriction asks the install switch before the caller's company is read, so it is stricter than the gated route behind it, never looser",
  "aws/developer-tasks/publication.ts loadTestingView": "reads the task's company's gate itself (testing-view.ts)",
  "aws/developer-tasks/task-view.ts loadTestingView": "reads the task's company's gate itself (testing-view.ts)",
  "aws/developer-task-notifier.ts fixSetupWording": "NOT GATED YET: wording of the Fix setup line on an auto-fix card (DEFERRED-CHECKS, TE-A1)",
  "developer/workflow-messages.ts fixSetupWording": "NOT GATED YET: wording of the Fix setup line on an auto-fix card (DEFERRED-CHECKS, TE-A1)",
};

describe("helpers whose environment defaults to process.env", () => {
  it("finds the helpers this test reasons about (a positive control)", () => {
    const names = helpers.map((helper) => helper.name);
    for (const known of ["testEnvPlanFor", "approveTestEnvItemsFor", "envChangeItemsFor", "fixSetupItemsFor", "loadTestingView", "environmentUnusedReason", "nightlyHooks"]) expect(names, known).toContain(known);
  });

  it("every entry of the list still has such a call", () => {
    for (const key of Object.keys(HELPER_CALLERS_INSTALL_LEVEL)) {
      const [file, name] = key.split(" ") as [string, string];
      expect(sourceOf(join(ROOT, file)), key).toMatch(new RegExp(`(?<![\\w.])${name}\\s*\\(`, "u"));
    }
  });

  it("every call of one, outside its own file, gives it the environment (or the call is listed)", () => {
    const missing: string[] = [];
    for (const path of files(ROOT)) {
      const file = relative(ROOT, path);
      const text = sourceOf(path);
      for (const helper of helpers) {
        if (helper.file === file || HELPER_CALLERS_INSTALL_LEVEL[`${file} ${helper.name}`] !== undefined) continue;
        for (const match of text.matchAll(new RegExp(`(?<![\\w.])${helper.name}\\s*\\(`, "gu"))) {
          const before = text.slice(Math.max(0, match.index - 40), match.index);
          if (/\b(import|function|const|type|interface)\s*[\w{ ,]*$/u.test(before)) continue;
          const open = match.index + match[0].length - 1;
          const given = splitArguments(balanced(text, open).inner);
          const environment = given[helper.index];
          if (environment === undefined || /^process\.env$/u.test(environment)) missing.push(`${file}: ${helper.name}(...) from ${helper.file} takes env as argument ${helper.index + 1}`);
        }
      }
    }
    expect(missing, "give the helper the company's environment, or list the file and the helper in HELPER_CALLERS_INSTALL_LEVEL with the reason").toEqual([]);
  });
});

describe("the entry points that have a company gate its environment", () => {
  const MARKERS: Array<[string, RegExp, string]> = [
    ["aws/developer-routes.ts", /deps = \{ \.\.\.deps, gates, env: await companyGatedEnv\(/u, "every HTTP route: the request's environment is the caller's company's, set once after the caller is known"],
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
    ["aws/broker/task-operations.ts", /onReadFailure: "throw"/u, "dispatch throws RUNTIME_UNAVAILABLE on a gate it cannot read (M3)"],
    ["aws/developer-tasks/start.ts", /onReadFailure: "throw"/u, "a task start throws RUNTIME_UNAVAILABLE on a gate it cannot read (M3)"],
    ["aws/broker/workflow-items.ts", /onReadFailure: "throw"/u, "a setup draft's end throws RUNTIME_UNAVAILABLE on a gate it cannot read (M3)"],
    ["aws/broker/evidence-wiring.ts", /onReadFailure: "throw"/u, "keeping evidence throws RUNTIME_UNAVAILABLE on a gate it cannot read (M3)"],
    ["aws/developer-routes.ts", /onReadFailure: "default"/u, "the per-request dispatch follows the catalog default on a gate it cannot read (M3)"],
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
