// Moves cohesive groups of top-level declarations out of one big TypeScript file into sibling modules, without editing any of them.
// It is a pure move: every statement keeps its text and its order inside its new module; the only edits are an `export ` keyword in front of a
// declaration another module now needs, and import lines. The original file stays as a thin composition file: it re-exports exactly the names it
// exported before and keeps what the config says stays. Used by scripts/split/split-developer.ts. Node runs this directly, so only erasable syntax.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/** What one source file is split by. Names are top-level declaration names; a name that is in no list is placed by affinity (see `placeUnits`). */
export interface SplitConfig {
  /** The file to split, relative to the checkout root. */
  source: string;
  /** The directory the new modules go in, relative to the checkout root. */
  outDir: string;
  /** Module file name (without `.ts`) to the names it holds. The order of the keys is the order the thin file re-exports them in. */
  modules: Readonly<Record<string, readonly string[]>>;
  /** Names that stay in the original file. */
  stay: readonly string[];
  /** Where a name that is in no list and has no single user goes. */
  fallbackModule: string;
  /**
   * Keep the original file's value imports as bare `import "x";` lines at the top of the thin file, in their original order, so every dependency is
   * evaluated first and in the same order as before the split (the new modules then find them already evaluated).
   */
  preserveImportOrder: boolean;
  /**
   * Every declaration must be listed: a name in no list is an error (it says where the name would have gone) instead of being placed by use. The shared
   * config is strict so the same name lands in the same file in every repository that carries it.
   */
  strict?: boolean;
}

/** Names a private checkout adds to the shared config (modules of its own, more names in shared modules, more `stay` names). */
export interface ConfigOverlay {
  modules: Readonly<Record<string, readonly string[]>>;
  stay?: readonly string[];
  /** The order of every module key in the merged config (it sets the order of the thin file's re-exports); default: shared keys, then the overlay's new keys. */
  moduleOrder?: readonly string[];
}

/** The shared config with a private overlay added. Names are only ever added, so a name the shared config lists lands in the same module either way. */
export function mergeConfig(shared: SplitConfig, overlay: ConfigOverlay | undefined): SplitConfig {
  if (overlay === undefined) return shared;
  const modules: Record<string, string[]> = {};
  for (const [key, names] of Object.entries(shared.modules)) modules[key] = [...names];
  for (const [key, names] of Object.entries(overlay.modules)) modules[key] = [...(modules[key] ?? []), ...names];
  const order = overlay.moduleOrder ?? Object.keys(modules);
  const missingKeys = Object.keys(modules).filter((key) => !order.includes(key));
  if (missingKeys.length > 0) throw new Error(`moduleOrder lacks: ${missingKeys.join(", ")}`);
  const ordered: Record<string, string[]> = {};
  for (const key of order) if (modules[key] !== undefined) ordered[key] = modules[key];
  return { ...shared, modules: ordered, stay: [...shared.stay, ...(overlay.stay ?? [])] };
}

/** Plain code-unit order: the same on every machine (localeCompare depends on ICU and the locale). */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface Unit {
  /** Every top-level name this unit declares (a merged value and type of one name, or an overloaded function, is one unit). */
  names: string[];
  statements: number[];
  kind: string;
  exported: boolean;
  /** Source lines the unit takes, comments included. */
  lines: number;
}

export interface Problem { severity: "error" | "warning"; message: string }

export interface Plan {
  config: SplitConfig;
  fileLines: number;
  units: Unit[];
  /** Index into `units` to module name; "" is the original file. */
  moduleOf: string[];
  /** Names in the config that the file does not declare. */
  missing: string[];
  /** Units that no list names, with the module they were placed in. */
  placedByAffinity: { unit: number; module: string; why: string }[];
  problems: Problem[];
  /** Module to the modules it imports from, runtime or type-only. */
  moduleEdges: Map<string, Set<string>>;
  cycles: string[][];
  /** Per module, per imported module, the names it uses from there (runtime uses only). */
  witnesses: Map<string, Map<string, string[]>>;
  outputs: Map<string, string>;
  /** Exported name of the original file to the module that now holds it. */
  exportMap: Map<string, string>;
  /** Per-module line counts of the output. */
  lineCounts: Map<string, number>;
}

interface ImportBinding {
  local: string;
  /** Index of the import declaration. */
  declaration: number;
  kind: "default" | "named" | "namespace";
  /** The name in the other module (named imports). */
  imported: string;
  typeOnly: boolean;
}

/** How a unit uses another: only as a type, inside a function body (runs later), or when its module loads. */
type UseKind = 0 | 1 | 2;
const TYPE_USE = 0;
const DEFERRED_USE = 1;
const LOAD_USE = 2;

