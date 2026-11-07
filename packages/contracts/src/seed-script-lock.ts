// Test services, SEED-RISK-1 (owner decision 2026-11-07, "Yes, after security review"): the LOCK of a seed command that runs the repository's own seed script, unchanged. One resolver, here, used by BOTH sides:
// the broker resolves the command against the repository at the commit it reads from the code host (never the worker's or the model's word), and the worker resolves it again from its checkout right before the
// command runs; the run is refused when the two hashes differ. Browser-safe: nothing here imports a Node module.
//
// WHAT IS HASHED (version 1). Every path is relative to the command's own directory (`cwd`); the hash is the sha256 of one canonical JSON text holding the version, the command (directory, program and words) and
// every input below as [label, text] pairs in label order. Nothing else is read, and anything this resolver does not understand is a refusal (the seed stays HIGH), never a guess:
//   - `npm run <s>`, `pnpm run <s>`, `yarn run <s>`, `pnpm <s>`, `yarn <s>`: the script's body as package.json holds it (label `package.json#scripts.<s>`; the rest of package.json is not in the hash). A `pre<s>` or
//     `post<s>` script refuses (npm and yarn run them too). The body must then be one of the two shapes below.
//   - a body that runs one file with node, tsx, ts-node or bun (`node prisma/seed.js extra args`, no option before the file): that file's whole text (label: its path). A file that loads another repository file by a
//     relative `require`/`import` refuses: only what is hashed may run.
//   - a body, or the command itself (`npx prisma db seed`, `npx knex seed:run`, `npx sequelize-cli db:seed:all`), that is a database tool's own seed:
//       prisma     package.json's `prisma.seed` (label `package.json#prisma.seed`), which must run one file as above, and that file. A `prisma.config.*` file refuses (it can move the seed elsewhere).
//       knex       the one knexfile (`knexfile.{js,ts,cjs,mjs}`; none or several refuses, one that mentions `seeds` refuses: its seed folder is not the default) and every file under `seeds/`.
//       sequelize  `config/config.json` and `config/config.js` where present, and every file under `seeders/`. A `.sequelizerc` refuses (it can move the folders).
//   - a command with its own variables (`env`) refuses: a variable such as NODE_OPTIONS changes what runs without changing any file.
// Bounds: at most 32 files, 256 KiB each, 1 MiB in all; a listing that cannot be complete refuses.
import { z } from "zod";
import type { ProjectCommandSchema } from "./project.js";
import { sha256Hex } from "./web-hash.js";

type ProjectCommand = z.infer<typeof ProjectCommandSchema>;

export const SEED_LOCK_VERSION = 1 as const;
export const SEED_LOCK_LIMITS = { files: 32, fileBytes: 262_144, totalBytes: 1_048_576 } as const;

/** A path relative to the command's directory: plain characters, no empty, `.` or `..` segment, never absolute. */
const LockPathSchema = z.string().min(1).max(300).regex(/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/u).refine((path) => !path.split("/").some((part) => part === "." || part === ".."), "a plain relative path");

/** The lock a broker puts on a seed command it resolved itself: the hash of what the command runs, and the files it read (shown on the card). */
export const SeedScriptLockSchema = z.object({ version: z.literal(SEED_LOCK_VERSION), hash: z.string().regex(/^[a-f0-9]{64}$/u), from: z.array(LockPathSchema).min(1).max(SEED_LOCK_LIMITS.files) }).strict();
export type SeedScriptLock = z.infer<typeof SeedScriptLockSchema>;

/**
 * What the resolver reads, rooted at the command's directory. `read`: a regular file's text, undefined when there is no regular file there; it THROWS when it cannot tell (a host error, a link). `list`: every regular
 * file under a folder, recursively, as paths relative to the command's directory; an empty list when the folder is not there; undefined when the listing cannot be complete (cut short, a link, too many).
 */
export interface SeedSourceReader {
  read(path: string): Promise<string | undefined>;
  list(folder: string): Promise<readonly string[] | undefined>;
}

export const SEED_LOCK_REFUSALS = ["not_a_repo_script", "has_env", "script_shape", "pre_post_script", "tool_config", "imports_repo_files", "unreadable", "too_large", "no_files"] as const;
export type SeedLockRefusal = (typeof SEED_LOCK_REFUSALS)[number];
/** Why a seed command could not be locked, in fixed words (the reason the card gives for HIGH). */
export const SEED_LOCK_REFUSAL_WORDS: Record<SeedLockRefusal, string> = {
  not_a_repo_script: "it is not a plain run of one of the repository's own seed scripts",
  has_env: "it sets its own environment variables",
  script_shape: "its script does more than run one file or a database tool's seed",
  pre_post_script: "its script has a pre- or post-script that would run too",
  tool_config: "the database tool's own settings could move the seed elsewhere",
  imports_repo_files: "its seed code loads other files from the repository",
  unreadable: "the files it runs could not be read from the repository",
  too_large: "the files it runs are too large to check",
  no_files: "no seed files were found where it would look",
};

