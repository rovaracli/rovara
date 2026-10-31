// Enterprise foundations, task I2: finds every place the code decides something from a company role in a way the Auditor could slip through. It reads source text
// only, with comments blanked out.
//
// A check written as a positive list (`role === "owner" || role === "admin"`, or its refusal form `role !== "owner" && role !== "admin"`) refuses the Auditor by
// construction, and so does a comparison with `owner` alone. Two shapes do not:
//   - a comparison with `member` (or with `admin` alone): `role !== "member"` lets the Auditor in, and `role === "member" ? a : b` sends it down the else branch;
//   - a default that turns a role the code does not read into a member: `role ?? "member"`.
// Every such site must be in the reviewed list (tests/roles/role-sites-reviewed.ts) with the reason the Auditor is safe there. A new site fails the test until
// someone reads it and adds it, which is how "a new role check forgot the Auditor" is caught.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { withoutComments } from "../egress/scan-outbound-hosts.js";

export interface RoleSite { file: string; line: number; text: string; shape: "member" | "admin-only" | "default" }

/** Presentation code decides nothing: the broker refuses, whatever a screen shows. */
const SKIPPED_PACKAGES = new Set(["ui", "web"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "test", "tests", "__tests__", "fixtures", ".git", "coverage"]);
const SOURCE_FILE = /\.(?:ts|tsx)$/;
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;

const ROLEISH = String.raw`(?:[A-Za-z_$][\w$]*\.)*[\w$]*[rR]ole[\w$]*(?:\??\.[\w$]+|\[[^\]]*\])*`;
const COMPARISON = new RegExp(`(${ROLEISH})\\s*(===|!==|==|!=)\\s*(["'])(owner|admin|member)\\3|(["'])(owner|admin|member)\\5\\s*(===|!==|==|!=)\\s*(${ROLEISH})`, "g");
const SWITCH_CASE = /\bcase\s+(["'])(owner|admin|member)\1\s*:/g;
const DEFAULT_TO_MEMBER = new RegExp(`(?:${ROLEISH})[^;]{0,60}\\?\\?\\s*(["'])member\\1`);

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* walk(join(directory, entry.name));
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) yield join(directory, entry.name);
  }
}

/** The roles a line compares a role with, and whether it also defaults a role to `member`. */
export function roleSitesIn(text: string, file: string): RoleSite[] {
  const sites: RoleSite[] = [];
  const lines = withoutComments(text).split("\n");
  lines.forEach((line, index) => {
    const compared = new Set<string>();
    for (const match of line.matchAll(COMPARISON)) compared.add(match[4] ?? match[6]!);
    for (const match of line.matchAll(SWITCH_CASE)) compared.add(match[2]!);
    const shape: RoleSite["shape"] | undefined = compared.has("member") ? "member"
      : compared.size > 0 && !compared.has("owner") ? "admin-only"
      : DEFAULT_TO_MEMBER.test(line) ? "default" : undefined;
    if (shape !== undefined) sites.push({ file, line: index + 1, text: line.trim().replace(/\s+/g, " "), shape });
  });
  return sites;
}

export function roleSites(repoRoot: string): RoleSite[] {
  const sites: RoleSite[] = [];
  for (const name of readdirSync(join(repoRoot, "packages")).sort()) {
    if (SKIPPED_PACKAGES.has(name)) continue;
    const root = join(repoRoot, "packages", name, "src");
    try { if (!statSync(root).isDirectory()) continue; } catch { continue; }
    for (const path of walk(root)) sites.push(...roleSitesIn(readFileSync(path, "utf8"), relative(repoRoot, path).replace(/\\/g, "/")));
  }
  return sites;
}