/** What a statement uses. `imports` maps an import's local name to whether it is used as a value (false: only in type positions). */
interface Use { imports: Map<string, boolean>; units: Map<number, UseKind> }

interface Chunk { start: number; end: number; blankBefore: boolean }

const ORIGINAL = "";

export interface PlanOptions {
  /** Downgrade "not listed" errors of a strict config to a report (the names are placed by use). */
  allowPlacement?: boolean;
}

export function planSplit(rootDirectory: string, config: SplitConfig, options: PlanOptions = {}): Plan {
  const sourcePath = path.join(rootDirectory, config.source);
  const text = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const checker = checkerFor(sourceFile);
  const problems: Problem[] = [];
  const fail = (message: string) => problems.push({ severity: "error", message });
  const warn = (message: string) => problems.push({ severity: "warning", message });

  const statements = [...sourceFile.statements];
  const chunks = chunksOf(text, statements);

  // Imports: what each local name is bound to.
  const importDeclarations: ts.ImportDeclaration[] = [];
  const bindings = new Map<string, ImportBinding>();
  for (const statement of statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const index = importDeclarations.push(statement) - 1;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) bindings.set(clause.name.text, { local: clause.name.text, declaration: index, kind: "default", imported: "default", typeOnly: clause.isTypeOnly });
    const named = clause.namedBindings;
    if (named !== undefined && ts.isNamespaceImport(named)) bindings.set(named.name.text, { local: named.name.text, declaration: index, kind: "namespace", imported: "*", typeOnly: clause.isTypeOnly });
    if (named !== undefined && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.set(element.name.text, { local: element.name.text, declaration: index, kind: "named", imported: (element.propertyName ?? element.name).text, typeOnly: clause.isTypeOnly || element.isTypeOnly });
      }
    }
  }

  // Declarations: one unit per name (statements sharing a name are one unit).
  const declared = new Map<string, number>();
  const parent = statements.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index] as number)));
  const unsupported: number[] = [];
  statements.forEach((statement, index) => {
    if (ts.isImportDeclaration(statement)) return;
    const names = declaredNames(statement);
    if (names === undefined) { unsupported.push(index); return; }
    for (const name of names) {
      const earlier = declared.get(name);
      if (earlier === undefined) declared.set(name, index);
      else parent[find(index)] = find(earlier);
    }
  });
  const unitIndexOfRoot = new Map<number, number>();
  const units: Unit[] = [];
  const unitOfStatement = new Map<number, number>();
  statements.forEach((statement, index) => {
    if (ts.isImportDeclaration(statement) || unsupported.includes(index)) return;
    const root = find(index);
    let unitIndex = unitIndexOfRoot.get(root);
    if (unitIndex === undefined) {
      unitIndex = units.push({ names: [], statements: [], kind: kindOf(statement), exported: false, lines: 0 }) - 1;
      unitIndexOfRoot.set(root, unitIndex);
    }
    const unit = units[unitIndex] as Unit;
    unit.statements.push(index);
    for (const name of declaredNames(statement) ?? []) if (!unit.names.includes(name)) unit.names.push(name);
    if (isExported(statement)) unit.exported = true;
    if (kindOf(statement) === "function" || kindOf(statement) === "const") unit.kind = kindOf(statement);
    unitOfStatement.set(index, unitIndex);
  });
  for (const unit of units) unit.lines = unit.statements.reduce((sum, index) => sum + lineCount(text, chunks[index] as Chunk), 0);
  const unitOfName = new Map<string, number>();
  units.forEach((unit, index) => unit.names.forEach((name) => unitOfName.set(name, index)));

  // Statements that are neither imports nor a plain declaration (re-exports, expressions, default exports) stay in the original file.
  const keptStatements = unsupported.filter((index) => !ts.isImportDeclaration(statements[index] as ts.Statement));
  for (const index of keptStatements) {
    const statement = statements[index] as ts.Statement;
    if (!ts.isExportDeclaration(statement)) warn(`line ${lineOf(sourceFile, statement)}: ${ts.SyntaxKind[statement.kind]} stays in the original file`);
  }

  // What each unit uses: imports, other units (and whether the use runs when the module loads).
  const useOfUnit: Use[] = units.map(() => ({ imports: new Map(), units: new Map() }));
  const useOfKept = new Map<number, Use>();
  const collect = (statementIndex: number, use: Use, ownUnit: number | undefined) => {
    const statement = statements[statementIndex] as ts.Statement;
    const visit = (node: ts.Node, deferred: boolean, typeOnly: boolean): void => {
      if (ts.isIdentifier(node)) {
        const resolved = resolveTopLevel(checker, sourceFile, node);
        if (resolved === undefined) return;
        if (resolved.kind === "import") {
          const asValue = !(typeOnly || isTypeOnlyStatement(statement));
          use.imports.set(resolved.name, (use.imports.get(resolved.name) ?? false) || asValue);
          return;
        }
        const target = unitOfName.get(resolved.name);
        if (target === undefined || target === ownUnit) return;
        const kind: UseKind = typeOnly || isTypeOnlyStatement(statement) ? TYPE_USE : deferred ? DEFERRED_USE : LOAD_USE;
        use.units.set(target, Math.max(use.units.get(target) ?? TYPE_USE, kind) as UseKind);
        return;
      }
      const nextDeferred = deferred || ts.isFunctionLike(node) && !ts.isTypeNode(node);
      const nextTypeOnly = typeOnly || ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node);
      ts.forEachChild(node, (child) => visit(child, nextDeferred, nextTypeOnly));
    };
    visit(statement, false, false);
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause) && statement.moduleSpecifier === undefined) {
      for (const element of statement.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text;
        if (bindings.has(local)) use.imports.set(local, true);
        else if (unitOfName.has(local)) fail(`line ${lineOf(sourceFile, statement)}: \`export { ${local} }\` re-exports a declaration that is moved; list ${local} under stay`);
      }
    }
  };
  units.forEach((unit, index) => unit.statements.forEach((statementIndex) => collect(statementIndex, useOfUnit[index] as Use, index)));
  for (const index of keptStatements) {
    const use: Use = { imports: new Map(), units: new Map() };
    useOfKept.set(index, use);
    collect(index, use, undefined);
  }

  // Placement.
  const { moduleOf, missing, placedByAffinity } = placeUnits(config, units, unitOfName, useOfUnit.map((use) => use.units), fail);
  const keptModule = ORIGINAL;
  if (config.strict === true && !(options.allowPlacement ?? false)) {
    for (const placed of placedByAffinity) fail(`${names(units, placed.unit)} is in no list (it would go to ${placed.module}: ${placed.why}); add it to the config`);
  }

  // Which units another module needs, and what each module imports from the others.
  const neededOutside = new Set<number>();
  const moduleNames = [...new Set([...Object.keys(config.modules), config.fallbackModule, ...moduleOf])].filter((name) => name !== ORIGINAL);
  const moduleEdges = new Map<string, Set<string>>([[ORIGINAL, new Set()], ...moduleNames.map((name): [string, Set<string>] => [name, new Set()])]);
  const witnesses = new Map<string, Map<string, string[]>>();
  const initEdges: { from: string; to: string; fromUnit: number; toUnit: number }[] = [];
  units.forEach((_, index) => {
    const own = moduleOf[index] as string;
    for (const [target, use] of useOfUnit[index]?.units ?? []) {
      const other = moduleOf[target] as string;
      if (other === own) continue;
      neededOutside.add(target);
      if (use !== TYPE_USE) {
        moduleEdges.get(own)?.add(other);
        const bucket = witnesses.get(own) ?? new Map<string, string[]>();
        bucket.set(other, [...(bucket.get(other) ?? []), `${names(units, index)}->${names(units, target)}`]);
        witnesses.set(own, bucket);
      }
      if (use === LOAD_USE) initEdges.push({ from: own, to: other, fromUnit: index, toUnit: target });
    }
  });
  for (const index of keptStatements) {
    for (const [target, use] of useOfKept.get(index)?.units ?? []) {
      const other = moduleOf[target] as string;
      neededOutside.add(target);
      if (use !== TYPE_USE) moduleEdges.get(keptModule)?.add(other);
    }
  }
  for (const unit of units) if (unit.exported) neededOutside.add(units.indexOf(unit));
  // A module the original file imports from must not import the original file back (it re-exports them).
  for (const [from, to] of moduleEdges) if (from !== ORIGINAL && to.has(ORIGINAL)) fail(`module ${from} uses a declaration that stays in ${path.basename(config.source)}; move it into a module`);

  const cycles = stronglyConnected(moduleEdges).filter((component) => component.length > 1);
  for (const edge of initEdges) {
    const cycle = cycles.find((component) => component.includes(edge.from) && component.includes(edge.to));
    if (cycle !== undefined) {
      fail(`${names(units, edge.fromUnit)} (${edge.from}) runs ${names(units, edge.toUnit)} (${edge.to}) when its module loads, and the two modules import each other (${cycle.join(", ")}); move one so the cycle goes`);
    }
  }
  for (const cycle of cycles) warn(`modules import each other in a cycle (declarations only, nothing runs at load): ${cycle.join(" <-> ")}`);

  // Emit.
  const outputs = new Map<string, string>();
  const exportMap = new Map<string, string>();
  units.forEach((unit, index) => { if (unit.exported) for (const name of unit.names) exportMap.set(name, moduleOf[index] as string); });
  const importComments = new Map<number, string>();
  importDeclarations.forEach((declaration, index) => {
    const statementIndex = statements.indexOf(declaration);
    if (statementIndex === statements.findIndex((statement) => ts.isImportDeclaration(statement))) return;
    const chunk = chunks[statementIndex] as Chunk;
    const comment = text.slice(chunk.start, declaration.getStart()).trim();
    if (comment !== "") importComments.set(index, comment);
  });
  const context: EmitContext = { text, sourceFile, statements, chunks, units, moduleOf, importDeclarations, bindings, config, neededOutside, unitOfStatement, useOfUnit, useOfKept, keptStatements, moduleNames, exportMap, importComments };
  for (const name of moduleNames) {
    const body = emitModule(context, name);
    if (body !== undefined) outputs.set(`${config.outDir}/${name}.ts`, body);
  }
  outputs.set(config.source, emitOriginal(context));
  // A comment that sat on an import line must have been carried into some output file; say so when it was not.
  for (const comment of importComments.values()) {
    if (![...outputs.values()].some((body) => body.includes(comment))) warn(`a comment on an import line was not carried (nothing uses that import): ${comment.slice(0, 80).replace(/\s+/g, " ")}`);
  }
  const lineCounts = new Map([...outputs].map(([file, body]) => [file, body.split("\n").length - 1] as const));
  return { config, fileLines: text.split("\n").length, units, moduleOf, missing, placedByAffinity, problems, moduleEdges, cycles, witnesses, outputs, exportMap, lineCounts };
}

