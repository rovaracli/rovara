// Stdio MCP host redesign (T2), design section 5: the dependency rules, checked on the lockfile BEFORE anything in it is fetched. A pure function: bytes in, a verdict out.
//
//   1. Registry only. Every `resolved` is https on the install's one registry (host, port and path prefix). git, github:, file:, link:, http:, another host and an alias that
//      resolves elsewhere are refused.
//   2. Integrity everywhere. Every package has exactly one `sha512-` integrity. sha1, several hashes and a missing value are refused.
//   3. Install steps are refused (owner decision, 2026-10-31: packages needing install scripts or native builds are refused in v1). A package whose lockfile entry says
//      `hasInstallScript` (npm sets it for install, preinstall, postinstall and for a binding.gyp) is refused, naming it. Nothing is ever run either way: --ignore-scripts holds at
//      every npm call.
//   4. Bounds: at most `maxPackages` packages, and a lockfile of at most `maxLockfileBytes`.
//
// Every entry is held to the registry and integrity rules, development-only ones included (they are not installed, but a flag in the file is not trusted to say so).
// Only npm lockfile versions 2 and 3 (they carry the flat `packages` map) are read. Version 1 has no such map, and anything this code does not understand is refused: the rule is
// to fail closed.
import { createHash } from "node:crypto";

export type LockfileRule = "lockfile_format" | "registry_only" | "integrity" | "bounds" | "install_scripts";

export const LOCKFILE_LIMITS = { maxPackages: 1_500, maxLockfileBytes: 16 * 1_048_576 } as const;

export interface LockfilePolicyOptions {
  /** The install's registry address (`rovaraMcpNpmRegistry`). It must be https. */
  registry: string;
  maxPackages?: number | undefined;
  maxLockfileBytes?: number | undefined;
}

export type LockfileVerdict =
  | { ok: true; packageCount: number }
  | { ok: false; rule: LockfileRule; /** A package name that is safe to show, when the rule is about one package. */ package?: string; /** A fixed sentence for the admin. It holds nothing from the lockfile except a checked package name. */ sentence: string };

/** sha256 of the lockfile bytes, as 64 lower-case hex characters. This is the `lockfileHash` the approval binds. */
export function lockfileHash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,60}\/)?[a-z0-9][a-z0-9._-]{0,60}$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u;
/** The path of a package in a lockfile: `node_modules/a`, `node_modules/@s/a`, `node_modules/a/node_modules/b`. Anything else (`../x`, `packages/x`, `/x`) is not inside the tree. */
const PACKAGE_PATH = /^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/u;

/** The sentence for a package that needs install steps or a native build. */
export const INSTALL_STEPS_SENTENCE = (name: string | undefined): string => `${name === undefined ? "A dependency" : `The dependency ${name}`} needs install steps or a native build. Rovara does not run install steps, so this package cannot be used yet.`;

const FORMAT_SENTENCE = "Rovara could not read this package's dependency list.";

function refusal(rule: LockfileRule, sentence: string, name?: string): LockfileVerdict {
  return { ok: false, rule, sentence, ...(name === undefined ? {} : { package: name }) };
}

/** The package's name as it can be shown: the last `node_modules/` segment of its path, if it is a plain npm name. */
function shownName(path: string): string | undefined {
  const marker = path.lastIndexOf("node_modules/");
  const name = marker < 0 ? "" : path.slice(marker + "node_modules/".length);
  return NPM_NAME.test(name) ? name : undefined;
}

const subject = (name: string | undefined): string => (name === undefined ? "a dependency" : `the dependency ${name}`);
const Subject = (name: string | undefined): string => (name === undefined ? "A dependency" : `The dependency ${name}`);

function kindOfResolved(resolved: string): "git" | "path" | "http" | "other" {
  const lower = resolved.trim().toLowerCase();
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:|ssh:|git@)/u.test(lower)) return "git";
  if (/^(?:file:|link:|\.{0,2}\/|[a-z]:\\)/u.test(lower)) return "path";
  if (lower.startsWith("http:")) return "http";
  return "other";
}

