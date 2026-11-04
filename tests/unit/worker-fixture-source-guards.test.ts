// Test services, slice 3 (s3-fakes-run): where the content of a fixture set may go. A set is fetched by the run layer, written into ONE helper's own run directory and read by the fake server's program; it must never reach a module the
// coding agent, a model call or the setup agent reads. These guards scan every `packages/*/src` file, so a new importer fails here until someone names it on purpose. The scanner is a pure function over {path, text}, and the tests below
// feed it bad sources to show that it fails (the guard is not passing on an empty search).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

export interface Source { path: string; text: string }
const W = "packages/worker/src/";

/** The only files that may import the modules that handle the content of a set. Adding one is a decision: review what it does with the set. */
export const FIXTURE_CONTENT_USERS: Record<string, readonly string[]> = {
  "fixture-delivery": [`${W}fixture-delivery.ts`, `${W}test-services-run.ts`, `${W}run-task.ts`],
  "fake-helper": [`${W}fake-helper.ts`, `${W}fake-usage.ts`],
  "fake-usage": [`${W}fake-usage.ts`, `${W}test-services-run.ts`, `${W}service-usage-record.ts`],
  "fixture-fetch": [`${W}fixture-fetch.ts`, `${W}fixture-delivery.ts`],
};
/** Names that exist in one module only: an occurrence anywhere else (an alias included) fails. */
const NAMES: Array<[RegExp, string, string[]]> = [
  [/\bfetchFixtureSet\b/u, "fetchFixtureSet", [`${W}fixture-fetch.ts`, `${W}fixture-delivery.ts`]],
  [/\bcreateFixtureDelivery\b/u, "createFixtureDelivery", [`${W}fixture-delivery.ts`, `${W}test-services-run.ts`]],
  [/\bfixtureJson\b/u, "fixtureJson", [`${W}service-helpers.ts`, `${W}test-services-run.ts`]],
];
/** The broker module that hands out a set's address: only the callback route imports it. */
const BROKER_DELIVERY = /(?:from|import\s*\()\s*["'][^"']*\/fixture-delivery(?:\.js|\.ts)?["']/u;
const BROKER_USERS = ["packages/broker/src/aws/broker/callbacks.ts"];
/** The worker's agent-facing folders and modules: what a model reads or a tool writes. A fixture module named here is a leak. */
const AGENT_FACING = [/^packages\/worker\/src\/(?:agent|pi-|tools?|session|prompt|skills?|mcp|context)[^/]*/u, /^packages\/worker\/src\/(?:agent|tools?|sessions?|prompts?)\//u, /^packages\/(?:model-runtime|model-proxy|orchestrator|mcp|gateway|slack-service)\/src\//u];

export function fixtureSourceViolations(sources: readonly Source[]): string[] {
  const out: string[] = [];
  for (const { path, text } of sources) {
    if (!path.startsWith("packages/") || path.includes("/test/")) continue;
    for (const [module, allowed] of Object.entries(FIXTURE_CONTENT_USERS)) {
      if (!path.startsWith(W)) {
        // outside the worker: only the broker's own, different module of the same name is a user, and it is checked below
        continue;
      }
      if (new RegExp(`(?:from|import\\s*\\()\\s*["'][^"']*/${module}(?:\\.js|\\.ts)?["']`, "u").test(text) && !allowed.includes(path)) out.push(`${path}: imports ${module}, which is for ${allowed.join(", ")}`);
    }
    if (path.startsWith(W)) for (const [pattern, name, allowed] of NAMES) if (pattern.test(text) && !allowed.includes(path)) out.push(`${path}: names ${name}, which belongs to ${allowed.join(", ")}`);
    if (path.startsWith("packages/broker/src/") && BROKER_DELIVERY.test(text) && !BROKER_USERS.includes(path) && !path.endsWith("/fixture-delivery.ts")) out.push(`${path}: imports the broker's fixture delivery, which only the callback route uses`);
    if (AGENT_FACING.some((pattern) => pattern.test(path)) && /fixture-delivery|fake-helper|fake-usage|fixture-fetch|\bFixtureSet\b|\bfetchFixtureSet\b/u.test(text)) out.push(`${path}: an agent-facing module names a fixture set or the modules that handle one`);
  }
  return out;
}

async function sourcesOfAllPackages(): Promise<Source[]> {
  const repo = new URL("../../", import.meta.url).pathname;
  const sources: Source[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== "dist") await walk(path); continue; }
      if (/\.tsx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts")) sources.push({ path: path.slice(repo.length), text: await readFile(path, "utf8") });
    }
  };
  for (const pkg of await readdir(join(repo, "packages"))) {
    const src = join(repo, "packages", pkg, "src");
    try { await walk(src); } catch { /* a package without a src folder */ }
  }
  return sources;
}

describe("where the content of a fixture set may go", () => {
  it("no module outside the run layer imports the modules that handle a set's content, and nothing agent-facing names a set", async () => {
    const sources = await sourcesOfAllPackages();
    expect(sources.length).toBeGreaterThan(500);
    expect(fixtureSourceViolations(sources)).toEqual([]);
  });
  it("the guard sees what it must: the allowed files exist and do use the modules they are allowed", async () => {
    const sources = await sourcesOfAllPackages();
    const text = (path: string) => sources.find((source) => source.path === path)?.text ?? "";
    expect(text(`${W}test-services-run.ts`)).toMatch(/\/fixture-delivery\.js"/u);
    expect(text(`${W}test-services-run.ts`)).toMatch(/\/fake-usage\.js"/u);
    expect(text(`${W}run-task.ts`)).toMatch(/\/fixture-delivery\.js"/u);
    expect(text(`${W}fixture-delivery.ts`)).toMatch(/\/fixture-fetch\.js"/u);
    expect(text("packages/broker/src/aws/broker/callbacks.ts")).toMatch(/\/fixture-delivery\.js"/u);
  });
  it("fails for each way a set's content could be sent somewhere an agent reads (the scanner is not passing on an empty search)", () => {
    const bad: Source[] = [
      { path: `${W}agent-tools.ts`, text: 'import { createFixtureDelivery } from "./fixture-delivery.js";' },
      { path: `${W}agent-session.ts`, text: 'import { x } from "./fake-helper.js";' },
      { path: `${W}events.ts`, text: 'import { fetchFixtureSet } from "./fixture-fetch.js";' },
      { path: `${W}task-sandbox.ts`, text: "const { fixtureJson } = request;" },
      { path: `${W}prompt-builder.ts`, text: 'import type { FixtureSet } from "@agentx/contracts";' },
      { path: "packages/model-runtime/src/context.ts", text: 'import { fetchFixtureSet } from "@agentx/x"; // FixtureSet' },
      { path: "packages/broker/src/aws/broker/handler.ts", text: 'import { handleFixtureSetCallback } from "./fixture-delivery.js";' },
    ];
    for (const source of bad) expect(fixtureSourceViolations([source]), source.path).not.toEqual([]);
    const fine: Source[] = [
      { path: `${W}test-services-run.ts`, text: 'import { createFixtureDelivery } from "./fixture-delivery.js"; const fixtureJson = 1;' },
      { path: `${W}service-helpers.ts`, text: "const fixtureJson = request.fake.fixtureJson;" },
      { path: "packages/broker/src/aws/broker/callbacks.ts", text: 'import { handleFixtureSetCallback } from "./fixture-delivery.js";' },
    ];
    expect(fixtureSourceViolations(fine)).toEqual([]);
  });
});