/**
 * Writes a plan's files under a checkout root. It never overwrites a module file that already exists unless `force` is set (the original file is the one
 * file it always rewrites): a re-run on a tree that is already split must not replace real modules with near-empty ones.
 */
export function writePlan(rootDirectory: string, plan: Plan, options: { force?: boolean } = {}): void {
  const existing = [...plan.outputs.keys()].filter((file) => file !== plan.config.source && existsSync(path.join(rootDirectory, file)));
  if (existing.length > 0 && options.force !== true) throw new Error(`refusing to overwrite existing module files without --force: ${existing.join(", ")}`);
  for (const [file, body] of plan.outputs) {
    const target = path.join(rootDirectory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
}

/** Module files in the output directory that the plan does not write (left behind by an earlier split of other groups). */
export function staleModules(rootDirectory: string, plan: Plan): string[] {
  const directory = path.join(rootDirectory, plan.config.outDir);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith(".ts")).map((name) => `${plan.config.outDir}/${name}`).filter((file) => !plan.outputs.has(file)).sort(compareText);
}

/** Whether the file is already split: the new directory exists and no unit is left to move. */
export function alreadySplit(rootDirectory: string, config: SplitConfig, plan: Plan): boolean {
  if (!existsSync(path.join(rootDirectory, config.outDir))) return false;
  return plan.units.every((_, index) => plan.moduleOf[index] === ORIGINAL);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------

function names(units: readonly Unit[], index: number): string {
  return (units[index] as Unit).names.join("/");
}

/** A checker over the one file: no libraries and no module resolution, which is all it takes to tell a local declaration from an import. */
function checkerFor(sourceFile: ts.SourceFile): ts.TypeChecker {
  const options: ts.CompilerOptions = { noResolve: true, noLib: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [], skipLibCheck: true };
  const host = ts.createCompilerHost(options, true);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => (path.resolve(fileName) === path.resolve(sourceFile.fileName) ? sourceFile : original(fileName, languageVersion, ...rest));
  host.fileExists = (fileName) => path.resolve(fileName) === path.resolve(sourceFile.fileName);
  host.readFile = (fileName) => (path.resolve(fileName) === path.resolve(sourceFile.fileName) ? sourceFile.text : undefined);
  return ts.createProgram({ rootNames: [sourceFile.fileName], options, host }).getTypeChecker();
}

/** Splits the file into one chunk per statement: its leading comments and blank lines, the statement, and a comment that trails it on its last line. */
function chunksOf(text: string, statements: readonly ts.Statement[]): Chunk[] {
  const chunks: Chunk[] = [];
  let previousEnd = 0;
  statements.forEach((statement, index) => {
    const next = statements[index + 1];
    // The part of the last line after this statement that holds only a comment belongs to this statement.
    let end = statement.end;
    const rest = /^[ \t]*(?:\/\/[^\n]*|\/\*[^\n]*?\*\/[ \t]*)?(?=\n|$)/.exec(text.slice(end));
    if (rest !== null) end += rest[0].length;
    const start = index === 0 ? 0 : previousEnd;
    chunks.push({ start, end: next === undefined ? text.length : end, blankBefore: false });
    previousEnd = end;
  });
  // Trim each chunk to its own text: no leading newline, and remember whether a blank line preceded it.
  return chunks.map((chunk) => {
    let start = chunk.start;
    let newlines = 0;
    while (start < chunk.end && /\s/.test(text[start] as string)) { if (text[start] === "\n") newlines += 1; start += 1; }
    const blankBefore = newlines >= 2;
    let end = chunk.end;
    while (end > start && /[\s]/.test(text[end - 1] as string)) end -= 1;
    return { start, end, blankBefore };
  });
}

function lineCount(text: string, chunk: Chunk): number {
  return text.slice(chunk.start, chunk.end).split("\n").length;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

function isExported(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function kindOf(statement: ts.Statement): string {
  if (ts.isFunctionDeclaration(statement)) return "function";
  if (ts.isVariableStatement(statement)) return "const";
  if (ts.isInterfaceDeclaration(statement)) return "interface";
  if (ts.isTypeAliasDeclaration(statement)) return "type";
  if (ts.isClassDeclaration(statement)) return "class";
  if (ts.isEnumDeclaration(statement)) return "enum";
  return ts.SyntaxKind[statement.kind] ?? "other";
}

function isTypeOnlyStatement(statement: ts.Statement): boolean {
  return ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
}

/** The names a plain declaration statement declares, or undefined for any other statement (those stay in the original file). */
function declaredNames(statement: ts.Statement): string[] | undefined {
  if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) return undefined;
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
    if (statement.name === undefined) return undefined;
    if (ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return undefined;
    return [statement.name.text];
  }
  if (ts.isVariableStatement(statement)) {
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return undefined;
    const found: string[] = [];
    const collectBinding = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) found.push(name.text);
      else for (const element of name.elements) if (ts.isBindingElement(element)) collectBinding(element.name);
    };
    for (const declaration of statement.declarationList.declarations) collectBinding(declaration.name);
    return found;
  }
  return undefined;
}

type Resolved = { kind: "import" | "declaration"; name: string } | undefined;

/** What an identifier refers to, when that is an import or a top-level declaration of this file. Locals, parameters, properties and globals are undefined. */
function resolveTopLevel(checker: ts.TypeChecker, sourceFile: ts.SourceFile, identifier: ts.Identifier): Resolved {
  let symbol: ts.Symbol | undefined;
  if (ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier) symbol = checker.getShorthandAssignmentValueSymbol(identifier.parent);
  else if (ts.isExportSpecifier(identifier.parent)) return undefined;
  else symbol = checker.getSymbolAtLocation(identifier);
  if (symbol === undefined) return undefined;
  for (const declaration of symbol.declarations ?? []) {
    if (declaration.getSourceFile() !== sourceFile) continue;
    if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) return { kind: "import", name: symbol.name };
    const top = topLevelDeclarationName(declaration, sourceFile);
    if (top !== undefined) return { kind: "declaration", name: top };
  }
  return undefined;
}

