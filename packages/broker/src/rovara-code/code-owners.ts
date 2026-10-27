// Rovara Code (owner decision 2026-10-27): where the repository has a CODEOWNERS file that covers the paths a pull request changes, a code owner has to approve it before Rovara calls it
// ready. This reads the file the way GitHub does (the last matching rule wins; a rule with no owner takes ownership away) and says who is still missing. Pure except for the team lookup the
// caller passes in. It never trusts what it cannot read: an unreadable team is "unknown", and a path whose only owners are unknown teams is not satisfied.

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

/** The rules of a CODEOWNERS file, in order. Comments and blank lines are skipped; emails and malformed names are not owners. */
export function parseCodeOwners(text: string): CodeOwnerRule[] {
  const rules: CodeOwnerRule[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/(^|\s)#.*$/u, "").trim();
    if (line === "") continue;
    const [pattern, ...rest] = line.split(/\s+/u);
    if (pattern === undefined || pattern === "" || pattern.startsWith("!") || pattern.includes("[")) continue;
    rules.push({ pattern, owners: rest.filter((owner) => OWNER.test(owner)), matches: compile(pattern) });
    if (rules.length >= RULES_MAX) break;
  }
  return rules;
}

/** The owners of one path: those of the last rule that matches it (none when that rule names none). */
export function ownersOfPath(rules: readonly CodeOwnerRule[], path: string): string[] {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/u, "");
  for (let index = rules.length - 1; index >= 0; index -= 1) if (rules[index]!.matches(normalized)) return rules[index]!.owners;
  return [];
}

export interface CodeOwnerInput {
  /** The file as the base branch holds it; undefined when it has none. */
  codeOwnersText: string | undefined;
  /** Every path the pull request changes (a renamed file under both names). */
  paths: readonly string[];
  /** The GitHub logins of the counted approvers. */
  approverLogins: readonly string[];
  teamMember(team: string, login: string): Promise<"member" | "not_member" | "unknown">;
}

const NAMED = 3;

/** Whether every changed path that has a code owner has an approval from one of its owners. */
export async function codeOwnerVerdict(input: CodeOwnerInput): Promise<CodeOwnerVerdict> {
  if (input.codeOwnersText === undefined) return { ok: true };
  const rules = parseCodeOwners(input.codeOwnersText);
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
    const owners = ownersOfPath(rules, path);
    if (owners.length > 0) ownerSets.set(owners.map((owner) => owner.toLowerCase()).sort().join(" "), owners);
  }
  const missing: string[] = [];
  let unreadable = false;
  for (const owners of ownerSets.values()) {
    let satisfied = owners.some((owner) => !owner.includes("/") && approvers.includes(owner.slice(1).toLowerCase()));
    let unknown = false;
    if (!satisfied) {
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
