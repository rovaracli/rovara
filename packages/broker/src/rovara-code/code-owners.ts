// Rovara Code (owner decision 2026-10-27): where the repository has a CODEOWNERS file that covers the paths a pull request changes, a code owner has to approve it before Rovara calls it
// ready. This reads the file the way GitHub does (the last matching rule wins; a rule with no owner takes ownership away) and says who is still missing. Pure except for the team lookup the
// caller passes in. It never trusts what it cannot read: an unreadable team is "unknown", and a path whose only owners are unknown teams is not satisfied. A file with anything Rovara cannot read
// the way GitHub does (negation, character classes, an owner that is no @name or email, more rules than it reads) is unreadable as a whole: the rules after a line that was skipped could
// otherwise take the place of the ones that were meant.

import type { CodeOwner, CodeOwnersRead } from "@rovara-code/contracts";

export interface CodeOwnerRule {
  pattern: string;
  owners: string[];
  /** The pattern as a test on a path written with `/`, no leading slash. */
  matches(path: string): boolean;
}

export type CodeOwnerVerdict = { ok: true } | { ok: false; owners: string } | { ok: false; unreadable: true };

/** The most rules read from one file. */
const RULES_MAX = 5_000;
const OWNER = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]{1,100})?$/u;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;

function escapeSegment(segment: string): string {
  let out = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (char === "*") {
      if (segment[index + 1] === "*") { out += ".*"; index += 1; } else out += "[^/]*";
    } else if (char === "?") out += "[^/]";
    else out += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return out;
}