function topLevelDeclarationName(declaration: ts.Declaration, sourceFile: ts.SourceFile): string | undefined {
  if ((ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration) || ts.isEnumDeclaration(declaration)) && declaration.parent === sourceFile) {
    return declaration.name?.text;
  }
  if (ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) && ts.isVariableStatement(declaration.parent.parent) && declaration.parent.parent.parent === sourceFile && ts.isIdentifier(declaration.name)) {
    return declaration.name.text;
  }
  if (ts.isBindingElement(declaration) && ts.isIdentifier(declaration.name)) {
    let node: ts.Node = declaration;
    while (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) node = node.parent;
    if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) && node.parent.parent.parent === sourceFile) return declaration.name.text;
  }
  return undefined;
}

/**
 * Gives every unit a module. A listed name goes where it is listed. A name in no list goes to the one module every user of it is in; with several
 * users (or none), to the fallback module. Repeats until nothing changes, because a placed unit can make its helper's users agree.
 */
function placeUnits(config: SplitConfig, units: readonly Unit[], unitOfName: ReadonlyMap<string, number>, uses: readonly ReadonlyMap<number, UseKind>[], fail: (message: string) => void) {
  const moduleOf: string[] = units.map(() => "\u0000");
  const missing: string[] = [];
  const stay = new Set(config.stay);
  for (const name of stay) if (!unitOfName.has(name)) missing.push(`stay: ${name}`);
  const assigned = new Map<string, string>();
  for (const [moduleName, listed] of Object.entries(config.modules)) {
    for (const name of listed) {
      if (!unitOfName.has(name)) { missing.push(`${moduleName}: ${name}`); continue; }
      const earlier = assigned.get(name);
      if (earlier !== undefined) fail(`${name} is listed in both ${earlier} and ${moduleName}`);
      if (stay.has(name)) fail(`${name} is listed under stay and in ${moduleName}`);
      assigned.set(name, moduleName);
    }
  }
  units.forEach((unit, index) => {
    const listed = unit.names.map((name) => (stay.has(name) ? ORIGINAL : assigned.get(name))).filter((value): value is string => value !== undefined);
    if (listed.length === 0) return;
    if (new Set(listed).size > 1) fail(`${unit.names.join("/")} is one unit (merged names or overloads) but its names are in different modules`);
    moduleOf[index] = listed[0] as string;
  });
  const placedByAffinity: { unit: number; module: string; why: string }[] = [];
  const usersOf = (target: number): number[] => uses.flatMap((use, index) => (use.has(target) ? [index] : []));
  for (let changed = true; changed;) {
    changed = false;
    units.forEach((_, index) => {
      if (moduleOf[index] !== "\u0000") return;
      const users = usersOf(index);
      if (users.length === 0) return;
      const placedUsers = users.filter((user) => moduleOf[user] !== "\u0000");
      if (placedUsers.length !== users.length) return;
      const where = new Set(placedUsers.map((user) => moduleOf[user]));
      if (where.size !== 1) return;
      const only = [...where][0] ?? ORIGINAL;
      const placed = only === ORIGINAL ? config.fallbackModule : only;
      moduleOf[index] = placed;
      placedByAffinity.push({ unit: index, module: placed, why: `only used by ${only === ORIGINAL ? "the original file" : only}` });
      changed = true;
    });
  }
  units.forEach((unit, index) => {
    if (moduleOf[index] !== "\u0000") return;
    moduleOf[index] = config.fallbackModule;
    placedByAffinity.push({ unit: index, module: config.fallbackModule, why: usersOf(index).length === 0 ? "no user and not listed" : "several users in different modules" });
  });
  return { moduleOf, missing, placedByAffinity };
}

