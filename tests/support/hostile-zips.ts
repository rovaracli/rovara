// Generators and oracles for the function code judge's property tests (slice 4, lane W2). fast-check is not a dependency of this repository, so this is a small seeded generator in the same spirit: every case comes from one integer
// seed, a failure names the seed, and `FN_FUZZ_SEED` / `FN_FUZZ_CASES` replay or widen a run. Nothing here is shipped.
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join, posix, sep } from "node:path";
import { buildZip, linkEntry, type TestZipEntry, type ZipOptions } from "./zip-builder.js";

/** mulberry32: a small, fast, seedable generator. */
export class Rng {
  private state: number;
  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  range(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }
  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  bytes(length: number): Buffer {
    const out = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) out[index] = this.int(256);
    return out;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const other = this.int(index + 1);
      [copy[index], copy[other]] = [copy[other]!, copy[index]!];
    }
    return copy;
  }
}

export function fuzzCases(fallback: number): number {
  const value = Number(process.env.FN_FUZZ_CASES);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Runs `property` for each seed; a failure is rethrown with the seed so the case can be replayed with FN_FUZZ_SEED=<seed> FN_FUZZ_CASES=1. */
export async function forAllSeeds(cases: number, property: (rng: Rng, seed: number) => Promise<void> | void): Promise<void> {
  const base = process.env.FN_FUZZ_SEED === undefined ? 0 : Number(process.env.FN_FUZZ_SEED);
  for (let index = 0; index < cases; index += 1) {
    const seed = base + index;
    try {
      await property(new Rng(seed), seed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`property failed for seed ${String(seed)}: ${message}`, { cause: error });
    }
  }
}

// ---- hostile zips

const ESCAPE_TARGETS = ["..", "../x", "../../x", "/etc/passwd", "/", "a/../../x", "./../x", "sub/../..", "x/../../..", "C:/x", "a\\..\\..\\x", "..\\x", "~/x", "//x", "a/b/../../../x"];
const BAD_NAMES = ["../evil", "a/../../evil", "/etc/passwd", "C:/evil", "a\\..\\evil", "a//b", "./a", "a/./b", "a/b/..", "x\u0000y", "x\u202ey", "..", ".", "", "a/", "/", "//", "a/../b", "....//....//x", "\u2028x"];
const MODES = [0o020666, 0o060666, 0o010644, 0o140755, 0o104755, 0o102755, 0o106755, 0o044755, 0o120777, 0o100644, 0o100755, 0o040755, 0o100000, 0o177777, 0];
const FILLER: TestZipEntry[] = [{ name: "index.js", data: "exports.handler = async () => 1;\n" }, { name: "lib/", data: "", method: 0, mode: 0o040755 }, { name: "lib/util.py", data: "x = 1\n" }];

export interface Hostile {
  label: string;
  zip: Buffer;
  options: ZipOptions;
}

const mutate = (rng: Rng, zip: Buffer): Buffer => {
  let copy = Buffer.from(zip);
  for (let round = rng.range(1, 4); round > 0; round -= 1) {
    switch (rng.int(5)) {
      case 0: { const at = rng.int(copy.length); copy[at] = (copy[at] ?? 0) ^ (1 << rng.int(8)); break; }
      case 1: copy[rng.int(copy.length)] = rng.int(256); break;
      case 2: copy = copy.subarray(0, rng.int(copy.length + 1)); break;
      case 3: {
        const at = rng.int(copy.length);
        copy = Buffer.concat([copy.subarray(0, at), rng.bytes(rng.range(1, 8)), copy.subarray(at)]);
        break;
      }
      default: {
        const at = rng.int(copy.length);
        copy = Buffer.concat([copy.subarray(0, at), copy.subarray(Math.min(copy.length, at + rng.range(1, 8)))]);
      }
    }
    if (copy.length === 0) break;
  }
  return copy;
};

/** One hostile or damaged zip, from a seed. Some are valid by accident (a mutation that hit a comment, a benign nested zip): the properties hold for both outcomes. */
export function hostileZip(rng: Rng, valid: () => TestZipEntry[]): Hostile {
  const filler = (): TestZipEntry[] => rng.shuffle(rng.bool() ? FILLER : valid());
  const strategy = rng.int(26);
  const options: ZipOptions = {};
  let entries: TestZipEntry[] = filler();
  let label: string;
  const add = (...more: TestZipEntry[]): void => { entries = rng.shuffle([...entries, ...more]); };
  switch (strategy) {
    case 0: label = "traversal name"; add({ name: rng.pick(BAD_NAMES), data: "bad" }); break;
    case 1: label = "traversal in a deep name"; add({ name: `${"d/".repeat(rng.range(0, 5))}${"../".repeat(rng.range(1, 8))}evil`, data: "bad" }); break;
    case 2: label = "link escape"; add(linkEntry(rng.pick(["l", "d/l", "a/b/l"]), rng.pick(ESCAPE_TARGETS))); break;
    case 3: label = "link escape through another link"; add(linkEntry("a/b/d", "../.."), linkEntry(rng.pick(["x", "a/x"]), `${rng.pick(["a/b/d", "b/d", "d"])}/${"../".repeat(rng.range(1, 3))}z`)); break;
    case 4: label = "write through a link"; add(linkEntry("l", rng.pick([".", "..", "sub", "../x", "/tmp"])), { name: `l/${rng.pick(["x", "../y", "deep/z"])}`, data: "bad" }); break;
    case 5: label = "folder below a link"; add(linkEntry("l", "d"), { name: "l/", data: "", method: 0, mode: 0o040755 }, { name: "l/f", data: "bad" }); break;
    case 6: label = "link loop"; add(linkEntry("a", "b"), linkEntry("b", rng.pick(["a", "c"])), linkEntry("c", "a")); break;
    case 7: label = "duplicate names"; { const name = rng.pick(["dup", "d/dup", "Dup"]); add({ name, data: "1" }, { name, data: "2" }); } break;
    case 8: label = "file and folder with one name"; add({ name: "n", data: "1" }, { name: "n/m", data: "2" }); break;
    case 9: label = "overlapping entries"; { const base = entries.length; entries = [...entries, { name: "o1", data: "overlap-data" }, { name: "o2", data: "overlap-data", shareLocalWith: base }]; } break;
    case 10: label = "huge declared sizes"; add({ name: "h1", data: "x", declaredUncompressed: rng.pick([0xfffffffe, 0x7fffffff, 1 << 30, 300 * 1024 * 1024, 0xffffffff]) }, { name: "h2", data: "x", declaredUncompressed: rng.pick([0xfffffffe, 1 << 29, 1]) }); break;
    case 11: label = "nested zip"; add({ name: rng.pick(["inner.zip", "d/inner.zip"]), data: buildZip([{ name: "../../escape", data: "x" }, linkEntry("l", "/etc/passwd")]), method: rng.pick([0, 8] as const) }); break;
    case 12: label = "CRC lie"; add({ name: "c", data: "hello", declaredCrc: rng.int(0x100000000) }); break;
    case 13: label = "deep directories"; add({ name: `${Array.from({ length: rng.range(20, 100) }, (_, i) => `d${String(i)}`).join("/")}/f`, data: "deep" }); break;
    case 14: label = "bad modes"; add({ name: "m", data: "x", mode: rng.pick(MODES) }, { name: "m2/", data: "", method: 0, mode: rng.pick(MODES) }); break;
    case 15: label = "end record lies"; options.eocd = rng.pick([{ total: entries.length + 1, entriesOnDisk: entries.length + 1 }, { total: 0, entriesOnDisk: 0 }, { centralOffset: rng.int(300) }, { centralSize: rng.int(300) }, { disk: 1 }, { commentLength: rng.int(50) }, { total: 0xffff, entriesOnDisk: 0xffff }, { entriesOnDisk: entries.length + 1 }]); break;
    case 16: label = "header flag and method lies"; add({ name: "f", data: "x", flags: rng.pick([1, 0x40, 0x2000, 0x8, 0x800, 0xffff]), method: rng.pick([0, 8, 9, 12, 99] as never[]), ...(rng.bool() ? { rawCompressed: rng.bytes(rng.range(0, 10)) } : {}) }); break;
    case 17: label = "name lies"; add({ name: "visible", data: "x", localName: rng.pick(["other", "../up", "v", ""]) }); break;
    case 18: label = "trailing and truncated"; options.trailing = rng.bytes(rng.range(1, 30)); break;
    case 19: label = "inflation bomb"; add({ name: "bomb", data: Buffer.alloc(rng.range(100_000, 600_000), 0), declaredUncompressed: rng.pick([1, 10, 100, 1000]) }); break;
    case 20: label = "random end record"; { const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(rng.int(5), 8); end.writeUInt16LE(rng.int(5), 10); end.writeUInt32LE(rng.int(100), 12); end.writeUInt32LE(rng.int(100), 16); return { label, zip: Buffer.concat([rng.bytes(rng.range(0, 120)), end]), options }; }
    case 21: label = "mutated valid zip"; return { label, zip: mutate(rng, buildZip(rng.bool() ? FILLER : valid())), options };
    case 22: label = "mutated zip with links"; return { label, zip: mutate(rng, buildZip([...valid(), linkEntry("lnk", "index.js"), linkEntry("up", "..")])), options };
    case 23: label = "zip64 locator"; options.zip64Locator = true; break;
    case 24: label = "link target odds"; add(linkEntry("l", rng.pick(["", " ", "a\u202eb", "a\u0000b", "x".repeat(rng.range(1000, 1100)), "\u00e9/\u00e9", "a b"]), rng.bool() ? { declaredUncompressed: rng.int(3) } : {})); break;
    default: label = "random garbage"; return { label, zip: rng.bytes(rng.range(0, 400)), options };
  }
  return { label, zip: buildZip(entries, options), options };
}

// ---- valid trees (a model to compare an unpack against)

export type ModelNode = { kind: "dir" } | { kind: "file"; content: Buffer; exec: boolean } | { kind: "symlink"; target: string };

export interface TreeModel {
  entries: TestZipEntry[];
  nodes: Map<string, ModelNode>;
}

const NAMES = ["a", "b", "c", "d", "lib", "bin", "x.py", "mod.so"];

/** A valid tree of files, folders and relative links that stay inside, as zip entries and as the model of what an unpack must produce. Names repeat across calls so layers collide. */
export function validTree(rng: Rng, size = rng.range(1, 14)): TreeModel {
  const nodes = new Map<string, ModelNode>();
  const entries: TestZipEntry[] = [];
  const dirs = new Set<string>([""]);
  const order: string[] = [];
  const ensureDir = (path: string): void => {
    if (path === "" || dirs.has(path)) return;
    ensureDir(posix.dirname(path) === "." ? "" : posix.dirname(path));
    dirs.add(path);
    nodes.set(path, { kind: "dir" });
    order.push(path);
  };
  const free = (path: string): boolean => !nodes.has(path) && !isBelowLeaf(path);
  const isBelowLeaf = (path: string): boolean => {
    for (let parent = posix.dirname(path); parent !== "."; parent = posix.dirname(parent)) {
      const node = nodes.get(parent);
      if (node !== undefined && node.kind !== "dir") return true;
    }
    return false;
  };
  const placeIn = (): string => {
    const all = [...dirs];
    const dir = rng.pick(all);
    const name = rng.pick(NAMES);
    return dir === "" ? name : `${dir}/${name}`;
  };
  for (let index = 0; index < size; index += 1) {
    const kind = rng.int(10);
    const path = placeIn();
    if (!free(path) || path.split("/").length > 4) continue;
    const parent = posix.dirname(path) === "." ? "" : posix.dirname(path);
    if (kind < 3) {
      ensureDir(path);
    } else if (kind < 8) {
      ensureDir(parent);
      const content = rng.bool(0.15) ? Buffer.alloc(rng.range(70_000, 90_000), rng.int(256)) : rng.bool() ? rng.bytes(rng.range(0, 200)) : Buffer.from(`text ${String(rng.int(1000))}\n`.repeat(rng.range(0, 20)));
      nodes.set(path, { kind: "file", content, exec: rng.bool(0.3) });
      order.push(path);
    } else {
      // A link to something earlier (or to a name that is not there), as a relative path from the link's folder.
      ensureDir(parent);
      const existing = [...nodes.keys()];
      const goal = existing.length > 0 && rng.bool(0.8) ? rng.pick(existing) : rng.pick(["gone", "nothing/here", "x.missing"]);
      const relative = posix.relative(parent, goal);
      const target = relative === "" ? "." : relative;
      if (path === goal) continue;
      nodes.set(path, { kind: "symlink", target });
      order.push(path);
    }
  }
  for (const path of order) {
    const node = nodes.get(path)!;
    if (node.kind === "dir") entries.push({ name: `${path}/`, data: "", method: 0, mode: 0o040755 });
    else if (node.kind === "file") entries.push({ name: path, data: node.content, method: rng.pick([0, 8] as const), mode: node.exec ? 0o100755 : 0o100644 });
    else entries.push(linkEntry(path, node.target, { method: rng.pick([0, 8] as const) }));
  }
  // Folders the entries only imply must be in the model too (ensureDir already added every parent).
  return { entries: rng.shuffle(entries), nodes };
}

/** Later layer onto earlier, the way the unpacker does it: files and folders first, links last; a node replaces what is there and whatever lay below it; a leaf or link in the way of a path becomes a folder. */
export function applyLayer(into: Map<string, ModelNode>, layer: Map<string, ModelNode>): void {
  const removeBelow = (path: string): void => { for (const key of [...into.keys()]) if (key.startsWith(`${path}/`)) into.delete(key); };
  const makeDir = (path: string): void => {
    if (path === "") return;
    makeDir(posix.dirname(path) === "." ? "" : posix.dirname(path));
    const node = into.get(path);
    if (node === undefined || node.kind !== "dir") { removeBelow(path); into.set(path, { kind: "dir" }); }
  };
  const paths = [...layer.keys()].sort();
  for (const wantLinks of [false, true]) {
    for (const path of paths) {
      const node = layer.get(path)!;
      if ((node.kind === "symlink") !== wantLinks) continue;
      makeDir(posix.dirname(path) === "." ? "" : posix.dirname(path));
      if (node.kind === "dir") {
        const here = into.get(path);
        if (here === undefined || here.kind !== "dir") { removeBelow(path); into.set(path, node); }
      } else {
        removeBelow(path);
        into.set(path, node);
      }
    }
  }
}

// ---- oracles over a real folder

/** Every node of a folder, by relative path, never following a link. */
export function readTree(root: string): Map<string, ModelNode & { mode: number }> {
  const out = new Map<string, ModelNode & { mode: number }>();
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const info = lstatSync(abs);
      if (info.isSymbolicLink()) out.set(rel, { kind: "symlink", target: readlinkSync(abs), mode: info.mode });
      else if (info.isDirectory()) { out.set(rel, { kind: "dir", mode: info.mode }); walk(abs, rel); }
      else if (info.isFile()) out.set(rel, { kind: "file", content: readFileSync(abs), exec: (info.mode & 0o100) !== 0, mode: info.mode });
      else throw new Error(`unexpected node type at ${rel}`);
    }
  };
  walk(root, "");
  return out;
}

