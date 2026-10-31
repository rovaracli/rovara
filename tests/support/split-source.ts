import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The text of a source file that may have been split into modules (scripts/split/split-developer.ts): the file, then every `.ts` file in the directory
 * named like it without the extension (`developer-tasks.ts` and `developer-tasks/*.ts`), each starting on its own line. A file that was never split reads as itself.
 */
export function readSplitSource(file: string): string {
  return readSplitParts(file).join("\n");
}

/** The same files, one text each (the file itself first), for a check that must hold within a single file. */
export function readSplitParts(file: string): string[] {
  const own = readFileSync(file, "utf8");
  const directory = file.replace(/\.ts$/u, "");
  if (!existsSync(directory)) return [own];
  const parts = readdirSync(directory).filter((name) => name.endsWith(".ts")).sort().map((name) => readFileSync(path.join(directory, name), "utf8"));
  return [own, ...parts];
}
