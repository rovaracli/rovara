import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

// Which DynamoDB actions can a Lambda's code reach? A coarse, fail-closed walk of the code from the Lambda's entry file, for the contract test that compares them with the role's synthesized grants
// (lambda-dynamodb-actions.test.ts). It is NOT a key scanner (state-key-uses.ts reads keys); it answers one question the key scanners could not: does the role hold the ACTION at all. The 0.5.15 staging
// failures it exists for: the realtime authorizer's role had no BatchGetItem for the name read it makes through resolveSessionAccess.
//
// How it reads the code. Every relative-imported TypeScript file is split into top-level units (a function, class, const, ...). The entry file is reached whole. From a reached unit, every identifier it
// mentions that is a unit of its own file, or a name imported from another relative module (followed through `export { x } from` and `export *`), reaches that unit. A unit that constructs a DynamoDB
// command contributes its action(s). Packages (the AWS SDK, @agentx/*, @rovara-code/*) are not followed: they hold key builders and types, no table calls (checked: see `contractPackageCalls`).
//
// What it over-approximates, said plainly: a class is one unit (every method of OrgStore counts when OrgStore is mentioned), an identifier mentioned only in a comment or a string counts, and every call counts
// whatever table it names. The contract test therefore pins what the walk finds but the role lacks, per Lambda, in a reviewed list with a reason for each: a NEW reachable-but-ungranted action fails.
// What it cannot follow: dynamic `import()`, `require`, and code reached through a name it cannot resolve (an identifier brought in by `import * as`); each is reported in `unresolved`, never skipped.

export type DynamoAction = "GetItem" | "PutItem" | "UpdateItem" | "DeleteItem" | "Query" | "Scan" | "BatchGetItem" | "BatchWriteItem" | "ConditionCheckItem";

export interface ReachedCall { action: DynamoAction; file: string; unit: string; command: string }
export interface Reach { calls: ReachedCall[]; unresolved: string[]; files: number; units: number }

interface Unit { name: string; text: string }
interface ModuleInfo {
  units: Map<string, Unit>;
  /** local name to the module and exported name it came from (a relative import only). */
  imports: Map<string, { file: string; name: string }>;
  /** `export { a as b } from "./x"`: exported name to where it lives; `export *` modules in `stars`. */
  reexports: Map<string, { file: string; name: string }>;
  stars: string[];
  unresolved: string[];
}

const DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

/** Splits a file into its top-level units: a unit runs from a declaration at column 0 to the next one. Lines before the first declaration (imports) belong to no unit. */
function unitsOf(text: string): Unit[] {
  const lines = stripComments(text).split("\n");
  const units: Unit[] = [];
  let current: { name: string; lines: string[] } | undefined;
  const flush = () => { if (current !== undefined) units.push({ name: current.name, text: current.lines.join("\n") }); };
  for (const line of lines) {
    const match = DECLARATION.exec(line);
    if (match !== null) { flush(); current = { name: match[2]!, lines: [line] }; continue; }
    // A top-level statement (not a declaration, not a closing brace or continuation) after a unit is a unit of its own, so a side-effect call at module level is reached with the file.
    if (current !== undefined) current.lines.push(line);
  }
  flush();
  return units;
}

const COMMANDS: Array<[RegExp, DynamoAction[]]> = [
  [/\bnew\s+GetCommand\b/, ["GetItem"]], [/\bnew\s+QueryCommand\b/, ["Query"]], [/\bnew\s+ScanCommand\b/, ["Scan"]],
  [/\bnew\s+PutCommand\b/, ["PutItem"]], [/\bnew\s+UpdateCommand\b/, ["UpdateItem"]], [/\bnew\s+DeleteCommand\b/, ["DeleteItem"]],
  [/\bnew\s+BatchGetCommand\b/, ["BatchGetItem"]], [/\bnew\s+BatchWriteCommand\b/, ["BatchWriteItem"]],
  [/\bnew\s+TransactGetCommand\b/, ["GetItem"]],
];
/** A transaction's members: a TransactWriteCommand needs the item action of each member it names. */
const TRANSACT_MEMBERS: Array<[RegExp, DynamoAction]> = [[/\bPut:/, "PutItem"], [/\bUpdate:/, "UpdateItem"], [/\bDelete:/, "DeleteItem"], [/\bConditionCheck:/, "ConditionCheckItem"]];
/** The `getItem(deps, key)` one-line wrapper some files define: its callers are reads. */
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** The DynamoDB actions a piece of code constructs commands for. */
export function actionsIn(text: string): Array<{ action: DynamoAction; command: string }> {
  const found: Array<{ action: DynamoAction; command: string }> = [];
  for (const [pattern, actions] of COMMANDS) {
    const match = pattern.exec(text);
    if (match !== null) for (const action of actions) found.push({ action, command: match[0].replace(/^new\s+/, "") });
  }
  if (/\bnew\s+TransactWriteCommand\b/.test(text)) {
    for (const [pattern, action] of TRANSACT_MEMBERS) if (pattern.test(text)) found.push({ action, command: "TransactWriteCommand" });
  }
  return found;
}