/** Tarjan's strongly connected components, in a stable order. */
function stronglyConnected(edges: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;
  const visit = (node: string): void => {
    index.set(node, counter); low.set(node, counter); counter += 1;
    stack.push(node); onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) { visit(next); low.set(node, Math.min(low.get(node) as number, low.get(next) as number)); }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node) as number, index.get(next) as number));
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
        onStack.delete(top); component.push(top);
        if (top === node) break;
      }
      result.push(component.sort());
    }
  };
  for (const node of [...edges.keys()].sort()) if (!index.has(node)) visit(node);
  return result.sort((a, b) => compareText(a[0] as string, b[0] as string));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------

interface EmitContext {
  text: string;
  sourceFile: ts.SourceFile;
  statements: readonly ts.Statement[];
  chunks: readonly Chunk[];
  units: readonly Unit[];
  moduleOf: readonly string[];
  importDeclarations: readonly ts.ImportDeclaration[];
  bindings: ReadonlyMap<string, ImportBinding>;
  config: SplitConfig;
  neededOutside: ReadonlySet<number>;
  unitOfStatement: ReadonlyMap<number, number>;
  useOfUnit: readonly Use[];
  useOfKept: ReadonlyMap<number, Use>;
  keptStatements: readonly number[];
  moduleNames: readonly string[];
  exportMap: ReadonlyMap<string, string>;
  /** Leading comment of each import declaration (by index), except the first, whose comment is the file header. */
  importComments: ReadonlyMap<number, string>;
}