/** Where a link ends, found on the real disk with lstat and readlink only: "inside", "escape" (a `..` past the root) or "loop". A missing component is followed by its words. */
export function resolveOnDisk(root: string, linkRel: string): "inside" | "escape" | "loop" {
  const stack = linkRel.split("/").slice(0, -1);
  let pending = readlinkSync(join(root, ...linkRel.split("/"))).split("/");
  let hops = 0;
  while (pending.length > 0) {
    const segment = pending.shift()!;
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return "escape";
      stack.pop();
      continue;
    }
    stack.push(segment);
    let info;
    try {
      info = lstatSync(join(root, ...stack));
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) {
      hops += 1;
      if (hops > 40) return "loop";
      const here = join(root, ...stack);
      stack.pop();
      pending = [...readlinkSync(here).split("/"), ...pending];
    }
  }
  return "inside";
}

/** The ground truth for an accepted tree: only files, folders and links; fixed modes; no absolute link; and every link ends inside (the operating system's own realpath where the target exists, `resolveOnDisk` where it does not). */
export function assertSafeTree(root: string): number {
  const real = realpathSync(root);
  let count = 0;
  for (const [rel, node] of readTree(root)) {
    count += 1;
    if (node.kind === "file" && ((node.mode & 0o7777) !== 0o644 && (node.mode & 0o7777) !== 0o755)) throw new Error(`file mode ${(node.mode & 0o7777).toString(8)} at ${rel}`);
    if (node.kind === "dir" && (node.mode & 0o7777) !== 0o755) throw new Error(`folder mode at ${rel}`);
    if (node.kind !== "symlink") continue;
    if (node.target.startsWith("/") || node.target.includes("\\") || node.target === "") throw new Error(`absolute or odd link at ${rel}`);
    if (resolveOnDisk(root, rel) !== "inside") throw new Error(`link escapes at ${rel}`);
    try {
      const where = realpathSync(join(root, ...rel.split("/")));
      if (where !== real && !where.startsWith(real + sep)) throw new Error(`realpath of link ${rel} is outside`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
  }
  return count;
}