/** A gitignore-style pattern as GitHub's CODEOWNERS reads it. */
function compile(pattern: string): (path: string) => boolean {
  const directory = pattern.endsWith("/");
  const trimmed = pattern.replace(/^\/+/u, "").replace(/\/+$/u, "");
  // A pattern with a slash anywhere but the end is anchored to the root, as is one that starts with a slash.
  const anchored = pattern.startsWith("/") || trimmed.includes("/");
  const segments = trimmed.split("/");
  let body = "";
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (segment === "**") body += last ? ".*" : "(?:.*/)?";
    else body += escapeSegment(segment) + (last ? "" : "/");
  }
  const lastSegment = segments[segments.length - 1] ?? "";
  // A name with no wildcard (or a directory) owns what is inside it; a wildcard in the last segment (`*.js`, `docs/*`) matches that level only.
  const ownsInside = directory || !/[*?]/u.test(lastSegment);
  const regex = new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}${ownsInside ? "(?:/.*)?" : ""}$`, "u");
  return (path) => regex.test(path);
}

/** The rules of a CODEOWNERS file, in order, and whether the file held anything Rovara cannot read. Comments and blank lines are skipped. An email is an owner (Rovara cannot match it to an approver). */
export function parseCodeOwners(text: string): { rules: CodeOwnerRule[]; unsupported: boolean } {
  const rules: CodeOwnerRule[] = [];
  let unsupported = false;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/(^|\s)#.*$/u, "").trim();
    if (line === "") continue;
    const [pattern, ...rest] = line.split(/\s+/u);
    if (pattern === undefined || pattern === "" || pattern.startsWith("!") || pattern.includes("[") || rest.some((owner) => !OWNER.test(owner) && !EMAIL.test(owner))) { unsupported = true; continue; }
    // More rules than are read: the later, more specific ones would be the ones lost.
    if (rules.length >= RULES_MAX) return { rules, unsupported: true };
    rules.push({ pattern, owners: rest, matches: compile(pattern) });
  }
  return { rules, unsupported };
}

/** The owners of one path: those of the last rule that matches it (none when that rule names none). */
export function ownersOfPath(rules: readonly CodeOwnerRule[], path: string): string[] {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/u, "");
  for (let index = rules.length - 1; index >= 0; index -= 1) if (rules[index]!.matches(normalized)) return rules[index]!.owners;
  return [];
}

/** One owner as the code host port names it (convergence W0-3: the host reads its own owners file and the core asks who owns a path). `@name` is a person, `@org/team` a team, anything else is an email. */
function ownerOf(owner: string): CodeOwner {
  if (!owner.startsWith("@")) return { kind: "other", label: owner };
  return owner.includes("/") ? { kind: "team", team: owner.slice(1) } : { kind: "person", login: owner.slice(1) };
}

/** An owner back in the one-string form this file's rules work in. */
function ownerText(owner: CodeOwner): string {
  return owner.kind === "person" ? `@${owner.login}` : owner.kind === "team" ? `@${owner.team}` : owner.label;
}

/** A CODEOWNERS file as the host port's neutral read: GitHub's adapter answers with this, reading the file as GitHub does (this file's rules). */
export function codeOwnersReadOf(text: string): CodeOwnersRead {
  const parsed = parseCodeOwners(text);
  return { unsupported: parsed.unsupported, ownersOf: (path) => ownersOfPath(parsed.rules, path).map(ownerOf) };
}

export interface CodeOwnerInput {
  /** The file as the base branch holds it; undefined when it has none. Ignored when `codeOwnersRead` is given. */
  codeOwnersText?: string | undefined;
  /** The host's own read of the file (`CodeHost.codeOwners`); wins over `codeOwnersText`. */
  codeOwnersRead?: CodeOwnersRead | undefined;
  /** Every path the pull request changes (a renamed file under both names). */
  paths: readonly string[];
  /** The GitHub logins of the counted approvers. */
  approverLogins: readonly string[];
  teamMember(team: string, login: string): Promise<"member" | "not_member" | "unknown">;
}

const NAMED = 3;

/** Whether every changed path that has a code owner has an approval from one of its owners. */
export async function codeOwnerVerdict(input: CodeOwnerInput): Promise<CodeOwnerVerdict> {
  const read = input.codeOwnersRead ?? (input.codeOwnersText === undefined ? undefined : codeOwnersReadOf(input.codeOwnersText));
  if (read === undefined) return { ok: true };
  if (read.unsupported) return { ok: false, unreadable: true };
  const approvers = [...new Set(input.approverLogins.map((login) => login.toLowerCase()))];
  const asked = new Map<string, Promise<"member" | "not_member" | "unknown">>();
  const inTeam = (owner: string, login: string) => {
    const key = `${owner.toLowerCase()}|${login}`;
    let found = asked.get(key);
    if (found === undefined) {
      found = input.teamMember(owner.slice(1), login).catch(() => "unknown" as const);
      asked.set(key, found);
    }
    return found;
  };
  // Paths with the same owners are asked about once.
  const ownerSets = new Map<string, string[]>();
  for (const path of input.paths) {
    const owners = read.ownersOf(path).map(ownerText);
    if (owners.length > 0) ownerSets.set(owners.map((owner) => owner.toLowerCase()).sort().join(" "), owners);
  }
  const missing: string[] = [];
  let unreadable = false;
  for (const owners of ownerSets.values()) {
    let satisfied = owners.some((owner) => !owner.includes("/") && approvers.includes(owner.slice(1).toLowerCase()));
    let unknown = false;
    if (!satisfied) {
      // An email names a person Rovara cannot tell an approver from: the path is open, not unowned.
      if (owners.some((owner) => !owner.startsWith("@"))) unknown = true;
      for (const owner of owners.filter((candidate) => candidate.includes("/"))) {
        for (const login of approvers) {
          const answer = await inTeam(owner, login);
          if (answer === "member") { satisfied = true; break; }
          if (answer === "unknown") unknown = true;
        }
        if (satisfied) break;
      }
    }
    if (satisfied) continue;
    // A team that could not be read leaves it open whether an owner approved: that is "unreadable", unless a plain gap is also there to say.
    if (unknown) unreadable = true;
    else for (const owner of owners) if (!missing.includes(owner)) missing.push(owner);
  }
  if (missing.length > 0) return { ok: false, owners: `${missing.slice(0, NAMED).join(", ")}${missing.length > NAMED ? ` and ${missing.length - NAMED} more` : ""}` };
  if (unreadable) return { ok: false, unreadable: true };
  return { ok: true };
}
