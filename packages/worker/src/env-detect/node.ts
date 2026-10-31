// Node detector: package.json scripts (test, lint, typecheck, build), the package manager's install command, and lockfiles.
import { type Detection, type Detector, findLine } from "./types.js";

const LOCKS: ReadonlyArray<{ file: string; setup: [string, string[]] }> = [
  { file: "package-lock.json", setup: ["npm", ["ci"]] },
  { file: "pnpm-lock.yaml", setup: ["pnpm", ["install", "--frozen-lockfile"]] },
  { file: "yarn.lock", setup: ["yarn", ["install", "--frozen-lockfile"]] },
];
const SCRIPTS: ReadonlyArray<{ names: readonly string[]; id: string; label: string; kind: "test" | "lint" | "typecheck" | "build"; timeout: number }> = [
  { names: ["test", "test:unit"], id: "unit", label: "Tests", kind: "test", timeout: 1_800 },
  { names: ["lint"], id: "lint", label: "Lint", kind: "lint", timeout: 600 },
  { names: ["typecheck", "type-check", "tsc"], id: "typecheck", label: "Type check", kind: "typecheck", timeout: 900 },
  { names: ["build"], id: "build", label: "Build", kind: "build", timeout: 900 },
];

export const detectNode: Detector = async ({ repo, cwd }) => {
  if (!repo.paths.includes("package.json")) return {};
  const text = await repo.read("package.json");
  if (text === undefined) return {};
  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as { scripts?: unknown };
    if (parsed.scripts !== null && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)) scripts = parsed.scripts as Record<string, unknown>;
  } catch {
    return { notes: ["package.json could not be read as JSON."] };
  }
  const found: Partial<Detection> = { setupCommands: [], checks: [], fullSuiteOn: [], notes: [] };
  const lock = LOCKS.find((candidate) => repo.paths.includes(candidate.file));
  if (lock !== undefined) {
    found.setupCommands!.push({ value: { cwd, executable: lock.setup[0], args: lock.setup[1], timeoutSeconds: 900 }, source: { path: lock.file, line: 1 } });
    found.fullSuiteOn!.push({ value: lock.file, source: "detector:node" });
  } else {
    found.setupCommands!.push({ value: { cwd, executable: "npm", args: ["install"], timeoutSeconds: 900 }, source: { path: "package.json", line: 1 } });
  }
  found.fullSuiteOn!.push({ value: "package.json", source: "detector:node" });
  const manager = lock?.setup[0] === "pnpm" ? "pnpm" : lock?.setup[0] === "yarn" ? "yarn" : "npm";
  for (const entry of SCRIPTS) {
    const name = entry.names.find((candidate) => typeof scripts[candidate] === "string" && (scripts[candidate]).trim() !== "");
    if (name === undefined) continue;
    const line = findLine(text, new RegExp(`"${name.replace(/[:]/gu, "\\:")}"\\s*:`, "u")) ?? 1;
    found.checks!.push({ value: { id: entry.id, label: entry.label, kind: entry.kind, command: { cwd, executable: manager, args: manager === "npm" ? ["run", name] : [name], timeoutSeconds: entry.timeout } }, source: { path: "package.json", line } });
  }
  if (found.checks!.some((check) => check.value.kind === "test")) found.notes!.push("The test script writes no report file Rovara knows of; counts come from the exit code unless the maintainer sets a report path.");
  return found;
};
