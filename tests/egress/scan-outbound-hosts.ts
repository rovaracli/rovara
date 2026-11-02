// Enterprise foundations, task N4: finds every external host written into the code an install runs. It reads source text only (no network, no build), strips
// comments, and records a host wherever one appears in a URL literal, or alone as a string that is a host name. A host built from parts at run time
// (`https://${tenant}.example.com`) shows only its fixed tail, and a host read from a setting is not here at all: the list is the floor of what the code can
// reach, not the whole of it. docs/enterprise/outbound.md says what each host is for and what an Enterprise install does about it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface FoundHost { host: string; file: string; line: number }

const SOURCE_FILE = /\.(?:ts|tsx)$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "test", "tests", "__tests__", "fixtures", ".git", "coverage"]);
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;
/** Files that are data tables of names, not code that connects to them: the Public Suffix List is a list of domain endings, read from memory. */
const DATA_FILES = new Set(["public-suffix-rules.ts"]);

/** The roots whose code runs in an install: every package's source, and the infrastructure code that builds it. */
export function sourceRoots(repoRoot: string): string[] {
  const packages = readdirSync(join(repoRoot, "packages")).map((name) => join(repoRoot, "packages", name, "src")).filter((path) => {
    try { return statSync(path).isDirectory(); } catch { return false; }
  });
  return [...packages, join(repoRoot, "infra", "lib"), join(repoRoot, "infra", "bin")].filter((path) => {
    try { return statSync(path).isDirectory(); } catch { return false; }
  });
}

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* walk(join(directory, entry.name));
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) && !entry.name.endsWith(".d.ts") && !DATA_FILES.has(entry.name)) {
      yield join(directory, entry.name);
    }
  }
}

/** The text with comments blanked out (line numbers kept), so a link in a comment is not a host the code reaches. A `//` inside a URL (after `:`) is not a comment. */
export function withoutComments(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:\\"'`])\/\/[^\n]*/g, (match, lead: string) => lead + blank(match.slice(lead.length)));
}

const URL_HOST = /\bhttps?:\/\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,})(?![A-Za-z0-9.-]*\$\{)/g;
/** A string that is nothing but a dotted name (optionally `*.`-prefixed); whether it is a host is decided by its last label (below). */
const BARE_CANDIDATE = /(["'`])((?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})\1/gi;
/**
 * The endings a bare string must have to be read as a host. Not every top-level domain: many are also English words code uses in dotted names (`audit.read`,
 * `users.info`, `os.name`, `project.id`), and the Public Suffix List's own matcher treats every unknown ending as a domain, so a full list would bury the real
 * hosts. These are the common ones; a host under another ending is caught when it is written as a URL, which is how a call is written.
 */
const HOST_ENDINGS = new Set([
  "com", "org", "net", "io", "dev", "app", "ai", "co", "cloud", "aws", "invalid", "test", "local", "us", "me", "xyz", "eu", "uk", "de", "fr", "jp", "ca", "au", "tech", "site", "online", "page", "cn",
]);

export function foundHostsIn(text: string, file: string): FoundHost[] {
  const code = withoutComments(text);
  const found: FoundHost[] = [];
  const lineOf = (index: number) => code.slice(0, index).split("\n").length;
  for (const match of code.matchAll(URL_HOST)) found.push({ host: match[1]!.toLowerCase(), file, line: lineOf(match.index) });
  for (const match of code.matchAll(BARE_CANDIDATE)) {
    const host = match[2]!.toLowerCase();
    const ending = host.slice(host.lastIndexOf(".") + 1);
    if (HOST_ENDINGS.has(ending)) found.push({ host, file, line: lineOf(match.index) });
  }
  return found;
}

export function scanOutboundHosts(repoRoot: string): FoundHost[] {
  const found: FoundHost[] = [];
  for (const root of sourceRoots(repoRoot)) {
    for (const path of walk(root)) found.push(...foundHostsIn(readFileSync(path, "utf8"), relative(repoRoot, path)));
  }
  return found.sort((a, b) => (a.host === b.host ? (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1) : a.host < b.host ? -1 : 1));
}

const DNS_IMPORT = /\bfrom\s+["'](?:node:)?dns(?:\/promises)?["']|\brequire\(\s*["'](?:node:)?dns(?:\/promises)?["']\s*\)/;

/** The source files (relative to the repository root) that import Node's DNS: the places that look a name up. */
export function scanDnsLookupFiles(repoRoot: string): string[] {
  const files: string[] = [];
  for (const root of sourceRoots(repoRoot)) {
    for (const path of walk(root)) if (DNS_IMPORT.test(withoutComments(readFileSync(path, "utf8")))) files.push(relative(repoRoot, path));
  }
  return files.sort();
}
