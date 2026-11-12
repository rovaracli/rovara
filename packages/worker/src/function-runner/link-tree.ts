// A model of a package tree, for ONE purpose: deciding where every symbolic link really ends (slice 4, lane W2). The judge builds one from a zip's own plan, the store builds one from
// the merged plans of a function's layers BEFORE anything is written (layers overlay each other, so a link can resolve differently once an earlier layer's folder or link is in
// place), and after every overlay the store builds one from the REAL folder (lstat and readlink only; never the operating system's own path resolution, never Node's `realpathSync`).
//
// Resolving works on physical paths the way the kernel does: the walk starts in the folder the link sits in, and each segment of the target is applied in turn; a segment that names
// another link is replaced by that link's own resolved place (and its target is followed to the end, a link at the last segment too); `..` pops one physical folder, and a `..` at the
// package root is an escape. A segment the tree does not hold is followed by its words (a dangling link inside the package is allowed). A path that goes through a file is no path.
// Memoised per link, with a chain-depth limit (loops end in a refusal), a limit on how deep a resolved path may be, and one budget of steps for the whole tree, so a hostile package
// cannot make the check cost more than a fixed amount of CPU. Every refusal is `FunctionCodeError("unsafe_link")`.
import { readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { FUNCTION_CODE_LIMITS, FunctionCodeError } from "./code-errors.js";

export type LinkNodeKind = "dir" | "file" | "symlink";

export interface LinkNode {
  kind: LinkNodeKind;
  /** For a link: its target text, already judged to be a relative path. */
  target?: string;
}

/** Entries the judge hands over: a package-relative path, a kind, and a link's target. */
export interface LinkPlanEntry {
  path: string;
  kind: LinkNodeKind;
  target?: string | undefined;
}

/** The deepest resolved path (in folders). Deeper than any entry the judge accepts, so only a hostile or dangling target can reach it. */
const MAX_RESOLVED_DEPTH = FUNCTION_CODE_LIMITS.maxDepth * 2;
/** Steps (one per target segment, plus the length of the path being copied) for one `checkLinks`. A real layer needs a few thousand; this is about a tenth of a second of work. */
const STEP_BUDGET = 5_000_000;
/** Most nodes read from a real folder: six zips of the entry cap. */
const MAX_DISK_NODES = FUNCTION_CODE_LIMITS.maxEntries * (FUNCTION_CODE_LIMITS.maxLayers + 1);

const parentOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const nameOf = (path: string): string => (path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path);
const childPath = (parent: string, name: string): string => (parent === "" ? name : `${parent}/${name}`);

export class LinkTree {
  private readonly nodes = new Map<string, LinkNode>();
  private readonly kids = new Map<string, Set<string>>();

  get size(): number {
    return this.nodes.size;
  }

  get(path: string): LinkNode | undefined {
    return this.nodes.get(path);
  }

  private attach(path: string, node: LinkNode): void {
    const parent = parentOf(path);
    let set = this.kids.get(parent);
    if (set === undefined) { set = new Set(); this.kids.set(parent, set); }
    set.add(nameOf(path));
    this.nodes.set(path, node);
  }

  private removeBelow(path: string): void {
    const names = this.kids.get(path);
    if (names === undefined) return;
    for (const name of names) {
      const below = childPath(path, name);
      this.removeBelow(below);
      this.nodes.delete(below);
    }
    this.kids.delete(path);
  }

  /** Makes `path` (and every folder above it) a folder, the way an overlay does: a file or link in the way is replaced by a folder, and what lay below it goes. */
  private ensureDir(path: string): void {
    if (path === "") return;
    this.ensureDir(parentOf(path));
    const here = this.nodes.get(path);
    if (here === undefined) this.attach(path, { kind: "dir" });
    else if (here.kind !== "dir") { this.removeBelow(path); this.nodes.set(path, { kind: "dir" }); }
  }

  /** Puts one entry in place the way the unpacker does: parents become real folders, a folder keeps a folder, anything else replaces what is there with everything below it. */
  put(entry: LinkPlanEntry): void {
    this.ensureDir(parentOf(entry.path));
    const here = this.nodes.get(entry.path);
    if (entry.kind === "dir" && here?.kind === "dir") return;
    this.removeBelow(entry.path);
    const node: LinkNode = entry.kind === "symlink" ? { kind: "symlink", target: entry.target ?? "" } : { kind: entry.kind };
    if (here === undefined) this.attach(entry.path, node);
    else this.nodes.set(entry.path, node);
  }

  /** One zip laid over the tree: files and folders first in archive order, links last (the unpacker's order). */
  applyPlan(entries: readonly LinkPlanEntry[]): void {
    for (const entry of entries) if (entry.kind !== "symlink") this.put(entry);
    for (const entry of entries) if (entry.kind === "symlink") this.put(entry);
  }

  static fromPlan(entries: readonly LinkPlanEntry[]): LinkTree {
    const tree = new LinkTree();
    tree.applyPlan(entries);
    return tree;
  }

  /** Reads a REAL folder with readdir and readlink only (no path resolution by the operating system: only real folders are entered, never a link). */
  static async fromDisk(root: string): Promise<LinkTree> {
    const tree = new LinkTree();
    const pending: string[] = [""];
    try {
      while (pending.length > 0) {
        const rel = pending.pop()!;
        for (const entry of await readdir(rel === "" ? root : join(root, ...rel.split("/")), { withFileTypes: true })) {
          const path = childPath(rel, entry.name);
          if (tree.nodes.size >= MAX_DISK_NODES) throw new FunctionCodeError("too_many_entries");
          if (entry.isSymbolicLink()) tree.attach(path, { kind: "symlink", target: await readlink(join(root, ...path.split("/"))) });
          else if (entry.isDirectory()) { tree.attach(path, { kind: "dir" }); pending.push(path); }
          else if (entry.isFile()) tree.attach(path, { kind: "file" });
          else throw new FunctionCodeError("unsafe_entry");
        }
      }
    } catch (error) {
      if (error instanceof FunctionCodeError) throw error;
      throw new FunctionCodeError("write_failed");
    }
    return tree;
  }

  /**
   * Throws `unsafe_link` unless every link in the tree ends inside it. A path that goes THROUGH A FILE can never reach anything (the kernel answers ENOTDIR): `strict` (one zip, as it
   * arrives) refuses it as nonsense; lenient (layers laid over each other, where a later layer may turn a folder an earlier link used into a file) leaves that link dead and harmless.
   */
  checkLinks(options: { strict?: boolean } = {}): void {
    const strict = options.strict ?? true;
    const memo = new Map<string, string[] | null>();
    const active = new Set<string>();
    let budget = STEP_BUDGET;
    const spend = (units: number): void => {
      budget -= units;
      if (budget < 0) throw new FunctionCodeError("unsafe_link");
    };
    const dead = (link: string): null => {
      active.delete(link);
      memo.set(link, null);
      return null;
    };
    const resolve = (link: string, depth: number): string[] | null => {
      const known = memo.get(link);
      if (known !== undefined) return known;
      if (depth > FUNCTION_CODE_LIMITS.maxLinkHops || active.has(link)) throw new FunctionCodeError("unsafe_link");
      active.add(link);
      const segments = this.nodes.get(link)!.target!.split("/");
      let last = -1;
      for (let index = 0; index < segments.length; index += 1) if (segments[index] !== "" && segments[index] !== ".") last = index;
      let stack = link.split("/").slice(0, -1);
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]!;
        spend(1 + stack.length);
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
          if (stack.length === 0) throw new FunctionCodeError("unsafe_link");
          stack.pop();
          continue;
        }
        stack.push(segment);
        if (stack.length > MAX_RESOLVED_DEPTH) throw new FunctionCodeError("unsafe_link");
        const here = this.nodes.get(stack.join("/"));
        if (here?.kind === "symlink") {
          const next = resolve(stack.join("/"), depth + 1);
          if (next === null) return dead(link);
          stack = next.slice();
        } else if (here?.kind === "file" && index < last) {
          if (strict) throw new FunctionCodeError("unsafe_link");
          return dead(link);
        }
      }
      active.delete(link);
      memo.set(link, stack);
      return stack;
    };
    for (const [path, node] of this.nodes) if (node.kind === "symlink") resolve(path, 0);
  }
}
