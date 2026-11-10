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

export function gitFactsReader(dirs: Record<string, string>, run: (directory: string, args: string[]) => string = (directory, args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", maxBuffer: MAX_BYTES + 1, stdio: ["ignore", "pipe", "ignore"] })): CodeFactsReader {
  const directoryOf = (repo: string): string | undefined => (Object.hasOwn(dirs, repo) ? dirs[repo] : undefined);
  return {
    async file(input) {
      const directory = directoryOf(input.repo);
      if (directory === undefined) return undefined;
      try { return run(directory, ["cat-file", "blob", `${input.commit}:${input.path}`]); } catch { return undefined; }
    },
    async kind(input) {
      const directory = directoryOf(input.repo);
      if (directory === undefined) return undefined;
      try { const type = run(directory, ["cat-file", "-t", `${input.commit}:${input.path}`]).trim(); return type === "blob" ? "file" : type === "tree" ? "dir" : undefined; } catch { return "none"; }
    },
  };
}

export function gitCode(dirs: Record<string, string>, repositories: readonly string[]): { verifier: CitationVerifier; facts: CodeFacts } {
  const reader = gitFactsReader(dirs);
  const repositoriesOf = async (): Promise<readonly string[]> => repositories;
  return { verifier: createCitationVerifier({ reader, repositoriesOf }), facts: createCodeFacts({ reader, repositoriesOf }) };
}