export type SeedLockResolution = { ok: true; lock: SeedScriptLock } | { ok: false; refusal: SeedLockRefusal };

const NODE_RUNNERS = new Set(["node", "tsx", "ts-node", "bun"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
/** The words a package manager takes as its own command (`yarn install`), never as a script. */
const MANAGER_COMMANDS = new Set(["add", "audit", "bin", "cache", "ci", "config", "create", "dedupe", "dlx", "exec", "help", "import", "info", "init", "install", "link", "list", "login", "logout", "outdated", "pack", "prune", "publish", "rebuild", "remove", "run", "run-script", "set", "start", "stop", "restart", "test", "unlink", "up", "update", "upgrade", "version", "why", "workspace", "workspaces"]);
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/u;
/** Anything a shell would read as more than words: a body with one of these is not a plain run. */
const SHELL_SYNTAX = /[|;&<>`$(){}[\]*?!~"'\\#=\n\r]/u;
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const RELATIVE_LOAD = /(?:\brequire\s*\(|\bimport\s*\(|\bfrom|\bimport)\s*["'`]\.{1,2}\//u;
const TOOLS: ReadonlyArray<{ tool: "prisma" | "knex" | "sequelize"; words: readonly string[] }> = [
  { tool: "prisma", words: ["prisma", "db", "seed"] },
  { tool: "knex", words: ["knex", "seed:run"] },
  { tool: "sequelize", words: ["sequelize", "db:seed:all"] },
  { tool: "sequelize", words: ["sequelize-cli", "db:seed:all"] },
];

class Refused extends Error {
  constructor(readonly refusal: SeedLockRefusal) { super(refusal); }
}
const refuse = (refusal: SeedLockRefusal): never => { throw new Refused(refusal); };

const sameWords = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((word, index) => word === right[index]);
const toolOf = (words: readonly string[]) => TOOLS.find((form) => sameWords(words, form.words) || sameWords(words, ["npx", ...form.words]))?.tool;

/** A relative path as the reader takes it: `./` dropped; anything else odd refuses. */
function plainPath(word: string): string {
  const path = word.replace(/^(?:\.\/)+/u, "");
  return LockPathSchema.safeParse(path).success ? path : refuse("script_shape");
}

class Inputs {
  readonly entries = new Map<string, string>();
  readonly files = new Set<string>();
  private bytes = 0;
  add(label: string, text: string, file?: string): void {
    const size = new TextEncoder().encode(text).length;
    if (size > SEED_LOCK_LIMITS.fileBytes) refuse("too_large");
    this.bytes += size;
    if (this.bytes > SEED_LOCK_LIMITS.totalBytes) refuse("too_large");
    this.entries.set(label, text);
    if (file !== undefined) this.files.add(file);
    if (this.files.size > SEED_LOCK_LIMITS.files) refuse("too_large");
  }
}

async function readText(reader: SeedSourceReader, path: string): Promise<string | undefined> {
  try { return await reader.read(path); } catch { return refuse("unreadable"); }
}

/** A source file the seed runs: hashed whole; one that loads another repository file refuses. */
async function addSource(reader: SeedSourceReader, inputs: Inputs, path: string): Promise<void> {
  const text = await readText(reader, path);
  if (text === undefined) refuse("unreadable");
  if (SOURCE_FILE.test(path) && RELATIVE_LOAD.test(text!)) refuse("imports_repo_files");
  inputs.add(path, text!, path);
}

/** A body that runs ONE file with a node runner (no option before the file). */
async function addFileRun(reader: SeedSourceReader, inputs: Inputs, body: string): Promise<boolean> {
  const words = body.trim().split(/\s+/u);
  if (!NODE_RUNNERS.has(words[0] ?? "")) return false;
  const file = words[1];
  if (file === undefined || file.startsWith("-")) refuse("script_shape");
  const path = plainPath(file!);
  if (!SOURCE_FILE.test(path)) refuse("script_shape");
  await addSource(reader, inputs, path);
  return true;
}

async function addFolder(reader: SeedSourceReader, inputs: Inputs, folder: string): Promise<void> {
  let listed: readonly string[] | undefined;
  try { listed = await reader.list(folder); } catch { refuse("unreadable"); }
  if (listed === undefined) refuse("unreadable");
  if (listed!.length === 0) refuse("no_files");
  if (listed!.length > SEED_LOCK_LIMITS.files) refuse("too_large");
  for (const path of [...listed!].sort()) {
    if (plainPath(path) !== path || !path.startsWith(`${folder}/`)) refuse("unreadable");
    await addSource(reader, inputs, path);
  }
}

async function packageJsonOf(reader: SeedSourceReader): Promise<Record<string, unknown>> {
  const text = await readText(reader, "package.json");
  if (text === undefined) refuse("not_a_repo_script");
  let parsed: unknown;
  try { parsed = JSON.parse(text!); } catch { return refuse("unreadable"); }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : refuse("unreadable");
}

const objectAt = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined);

async function addTool(reader: SeedSourceReader, inputs: Inputs, tool: "prisma" | "knex" | "sequelize"): Promise<void> {
  if (tool === "prisma") {
    for (const name of ["prisma.config.ts", "prisma.config.js", "prisma.config.mjs", "prisma.config.cjs", "prisma.config.mts", "prisma.config.cts"]) if (await readText(reader, name) !== undefined) refuse("tool_config");
    const seed = objectAt((await packageJsonOf(reader))["prisma"])?.["seed"];
    if (typeof seed !== "string" || SHELL_SYNTAX.test(seed)) refuse("tool_config");
    inputs.add("package.json#prisma.seed", seed as string, "package.json");
    if (!await addFileRun(reader, inputs, seed as string)) refuse("script_shape");
    return;
  }
  if (tool === "knex") {
    const found: Array<[string, string]> = [];
    for (const name of ["knexfile.js", "knexfile.ts", "knexfile.cjs", "knexfile.mjs"]) { const text = await readText(reader, name); if (text !== undefined) found.push([name, text]); }
    if (found.length !== 1 || /\bseeds\b/u.test(found[0]![1])) refuse("tool_config");
    const [name, text] = found[0]!;
    if (RELATIVE_LOAD.test(text)) refuse("imports_repo_files");
    inputs.add(name, text, name);
    await addFolder(reader, inputs, "seeds");
    return;
  }
  if (await readText(reader, ".sequelizerc") !== undefined) refuse("tool_config");
  for (const name of ["config/config.json", "config/config.js"]) {
    const text = await readText(reader, name);
    if (text === undefined) continue;
    if (RELATIVE_LOAD.test(text)) refuse("imports_repo_files");
    inputs.add(name, text, name);
  }
  await addFolder(reader, inputs, "seeders");
}

/** A package manager's run of a script: the script's name, or undefined when the words are not one. */
function scriptNameOf(command: ProjectCommand): string | undefined {
  const args = command.args;
  if (args.length === 2 && args[0] === "run" && SCRIPT_NAME.test(args[1]!)) return args[1];
  if (args.length === 1 && command.executable !== "npm" && SCRIPT_NAME.test(args[0]!) && !MANAGER_COMMANDS.has(args[0]!)) return args[0];
  return undefined;
}

/** The canonical text the lock hashes: version, command, and every input in label order. */
export function seedLockMaterial(command: Pick<ProjectCommand, "cwd" | "executable" | "args">, entries: ReadonlyMap<string, string>): string {
  return JSON.stringify({ version: SEED_LOCK_VERSION, command: { cwd: command.cwd, executable: command.executable, args: command.args }, inputs: [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) });
}

/** The lock of a seed command, resolved through `reader`, or why it cannot be locked. Never throws. */
export async function seedScriptLockOf(command: ProjectCommand, reader: SeedSourceReader): Promise<SeedLockResolution> {
  try {
    if (command.env !== undefined && Object.keys(command.env).length > 0) refuse("has_env");
    const inputs = new Inputs();
    const words = [command.executable, ...command.args];
    const tool = toolOf(words);
    if (tool !== undefined) await addTool(reader, inputs, tool);
    else if (PACKAGE_MANAGERS.has(command.executable)) {
      const name = scriptNameOf(command);
      if (name === undefined) refuse("not_a_repo_script");
      const scripts = objectAt((await packageJsonOf(reader))["scripts"]);
      const body = scripts?.[name!];
      if (typeof body !== "string") refuse("not_a_repo_script");
      if (scripts!["pre" + name!] !== undefined || scripts!["post" + name!] !== undefined) refuse("pre_post_script");
      if (SHELL_SYNTAX.test(body as string)) refuse("script_shape");
      inputs.add(`package.json#scripts.${name!}`, body as string, "package.json");
      const bodyTool = toolOf((body as string).trim().split(/\s+/u));
      if (bodyTool !== undefined) await addTool(reader, inputs, bodyTool);
      else if (!await addFileRun(reader, inputs, body as string)) refuse("script_shape");
    } else refuse("not_a_repo_script");
    const from = [...inputs.files].sort();
    const lock = SeedScriptLockSchema.safeParse({ version: SEED_LOCK_VERSION, hash: sha256Hex(seedLockMaterial(command, inputs.entries)), from });
    return lock.success ? { ok: true, lock: lock.data } : { ok: false, refusal: "unreadable" };
  } catch (error) {
    return { ok: false, refusal: error instanceof Refused ? error.refusal : "unreadable" };
  }
}

/** Whether a lock still holds: the command resolves again, through `reader`, to exactly the same hash and files. Any refusal or difference is false. */
export async function seedLockHolds(command: ProjectCommand, lock: SeedScriptLock, reader: SeedSourceReader): Promise<boolean> {
  const again = await seedScriptLockOf(command, reader);
  return again.ok && again.lock.hash === lock.hash && again.lock.version === lock.version;
}
