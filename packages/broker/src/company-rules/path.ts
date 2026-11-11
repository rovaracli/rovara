// Company rules (G-04): what Rovara may write to a company's repository for them. Pure and import-free so the GitHub adapter (`github-commit-files.ts`) and the sync share ONE definition.
// Rovara writes only a working branch of its own, `rovara/company-rules-<12 hex>` (never the default branch or any other name), and only the one Markdown file the company connected. The adapter allows a company-rules branch to
// carry only a path this file accepts, and a lessons branch only the lessons paths: neither list opens the other.
export const COMPANY_RULES_BRANCH_PREFIX = "rovara/company-rules-";
export const COMPANY_RULES_BRANCH_PATTERN = /^rovara\/company-rules-[0-9a-f]{12}$/u;

/** The hidden directories a connected file may live in: only Rovara's own. Any other directory that starts with a dot (`.github`, `.git`, `.vscode`, ...) is refused. */
const ALLOWED_DOT_DIRECTORIES: ReadonlySet<string> = new Set([".rovara"]);

/**
 * File names Rovara never writes company rules to, in any folder: the agent instruction files (a rules file written over one would change what every agent reads in that repository), Rovara's own lessons file, and the files a
 * team keeps for people. A company that wants its rules next to these names a different file.
 */
const RESERVED_FILE_NAMES: ReadonlySet<string> = new Set(["agents.md", "claude.md", "gemini.md", "copilot-instructions.md", "lessons.md", "readme.md", "contributing.md", "security.md", "code_of_conduct.md", "changelog.md", "license.md"]);

export type PathProblem = "empty" | "too_long" | "not_markdown" | "bad_characters" | "bad_segment" | "hidden_directory" | "reserved_name" | "steering_folder";

/**
 * Why a path cannot be the company rules file, or undefined. A plain repository path to a Markdown file: letters, digits, dot, dash, underscore and slash, at most 200 characters, no empty, dot or dot-dot segment, no leading
 * slash, no hidden directory but `.rovara`, and a file name that ends in `.md` and does not start with a dot.
 */
export function companyRulesPathProblem(path: string): PathProblem | undefined {
  if (path.length === 0) return "empty";
  if (path.length > 200) return "too_long";
  if (!/^[A-Za-z0-9._/-]+$/u.test(path)) return "bad_characters";
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return "bad_segment";
  if (segments.slice(0, -1).some((segment) => segment.startsWith(".") && !ALLOWED_DOT_DIRECTORIES.has(segment))) return "hidden_directory";
  // Rovara's own folder holds the file directly (`.rovara/x.md`): its subfolders (`.rovara/rules/`, read by tasks as repository steering) are not for it, and neither is a runbooks folder anywhere.
  if ((segments[0] === ".rovara" && segments.length > 2) || segments.slice(0, -1).some((segment) => /^runbooks?$/iu.test(segment))) return "steering_folder";
  const file = segments[segments.length - 1] ?? "";
  if (file.startsWith(".") || !/\.md$/iu.test(file)) return "not_markdown";
  if (RESERVED_FILE_NAMES.has(file.toLowerCase())) return "reserved_name";
  return undefined;
}

export const PATH_PROBLEM_WORDS: Record<PathProblem, string> = {
  empty: "Name the file in the repository.",
  too_long: "The file path is too long (200 characters at most).",
  not_markdown: "The company rules file must be a Markdown file (its name ends in .md).",
  bad_characters: "The file path may use letters, digits, dots, dashes, underscores and slashes only.",
  bad_segment: "The file path must be a plain path inside the repository.",
  hidden_directory: "The file cannot be in a hidden folder other than .rovara.",
  steering_folder: "Choose a file directly in .rovara (for example .rovara/company-rules.md) or in an ordinary folder: a file under .rovara/rules or a runbooks folder is read by tasks as repository guidance.",
  reserved_name: "That file name is kept for something else (agent instructions, the lessons file or a project's readme). Choose another file, for example .rovara/company-rules.md.",
};