export function reachableDynamoCalls(entry: string, root: URL): Reach {
  const rootPath = root.pathname;
  const modules = new Map<string, ModuleInfo>();
  const load = (file: string): ModuleInfo | undefined => {
    const cached = modules.get(file);
    if (cached !== undefined) return cached;
    if (!existsSync(file)) return undefined;
    const text = readFileSync(file, "utf8");
    const info: ModuleInfo = { units: new Map(), imports: new Map(), reexports: new Map(), stars: [], unresolved: [] };
    modules.set(file, info);
    const target = (specifier: string): string | undefined => {
      if (!specifier.startsWith(".")) return undefined;
      const path = resolve(dirname(file), specifier.replace(/\.js$/u, ".ts"));
      return existsSync(path) ? path : resolve(dirname(file), specifier, "index.ts");
    };
    for (const unit of unitsOf(text)) info.units.set(unit.name, unit);
    const clean = stripComments(text);
    for (const match of clean.matchAll(/^import\s+(type\s+)?([^"';]*?)\s+from\s+"([^"]+)"/gm)) {
      if (match[1] !== undefined) continue;
      const path = target(match[3]!);
      if (path === undefined) continue;
      const clause = match[2]!;
      const named = /\{([\s\S]*)\}/.exec(clause)?.[1];
      if (named !== undefined) {
        for (const part of named.split(",")) {
          const piece = part.trim();
          if (piece === "" || piece.startsWith("type ")) continue;
          const [name, alias] = piece.split(/\s+as\s+/u);
          info.imports.set((alias ?? name)!.trim(), { file: path, name: name!.trim() });
        }
      }
      const namespace = /\*\s+as\s+([\w$]+)/.exec(clause)?.[1];
      if (namespace !== undefined) info.unresolved.push(`${relative(rootPath, file)}: \`import * as ${namespace}\` from ${match[3]!} is followed as a whole module`);
      const defaultName = /^([\w$]+)\s*(?:,|$)/.exec(clause.replace(/^type\s+/, ""))?.[1];
      if (defaultName !== undefined && !clause.startsWith("{") && namespace === undefined) info.unresolved.push(`${relative(rootPath, file)}: default import ${defaultName} from ${match[3]!}`);
    }
    for (const match of clean.matchAll(/^export\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/gm)) {
      if (match[1] !== undefined) continue;
      const path = target(match[3]!);
      if (path === undefined) continue;
      for (const part of match[2]!.split(",")) {
        const piece = part.trim();
        if (piece === "" || piece.startsWith("type ")) continue;
        const [name, alias] = piece.split(/\s+as\s+/u);
        info.reexports.set((alias ?? name)!.trim(), { file: path, name: name!.trim() });
      }
    }
    for (const match of clean.matchAll(/^export\s+\*\s+from\s+"([^"]+)"/gm)) {
      const path = target(match[1]!);
      if (path !== undefined) info.stars.push(path);
    }
    for (const match of clean.matchAll(/\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)|\brequire\(/g)) {
      if (match[1] === undefined || match[1].startsWith(".")) info.unresolved.push(`${relative(rootPath, file)}: dynamic import or require of ${match[1] ?? "(a value)"}`);
    }
    return info;
  };

  /** Where `name` is defined, starting from a module: the module's own unit, a re-export, or an `export *` module. */
  const define = (file: string, name: string, depth = 0): { file: string; name: string } | undefined => {
    const info = load(file);
    if (info === undefined || depth > 8) return undefined;
    if (info.units.has(name)) return { file, name };
    const re = info.reexports.get(name);
    if (re !== undefined) return define(re.file, re.name, depth + 1);
    for (const star of info.stars) { const found = define(star, name, depth + 1); if (found !== undefined) return found; }
    return undefined;
  };

  const entryPath = resolve(rootPath, entry);
  const reached = new Set<string>();
  const queue: Array<{ file: string; name: string }> = [];
  const entryInfo = load(entryPath);
  if (entryInfo === undefined) throw new Error(`no such entry ${entry}`);
  for (const name of entryInfo.units.keys()) queue.push({ file: entryPath, name });
  // Imports the entry file makes that no unit mentions are still loaded for their unresolved notes only if reached; module-level side effects of other files are not followed.
  const calls: ReachedCall[] = [];
  const unresolved: string[] = [...entryInfo.unresolved];
  const filesSeen = new Set<string>([entryPath]);
  while (queue.length > 0) {
    const { file, name } = queue.pop()!;
    const key = `${file}\0${name}`;
    if (reached.has(key)) continue;
    reached.add(key);
    const info = load(file)!;
    const unit = info.units.get(name);
    if (unit === undefined) continue;
    for (const found of actionsIn(unit.text)) calls.push({ ...found, file: relative(rootPath, file), unit: name });
    for (const identifier of new Set(unit.text.match(IDENTIFIER) ?? [])) {
      if (identifier === name) continue;
      if (info.units.has(identifier)) { queue.push({ file, name: identifier }); continue; }
      const imported = info.imports.get(identifier);
      if (imported === undefined) continue;
      const where = define(imported.file, imported.name);
      if (where === undefined) continue;
      if (!filesSeen.has(where.file)) { filesSeen.add(where.file); unresolved.push(...load(where.file)!.unresolved); }
      queue.push(where);
    }
  }
  return { calls, unresolved: [...new Set(unresolved)].sort(), files: filesSeen.size, units: reached.size };
}