/** `https://registry.example/npm/` -> { host, prefix: "/npm/" }. Throws on a registry that is not https (a configuration error, not a verdict). */
function registryParts(registry: string): { host: string; prefix: string } {
  let url: URL;
  try { url = new URL(registry); } catch { throw new Error("the npm registry address is not a web address"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hostname === "") throw new Error("the npm registry address must be https, with no login");
  return { host: url.host.toLowerCase(), prefix: url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/` };
}

/** Whether `resolved` is an https tarball address on the registry. Returns the sentence to show when it is not. */
function registryProblem(resolved: unknown, registry: { host: string; prefix: string }, name: string | undefined): string | undefined {
  const who = subject(name);
  if (typeof resolved !== "string" || resolved === "") return `${Subject(name)} has no download address on your registry. Rovara installs only from your registry.`;
  switch (kindOfResolved(resolved)) {
    case "git": return "This package needs a git dependency. Rovara installs only from your registry.";
    case "path": return `This package needs ${who} from a file or a link. Rovara installs only from your registry.`;
    case "http": return `This package needs ${who} from an address that is not https. Rovara installs only from your registry.`;
    default: break;
  }
  let url: URL;
  try { url = new URL(resolved); } catch { return `This package needs ${who} from an address Rovara cannot read. Rovara installs only from your registry.`; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.host.toLowerCase() !== registry.host || !url.pathname.startsWith(registry.prefix)) {
    return `This package needs ${who} from outside your registry. Rovara installs only from your registry.`;
  }
  return undefined;
}

interface Entry { path: string; value: Record<string, unknown> }

/** The parent path of a package path (`node_modules/a/node_modules/b` -> `node_modules/a`), or undefined for a top-level package. */
function parentPath(path: string): string | undefined {
  const marker = path.lastIndexOf("/node_modules/");
  return marker < 0 ? undefined : path.slice(0, marker);
}

/**
 * Checks a lockfile (the bytes as the install read them) against the dependency rules. The first breach in path order is returned; a clean lockfile returns the number of
 * packages and the names of those that have install steps (which will be skipped).
 */
export function checkLockfile(lockfile: string | Uint8Array, options: LockfilePolicyOptions): LockfileVerdict {
  const registry = registryParts(options.registry);
  const maxPackages = options.maxPackages ?? LOCKFILE_LIMITS.maxPackages;
  const maxBytes = options.maxLockfileBytes ?? LOCKFILE_LIMITS.maxLockfileBytes;
  const length = typeof lockfile === "string" ? Buffer.byteLength(lockfile) : lockfile.byteLength;
  if (length > maxBytes) return refusal("bounds", "This package's dependency list is too large for Rovara to check.");
  let parsed: unknown;
  try { parsed = JSON.parse(typeof lockfile === "string" ? lockfile : Buffer.from(lockfile).toString("utf8")); } catch { return refusal("lockfile_format", FORMAT_SENTENCE); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return refusal("lockfile_format", FORMAT_SENTENCE);
  const document = parsed as Record<string, unknown>;
  if (document.lockfileVersion !== 2 && document.lockfileVersion !== 3) return refusal("lockfile_format", FORMAT_SENTENCE);
  const packages = document.packages;
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) return refusal("lockfile_format", FORMAT_SENTENCE);

  const entries: Entry[] = [];
  for (const [path, value] of Object.entries(packages as Record<string, unknown>)) {
    if (path === "") continue; // the package being installed; its tarball is pinned by its own integrity
    if (typeof value !== "object" || value === null || Array.isArray(value)) return refusal("lockfile_format", FORMAT_SENTENCE);
    entries.push({ path, value: value as Record<string, unknown> });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Only packages that are installed (not development-only) count against the limit; all of them are checked for the registry and integrity rules, optional ones included.
  const installed = entries.filter((entry) => entry.value.dev !== true);
  if (installed.length > maxPackages) return refusal("bounds", `This package has too many dependencies (${installed.length}). Rovara allows at most ${maxPackages}.`);

  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const covered = (entry: Entry, depth = 0): boolean => {
    // A package bundled inside another package's tarball has no address and no checksum of its own: the tarball that holds it has both.
    if (depth > 64) return false;
    const holder = parentPath(entry.path);
    const parent = holder === undefined ? undefined : byPath.get(holder);
    if (parent === undefined || parent.value.link === true) return false;
    return parent.value.inBundle === true ? covered(parent, depth + 1) : typeof parent.value.integrity === "string" && INTEGRITY.test(parent.value.integrity);
  };

  for (const entry of entries) {
    const { path, value } = entry;
    const name = shownName(path);
    if (!PACKAGE_PATH.test(path) || path.split("/").some((part) => part === "" || part === "." || part === "..")) return refusal("registry_only", `This package needs ${subject(name)} from outside your registry. Rovara installs only from your registry.`, name);
    if (value.link === true) return refusal("registry_only", `This package needs ${subject(name)} from a file or a link. Rovara installs only from your registry.`, name);
    const bundled = value.inBundle === true && covered(entry);
    if (value.inBundle === true && !bundled) return refusal("registry_only", `This package needs ${subject(name)} from outside your registry. Rovara installs only from your registry.`, name);
    // A bundled package has no address of its own. If it names one, that address is held to the same rule.
    if (!bundled || value.resolved !== undefined) {
      const problem = registryProblem(value.resolved, registry, name);
      if (problem !== undefined) return refusal("registry_only", problem, name);
    }
    if (!bundled || value.integrity !== undefined) {
      if (typeof value.integrity !== "string" || !INTEGRITY.test(value.integrity)) {
        return refusal("integrity", `${Subject(name)} has no sha512 checksum in the dependency list. Rovara installs only checksummed packages.`, name);
      }
    }
    if (value.hasInstallScript !== undefined && value.hasInstallScript !== false && value.dev !== true) return refusal("install_scripts", INSTALL_STEPS_SENTENCE(name), name);
  }
  return { ok: true, packageCount: installed.length };
}
