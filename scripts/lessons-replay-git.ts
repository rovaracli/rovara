// Lessons replay (lane 7): the citation check and code facts for the OFFLINE pipeline, over the operator's own clones of the project's repositories, read at the cited commit (`git cat-file`, never a working tree). They are
// the broker's real ones (`createCitationVerifier`, `createCodeFacts`) over a reader that answers from git instead of the code host, so a citation is judged by the same anchor rule the live pipeline uses. Read-only; a repository
// that is not in the map, a commit the clone does not have, or a file over 1 MB answers "not verified", exactly as the live reader does.
import { execFileSync } from "node:child_process";
import type { CodeFactsReader } from "../packages/broker/src/lessons/code-facts.js";
import { createCodeFacts } from "../packages/broker/src/lessons/code-facts.js";
import { createCitationVerifier } from "../packages/broker/src/lessons/citation-verifier.js";
import type { CitationVerifier, CodeFacts } from "../packages/broker/src/lessons/ports.js";

const MAX_BYTES = 1024 * 1024;

/** `api=/path/to/api,web=/path/to/web` to a map; anything else is refused. */
export function parseRepoDirs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(",").map((p) => p.trim()).filter((p) => p !== "")) {
    const at = part.indexOf("=");
    if (at <= 0 || at === part.length - 1) throw new Error(`LESSONS_REPLAY_REPO_DIRS: "${part}" is not name=directory`);
    out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

/** What `git` answers for one call in a clone: the text, or a throw. */
export type GitRun = (directory: string, args: string[]) => string;
const realGit: GitRun = (directory, args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", maxBuffer: MAX_BYTES + 1, stdio: ["ignore", "pipe", "ignore"] });

/**
 * Answers "there is no such file" (undefined / "none", which the live verifier reads as STALE) ONLY when the clone HAS the cited commit and that commit's tree has no such path. Anything else the clone cannot tell (the commit is not in
 * the clone, a file over 1 MB, any git error) THROWS, which the verifier and the code facts read as "not verified": the lesson then stays under the live rule for an unverified citation (it does not go live on trial), and is never
 * marked stale for a fault of the clone.
 */
export function gitFactsReader(dirs: Record<string, string>, run: GitRun = realGit): CodeFactsReader {
  const directoryOf = (repo: string): string | undefined => (Object.hasOwn(dirs, repo) ? dirs[repo] : undefined);
  /** The tree entry of the path at the commit: undefined when the commit is there and the path is not in its tree. Throws when the commit is not in the clone or git fails. */
  const entryOf = (directory: string, commit: string, path: string): { type: string } | undefined => {
    run(directory, ["cat-file", "-e", `${commit}^{commit}`]);
    const listed = run(directory, ["ls-tree", commit, "--", path]).trim();
    if (listed === "") return undefined;
    const match = /^[0-7]+ (\w+) [0-9a-f]+\t/u.exec(listed);
    if (match === null) throw new Error("git listed the path in a form this reader does not know");
    return { type: match[1]! };
  };
  return {
    async file(input) {
      const directory = directoryOf(input.repo);
      if (directory === undefined) return undefined;
      const entry = entryOf(directory, input.commit, input.path);
      if (entry === undefined || entry.type !== "blob") return undefined;
      if (Number(run(directory, ["cat-file", "-s", `${input.commit}:${input.path}`]).trim()) > MAX_BYTES) throw new Error("the file is over 1 MB, which this reader does not read");
      return run(directory, ["cat-file", "blob", `${input.commit}:${input.path}`]);
    },
    async kind(input) {
      const directory = directoryOf(input.repo);
      if (directory === undefined) return undefined;
      const entry = entryOf(directory, input.commit, input.path);
      return entry === undefined ? "none" : entry.type === "blob" ? "file" : entry.type === "tree" ? "dir" : undefined;
    },
  };
}

export function gitCode(dirs: Record<string, string>, repositories: readonly string[], run?: GitRun): { verifier: CitationVerifier; facts: CodeFacts } {
  const reader = gitFactsReader(dirs, run);
  const repositoriesOf = async (): Promise<readonly string[]> => repositories;
  return { verifier: createCitationVerifier({ reader, repositoriesOf }), facts: createCodeFacts({ reader, repositoriesOf }) };
}