/** The text of one statement as it goes into a module: the original text, with `export ` in front of the declaration when another module needs it. */
function statementText(context: EmitContext, statementIndex: number, needsExport: boolean): string {
  const chunk = context.chunks[statementIndex] as Chunk;
  const statement = context.statements[statementIndex] as ts.Statement;
  let body = context.text.slice(chunk.start, chunk.end);
  if (needsExport && !isExported(statement)) {
    const offset = statement.getStart() - chunk.start;
    body = `${body.slice(0, offset)}export ${body.slice(offset)}`;
  }
  return body;
}

function emitModule(context: EmitContext, moduleName: string): string | undefined {
  const members = context.units.flatMap((unit, index) => (context.moduleOf[index] === moduleName ? [index] : []));
  if (members.length === 0) return undefined;
  const memberSet = new Set(members);
  const statementIndexes = members.flatMap((index) => (context.units[index] as Unit).statements).sort((a, b) => a - b);
  const importNames = new Map<string, boolean>();
  const foreign = new Map<string, Map<string, boolean>>();
  for (const index of members) {
    for (const [name, asValue] of context.useOfUnit[index]?.imports ?? []) importNames.set(name, (importNames.get(name) ?? false) || asValue);
    for (const target of context.useOfUnit[index]?.units.keys() ?? []) if (!memberSet.has(target)) addForeign(context, foreign, target);
  }
  const lines: string[] = [];
  lines.push(...importLines(context, importNames, false, new Set()));
  lines.push(...foreignImportLines(context, foreign, moduleName));
  lines.push("");
  let first = true;
  let previous = -2;
  for (const statementIndex of statementIndexes) {
    const unitIndex = context.unitOfStatement.get(statementIndex) as number;
    const chunk = context.chunks[statementIndex] as Chunk;
    const body = statementText(context, statementIndex, context.neededOutside.has(unitIndex));
    if (!first && (chunk.blankBefore || statementIndex !== previous + 1)) lines.push("");
    lines.push(body);
    first = false;
    previous = statementIndex;
  }
  return `${lines.join("\n").replace(/^\n+/, "")}\n`;
}

