// TE-B1-fresh: source guards for the fresh check round. Only the chooser (check-round-choice.ts) may import the fresh round; only the fresh round starts the fresh sandbox; no module imports both round kinds; and the sealed round's own
// files carry no "unsealed" option. The scanner is a pure function over {path, text}, and the tests feed it bad sources, so the guard is not passing on an empty search.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface Source { path: string; text: string }
const W = "packages/worker/src/";
const FRESH_ROUND = /["'][^"']*\/fresh-check-round(?:\.js|\.ts)?["']/u;
const SEALED_ROUND = /["'][^"']*\/check-round-runners(?:\.js|\.ts)?["']/u;
const FRESH_SANDBOX_MODULE = /["'][^"']*\/fresh-check-sandbox(?:\.js|\.ts)?["']/u;
/** The only modules that may import the fresh round. */
export const FRESH_ROUND_USERS: readonly string[] = [`${W}check-round-choice.ts`];
/** The modules that may name the fresh sandbox's run arguments. */
const RUN_ARGS_USERS: readonly string[] = [`${W}fresh-check-sandbox.ts`, `${W}fresh-check-round.ts`];
/** The sealed round's files: no option that makes them unsealed, no mention of the fresh round. */
const SEALED_FILES: readonly string[] = [`${W}check-sandbox.ts`, `${W}check-round-runners.ts`];

export function freshSourceViolations(sources: readonly Source[]): string[] {
  const out: string[] = [];
  for (const { path, text } of sources) {
    if (/\bfreshCheckRound\s*:/u.test(text.replace(/\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, ""))) out.push(`${path}: wires the dormant fresh round into production`);
    if (FRESH_ROUND.test(text) && !FRESH_ROUND_USERS.includes(path)) out.push(`${path}: is not allowed to import the fresh check round`);
    if (/\bfreshSandboxRunArgs\b/u.test(text) && !RUN_ARGS_USERS.includes(path)) out.push(`${path}: names freshSandboxRunArgs, which only the fresh round starts a sandbox with`);
    if (/\bstartFreshSandbox\b|\bwithFreshCheckRound\b/u.test(text) && ![`${W}fresh-check-round.ts`, ...FRESH_ROUND_USERS].includes(path)) out.push(`${path}: names the fresh round's start`);
    if (FRESH_ROUND.test(text) && SEALED_ROUND.test(text)) out.push(`${path}: imports both round kinds`);
    if (FRESH_SANDBOX_MODULE.test(text) && ![`${W}fresh-check-round.ts`, `${W}check-round-choice.ts`].includes(path) && path !== `${W}fresh-check-sandbox.ts`) out.push(`${path}: is not allowed to import the fresh sandbox module`);
    if (path === `${W}fresh-check-round.ts` || path === `${W}fresh-check-sandbox.ts`) {
      if (/["'][^"']*\/(?:check-sandbox|check-round-runners|test-services-run)(?:\.js|\.ts)?["']/u.test(text)) out.push(`${path}: imports the sealed round's modules`);
      if (/\bTaskSandbox\b/u.test(text.replace(/\/\/.*$/gmu, ""))) out.push(`${path}: names the working sandbox's class`);
    }
    if (SEALED_FILES.includes(path) && /fresh_unsealed|freshCheckRound|fresh-check|\bunsealed\b|\bunsealedRound\b/iu.test(text.replace(/\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, ""))) out.push(`${path}: has an unsealed or fresh option`);
  }
  return out;
}

async function sourcesOfAllPackages(): Promise<Source[]> {
  const repo = new URL("../../", import.meta.url).pathname;
  const sources: Source[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") await walk(path); continue; }
      if (/\.tsx?$/u.test(entry.name) && !entry.name.endsWith(".d.ts")) sources.push({ path: path.slice(repo.length), text: await readFile(path, "utf8") });
    }
  };
  for (const pkg of await readdir(join(repo, "packages"))) {
    if ((await readdir(join(repo, "packages", pkg))).includes("src")) await walk(join(repo, "packages", pkg, "src"));
  }
  return sources;
}

describe("the fresh round's source guards", () => {
  it("every file under packages/*/src passes", async () => {
    const sources = await sourcesOfAllPackages();
    for (const path of [`${W}fresh-check-round.ts`, `${W}fresh-check-sandbox.ts`, `${W}check-round-choice.ts`, `${W}check-sandbox.ts`, `${W}check-round-runners.ts`]) expect(sources.some((source) => source.path === path), path).toBe(true);
    expect(freshSourceViolations(sources)).toEqual([]);
  });
  it("finds a stray importer, a stray start, a module that imports both kinds, and an option in the sealed files", () => {
    const bad = (path: string, text: string) => freshSourceViolations([{ path, text }]);
    expect(bad(`${W}main.ts`, "runTaskInvocation(task, { freshCheckRound: () => ({ setup: [] }) });")).toEqual([`${W}main.ts: wires the dormant fresh round into production`]);
    expect(bad(`${W}run-task.ts`, 'import { withFreshCheckRound } from "./fresh-check-round.js";')).toEqual([`${W}run-task.ts: is not allowed to import the fresh check round`, `${W}run-task.ts: names the fresh round's start`]);
    expect(bad(`${W}x.ts`, "const a = freshSandboxRunArgs(input);")).toEqual([`${W}x.ts: names freshSandboxRunArgs, which only the fresh round starts a sandbox with`]);
    expect(bad(`${W}check-round-choice.ts`, 'import { createFreshCheckRunners } from "./fresh-check-round.js";\nimport { runSealedCheckRound } from "./check-round-runners.js";')).toEqual([`${W}check-round-choice.ts: imports both round kinds`]);
    expect(bad(`${W}check-round-runners.ts`, "export function withSealedCheckRound(input: { unsealed?: boolean; fresh_unsealed: boolean }) {}")).toEqual([`${W}check-round-runners.ts: has an unsealed or fresh option`]);
    expect(bad(`${W}fresh-check-round.ts`, 'import { withSealedCheckRound } from "./check-round-runners.js";')).toEqual([`${W}fresh-check-round.ts: imports the sealed round's modules`]);
    expect(bad(`${W}fresh-check-round.ts`, 'import { TaskSandbox } from "./task-sandbox.js";\nconst x = new TaskSandbox({});')).toEqual([`${W}fresh-check-round.ts: names the working sandbox's class`]);
    expect(bad(`${W}check-round-choice.ts`, 'import { createFreshCheckRunners } from "./fresh-check-round.js";')).toEqual([]);
    expect(bad(`${W}check-round-runners.ts`, "// the sealed round is never unsealed here\nexport const x = 1;")).toEqual([]);
  });
});
