// Stdio MCP host redesign (T3, T4): which program a package offers. Used by the install (to check it is there) and by the bridge (to start it); both read the same
// package.json, which the bundle hash pins, so they always agree.
import { posix } from "node:path";
import { bundlePathProblem } from "./bundle.js";

/** The program a package offers, as a path inside its folder, or undefined. The package's own binary name is preferred over another one. */
export function binOf(name: string, manifest: Record<string, unknown>): string | undefined {
  const own = name.split("/").at(-1)!;
  const bin = manifest.bin;
  let relative: unknown;
  if (typeof bin === "string") relative = bin;
  else if (typeof bin === "object" && bin !== null && !Array.isArray(bin)) {
    const table = bin as Record<string, unknown>;
    relative = Object.hasOwn(table, own) ? table[own] : Object.values(table)[0];
  }
  if (typeof relative !== "string") return undefined;
  const cleaned = posix.normalize(relative.replace(/^\.\//u, ""));
  return bundlePathProblem(cleaned) === undefined && !cleaned.startsWith("../") ? cleaned : undefined;
}