function emitOriginal(context: EmitContext): string {
  const { statements, text, config } = context;
  const lines: string[] = [];
  const firstImport = statements.findIndex((statement) => ts.isImportDeclaration(statement));
  const headerEnd = firstImport === -1 ? 0 : (statements[firstImport] as ts.Statement).getStart();
  const header = firstImport === -1 ? "" : text.slice(0, headerEnd).trimEnd();
  if (header !== "") lines.push(header);
  lines.push(`// The code now lives in ./${path.basename(config.outDir)}/ (split by scripts/split/split-developer.ts); this file composes it and keeps the original export list.`);
  const importNames = new Map<string, boolean>();
  const foreign = new Map<string, Map<string, boolean>>();
  // What stays (the kept statements and the config's `stay` units) is emitted with its imports like any module.
  const stays = context.units.flatMap((unit, index) => (context.moduleOf[index] === ORIGINAL ? [index] : []));
  const uses = [...context.keptStatements.map((index) => context.useOfKept.get(index)), ...stays.map((index) => context.useOfUnit[index])];
  for (const use of uses) {
    for (const [name, asValue] of use?.imports ?? []) importNames.set(name, (importNames.get(name) ?? false) || asValue);
    for (const target of use?.units.keys() ?? []) if (context.moduleOf[target] !== ORIGINAL) addForeign(context, foreign, target);
  }
  const commentsDone = new Set<number>();
  if (config.preserveImportOrder) {
    // One bare import per module, with the comments that sat on the original import lines of it.
    const ordered = new Map<string, string[]>();
    context.importDeclarations.forEach((declaration, index) => {
      const specifier = (declaration.moduleSpecifier as ts.StringLiteral).text;
      // Type-only imports are erased; Node's and npm's own modules take no part in the repository's evaluation order.
      if (declaration.importClause?.isTypeOnly === true || !(specifier.startsWith(".") || specifier.startsWith("@agentx/"))) return;
      const comments = ordered.get(specifier) ?? [];
      const comment = context.importComments.get(index);
      if (comment !== undefined) { comments.push(comment); commentsDone.add(index); }
      ordered.set(specifier, comments);
    });
    if (ordered.size > 0) lines.push("// The file's own imports, first and in their old order, so every dependency loads exactly as it did before the split.");
    for (const [specifier, comments] of ordered) {
      lines.push(...comments);
      lines.push(`import ${JSON.stringify(specifier)};`);
    }
  }
  lines.push(...importLines(context, importNames, true, commentsDone));
  lines.push(...foreignImportLines(context, foreign, ORIGINAL));
  // Re-export every name the file exported, by module, in the config's module order.
  const byModule = new Map<string, string[]>();
  context.units.forEach((unit, index) => {
    if (!unit.exported || context.moduleOf[index] === ORIGINAL) return;
    const bucket = byModule.get(context.moduleOf[index] as string) ?? [];
    const typeOnly = unit.kind === "interface" || unit.kind === "type";
    for (const name of unit.names) bucket.push(typeOnly ? `type ${name}` : name);
    byModule.set(context.moduleOf[index] as string, bucket);
  });
  const reexports: string[] = [];
  for (const moduleName of context.moduleNames) {
    const bucket = byModule.get(moduleName);
    if (bucket === undefined) continue;
    reexports.push(`export {${bucket.length > 4 ? `\n  ${bucket.sort(compareExport).join(",\n  ")},\n` : ` ${bucket.sort(compareExport).join(", ")} `}} from ${JSON.stringify(`./${path.basename(config.outDir)}/${moduleName}.js`)};`);
  }
  lines.push(...reexports);
  lines.push("");
  // What stays: kept statements and `stay` units, in source order.
  const keep = [...context.keptStatements, ...stays.flatMap((index) => (context.units[index] as Unit).statements)].sort((a, b) => a - b);
  let first = true;
  let previous = -2;
  for (const statementIndex of keep) {
    const chunk = context.chunks[statementIndex] as Chunk;
    if (!first && (chunk.blankBefore || statementIndex !== previous + 1)) lines.push("");
    lines.push(statementText(context, statementIndex, false));
    first = false;
    previous = statementIndex;
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function compareExport(left: string, right: string): number {
  return compareText(left.replace(/^type /, ""), right.replace(/^type /, ""));
}

/** An import specifier as seen from a module in the new directory (or, with `inOriginal`, from the original file, whose directory is unchanged). */
function rewriteSpecifier(context: EmitContext, specifier: string, inOriginal: boolean): string {
  if (!specifier.startsWith(".") || inOriginal) return specifier;
  const originalDirectory = path.posix.dirname(context.config.source);
  const target = path.posix.join(originalDirectory, specifier);
  let relative = path.posix.relative(context.config.outDir, target);
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
}

/** The original file's import declarations, cut down to what a module uses, with paths made relative to the module's directory. */
function importLines(context: EmitContext, used: ReadonlyMap<string, boolean>, inOriginal: boolean, commentsDone: Set<number>): string[] {
  const lines: string[] = [];
  context.importDeclarations.forEach((declaration, index) => {
    const clause = declaration.importClause;
    if (clause === undefined) return;
    const wanted = [...context.bindings.values()].filter((binding) => binding.declaration === index && used.has(binding.local));
    if (wanted.length === 0) return;
    const specifier = JSON.stringify(rewriteSpecifier(context, (declaration.moduleSpecifier as ts.StringLiteral).text, inOriginal));
    const comment = context.importComments.get(index);
    if (comment !== undefined && !commentsDone.has(index)) { lines.push(comment); commentsDone.add(index); }
    // A binding is type-only here when the original import said so, or when this module only uses it in type positions.
    const typeOnly = (binding: ImportBinding): boolean => binding.typeOnly || used.get(binding.local) === false;
    const allTypes = wanted.every(typeOnly);
    const defaultBinding = wanted.find((binding) => binding.kind === "default");
    const namespaceBinding = wanted.find((binding) => binding.kind === "namespace");
    const named = wanted.filter((binding) => binding.kind === "named");
    const namedText = (inline: boolean): string => formatNamed(named.map((binding) => `${inline && typeOnly(binding) ? "type " : ""}${binding.imported === binding.local ? binding.local : `${binding.imported} as ${binding.local}`}`), 7 + specifier.length + 8);
    // `import type X, { a }` is not valid: a type-only default import and named imports are two statements.
    if (allTypes) {
      if (defaultBinding !== undefined) lines.push(`import type ${defaultBinding.local} from ${specifier};`);
      if (namespaceBinding !== undefined) lines.push(`import type * as ${namespaceBinding.local} from ${specifier};`);
      if (named.length > 0) lines.push(`import type ${namedText(false)} from ${specifier};`);
      return;
    }
    const parts: string[] = [];
    if (defaultBinding !== undefined) parts.push(defaultBinding.local);
    if (namespaceBinding !== undefined) parts.push(`* as ${namespaceBinding.local}`);
    if (named.length > 0) parts.push(namedText(true));
    lines.push(`import ${parts.join(", ")} from ${specifier};`);
  });
  return lines;
}

function formatNamed(elements: readonly string[], budgetOffset: number): string {
  const inline = `{ ${elements.join(", ")} }`;
  if (inline.length + budgetOffset <= 160) return inline;
  return `{\n  ${elements.join(",\n  ")},\n}`;
}

/** Records that a module uses a declaration that now lives in another module. */
function addForeign(context: EmitContext, foreign: Map<string, Map<string, boolean>>, target: number): void {
  const unit = context.units[target] as Unit;
  const other = context.moduleOf[target] as string;
  const bucket = foreign.get(other) ?? new Map<string, boolean>();
  for (const name of unit.names) bucket.set(name, unit.kind === "interface" || unit.kind === "type");
  foreign.set(other, bucket);
}

/** Imports from the other new modules: only what this module uses, written as type-only when it is a type. */
function foreignImportLines(context: EmitContext, foreign: ReadonlyMap<string, ReadonlyMap<string, boolean>>, ownModule: string): string[] {
  const lines: string[] = [];
  for (const moduleName of context.moduleNames) {
    const bucket = foreign.get(moduleName);
    if (bucket === undefined || moduleName === ownModule) continue;
    const elements = [...bucket].sort(([left], [right]) => compareText(left, right)).map(([name, typeOnly]) => (typeOnly ? `type ${name}` : name));
    const specifier = ownModule === ORIGINAL ? `./${path.basename(context.config.outDir)}/${moduleName}.js` : `./${moduleName}.js`;
    const allTypes = [...bucket.values()].every(Boolean);
    const shown = allTypes ? elements.map((element) => element.replace(/^type /, "")) : elements;
    lines.push(`import ${allTypes ? "type " : ""}${formatNamed(shown, specifier.length + 20)} from ${JSON.stringify(specifier)};`);
  }
  return lines;
}
