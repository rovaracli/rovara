// Plan 3 Task 14b: an in-memory repository for the comment-trigger scan. `treeReader` answers `AgentRepositoryReader` from a map of path -> text, the
// way the GitHub App's reader does (blob shas are real git blob shas, a directory lists its direct children), and records every read so a test
// can say what was asked, and how often.
import { createHash } from "node:crypto";
import type { AgentRepositoryEntry, AgentRepositoryReader } from "../../packages/broker/src/github-app.js";

export const blobSha = (text: string): string => createHash("sha1").update(`blob ${String(Buffer.byteLength(text))}\0`).update(text).digest("hex");

export interface TreeReaderOptions {
  /** Paths whose read (not listing) throws. */
  failing?: readonly string[];
  /** Directories whose listing throws. */
  failingDirectories?: readonly string[];
  /** Directories whose listing says it may be cut short. */
  truncated?: readonly string[];
  /** Entries to list as something other than a plain file, by path. */
  types?: Readonly<Record<string, AgentRepositoryEntry["type"]>>;
  /** Sizes to claim in a listing, by path, in place of the text's own. */
  sizes?: Readonly<Record<string, number>>;
}

export interface TreeReader extends AgentRepositoryReader {
  readonly reads: string[];
  readonly lists: string[];
}

export function treeReader(files: Readonly<Record<string, string>>, options: TreeReaderOptions = {}): TreeReader {
  const reads: string[] = [];
  const lists: string[] = [];
  const children = (directory: string): AgentRepositoryEntry[] | undefined => {
    const prefix = `${directory}/`;
    const entries = new Map<string, AgentRepositoryEntry>();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const name = rest.split("/")[0]!;
      const child = `${directory}/${name}`;
      if (rest.includes("/")) entries.set(name, { name, path: child, type: "dir", sha: blobSha(child), size: 0 });
      else entries.set(name, { name, path, type: options.types?.[path] ?? "file", sha: blobSha(files[path]!), size: options.sizes?.[path] ?? Buffer.byteLength(files[path]!) });
    }
    return entries.size === 0 ? undefined : [...entries.values()];
  };
  return {
    defaultBranch: "main",
    commit: "c".repeat(40),
    reads,
    lists,
    async list(path) {
      lists.push(path);
      if (options.failingDirectories?.includes(path) === true) throw new Error("GitHub is down");
      const entries = children(path);
      return entries === undefined ? undefined : { entries, truncated: options.truncated?.includes(path) === true };
    },
    async read(path, maxBytes) {
      reads.push(path);
      if (options.failing?.includes(path) === true) throw new Error("GitHub is down");
      const text = files[path];
      if (text === undefined) return undefined;
      const size = options.sizes?.[path] ?? Buffer.byteLength(text);
      return size > maxBytes ? { sha: blobSha(text), size, tooLarge: true } : { sha: blobSha(text), size, text };
    },
  };
}

/** A workflow file with the given `on` block (YAML text) and one step that runs `run`. */
export const workflow = (on: string, run = "echo hello"): string => `name: w\non:${on.startsWith("\n") ? on : ` ${on}`}\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n`;
