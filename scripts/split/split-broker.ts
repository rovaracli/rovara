// Splits packages/broker/src/aws/broker.ts into feature modules under packages/broker/src/aws/broker/ without changing what it does.
//
//   node scripts/split/split-broker.ts [--root <checkout>] [--dry-run] [--check] [--force] [--manifest <file.json>] [--reference <manifest.json>] [--config <module.ts>] [--json]
//
// What it does: reads the source with the TypeScript compiler API (no ts-morph, nothing new to install; `typescript` is already a dev dependency), assigns every top-level
// declaration to a module by *anchors* (scripts/split/broker-config.ts: "from this declaration up to the next anchor"), moves the text of each declaration unchanged (comments
// included), adds `export` only where another module needs the declaration, writes each module's imports (external imports filtered to what the module uses; type-only where it
// only uses types, so no runtime edge is added), and rewrites broker.ts as: a bare import of every original import in its original order (so the files load exactly in the
// order they did before: startup registrations keep their sequence), then its own named imports, re-exports of its public names, and the declarations that must stay.
//
// Configs, as in split-developer.ts: broker-config.ts holds only names that exist in the public repository AND in Rovara Cloud; names only Rovara Cloud has go in an overlay,
// broker-config.private.ts (exports OVERLAYS), which is kept out of the public repository and merged in when the file exists. --config <module> uses a module exporting CONFIGS
// instead (no overlay). Nothing is written to the repository besides the split itself: the placement manifest is written only where --manifest says (and it names every
// symbol, so it stays in Rovara Cloud); --reference compares a dry run with a manifest made earlier.
//
// What it never does: rename a symbol, edit a body, or reorder declarations within a module (source order is kept, so initialisation order of constants is kept).
// It refuses (exit 2, nothing written; --dry-run reports the same refusals and exits 2 too, so a dry run predicts the real run) when a move would change behaviour or cannot be placed:
//   - a `let` (mutable module state) used from a module other than its own,
//   - a constant, class or enum whose initialiser reads (at import time) a constant from a module that can be in an import cycle with it, or calls a function that does,
//   - a declaration that stays in broker.ts but is needed by a moved one (broker.ts is the composition root; modules never import it),
//   - a top-level statement that is not a declaration (it would run after all module code) unless it sits in the part that stays,
//   - an anchor, override or kept symbol it cannot find, or a target folder that already has files.
//
// Idempotent: broker.ts carries a marker (and the list of module files) after the split; running again prints "already split" and exits 0 without touching anything. `--check` only
// answers that question (exit 0 split and complete, 1 not split, 2 marker present but a listed module file is missing). Without the marker, existing files in the target folder
// stop the run (--force clears the folder first). Check the load order with scripts/split/check-load-order.ts.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export interface SplitModule { name: string; from?: string; description: string }
/** `from` is left out for a module that only receives `overrides`. */
export interface SplitConfig {
  source: string;
  outDir: string;
  marker: string;
  headerPrefix: string;
  maxLines: number;
  keepFrom: string | undefined;
  modules: SplitModule[];
  overrides: Record<string, string>;
  /** Tests that list the broker's source files in an array (a scan over them): the entry for broker.ts becomes the whole set. */
  testsListingSourceFiles: string[];
  /** The helper the patched tests import (it is written by the split). */
  testHelper: string;
}
/** What a private checkout adds to the shared config: anchors of modules only it has, more overrides. `moduleOrder` is the order of every module (it sets the order tests read the files in). */
export interface ConfigOverlay { modules: SplitModule[]; overrides?: Record<string, string>; moduleOrder?: string[] }

/** The shared config with an overlay added. Names are only ever added. */
export function mergeConfig(shared: SplitConfig, overlay: ConfigOverlay | undefined): SplitConfig {
  if (overlay === undefined) return shared;
  const modules = [...shared.modules];
  for (const entry of overlay.modules) {
    const known = modules.findIndex((module) => module.name === entry.name);
    if (known === -1) modules.push(entry);
    else throw new Error(`the overlay redefines the shared module ${entry.name}`);
  }
  const order = overlay.moduleOrder ?? modules.map((module) => module.name);
  const missing = modules.filter((module) => !order.includes(module.name)).map((module) => module.name);
  if (missing.length > 0) throw new Error(`moduleOrder lacks: ${missing.join(", ")}`);
  const ordered = order.flatMap((name) => modules.filter((module) => module.name === name));
  return { ...shared, modules: ordered, overrides: { ...shared.overrides, ...overlay.overrides } };
}


export const KEEP = "@keep";
export const MODULES_LINE = "split-modules:";

interface ImportBinding { local: string; imported: string | undefined; kind: "named" | "default" | "namespace"; typeOnly: boolean }
interface ImportDecl { index: number; specifier: string; declarationTypeOnly: boolean; bindings: ImportBinding[]; sideEffect: boolean; start: number; end: number; node: ts.ImportDeclaration }
interface Decl {
  index: number;
  node: ts.Statement;
  names: string[];
  kind: "function" | "class" | "interface" | "type" | "enum" | "variable" | "other";
  isLet: boolean;
  exported: boolean;
  /** Where the text starts (first leading comment, or the statement) and ends (including a same-line trailing comment). */
  spanStart: number;
  spanEnd: number;
  nodeStart: number;
  module: string;
  uses: Map<string, { value: boolean; eager: boolean }>;
  imports: Map<string, { value: boolean }>;
}
export interface Plan {
  sourcePath: string;
  decls: Decl[];
  imports: ImportDecl[];
  modules: Map<string, Decl[]>;
  keep: Decl[];
  problems: string[];
  notes: string[];
  exportsNeeded: Set<number>;
  text: string;
  anchorsMissing: string[];
  overridesMissing: string[];
}

const typeKinds = new Set(["interface", "type"]);

function leadingSpanStart(text: string, node: ts.Node): number {
  const comments = ts.getLeadingCommentRanges(text, node.getFullStart());
  const first = comments?.[0];
  return first === undefined ? node.getStart() : first.pos;
}

function trailingSpanEnd(text: string, node: ts.Node): number {
  const comments = ts.getTrailingCommentRanges(text, node.getEnd());
  const last = comments?.[comments.length - 1];
  return last === undefined ? node.getEnd() : last.end;
}

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) { out.push(name.text); return; }
  for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
}

function describeStatement(node: ts.Statement): { names: string[]; kind: Decl["kind"]; isLet: boolean } | undefined {
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) return { names: [node.name.text], kind: "function", isLet: false };
  if (ts.isClassDeclaration(node) && node.name !== undefined) return { names: [node.name.text], kind: "class", isLet: false };
  if (ts.isInterfaceDeclaration(node)) return { names: [node.name.text], kind: "interface", isLet: false };
  if (ts.isTypeAliasDeclaration(node)) return { names: [node.name.text], kind: "type", isLet: false };
  if (ts.isEnumDeclaration(node)) return { names: [node.name.text], kind: "enum", isLet: false };
  if (ts.isVariableStatement(node)) {
    const names: string[] = [];
    for (const declaration of node.declarationList.declarations) bindingNames(declaration.name, names);
    return { names, kind: "variable", isLet: (node.declarationList.flags & ts.NodeFlags.Const) === 0 };
  }
  return undefined;
}

const FUNCTION_LIKE = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
]);

/** Whether an identifier sits where only a type is read (no runtime reference), and whether it runs when the module loads. */
function usePosition(id: ts.Identifier, statement: ts.Statement): { value: boolean; eager: boolean } {
  let inType = false;
  let deferred = false;
  for (let node: ts.Node = id; node !== statement; node = node.parent) {
    const parent: ts.Node = node.parent;
    if (ts.isExpressionWithTypeArguments(parent)) {
      const heritage = parent.parent;
      if (ts.isHeritageClause(heritage)) {
        if (heritage.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(heritage.parent)) inType = true;
      }
    }
    if (ts.isTypeNode(parent) && !ts.isExpressionWithTypeArguments(parent)) inType = true;
    if (FUNCTION_LIKE.has(parent.kind) && node !== (parent as ts.FunctionLikeDeclaration).name) deferred = true;
    if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
      // A class's static fields and static blocks run when the class is defined; everything else in it runs later.
      const runsAtDefinition = ts.isClassStaticBlockDeclaration(node) || ((ts.isPropertyDeclaration(node)) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false));
      if (ts.isClassElement(node) && !runsAtDefinition) deferred = true;
    }
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) inType = true;
  }
  const value = !inType;
  // Constants, classes (heritage, static fields, static blocks) and enums (member initialisers) read what they name while the module loads.
  const eager = value && !deferred && (ts.isVariableStatement(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement));
  return { value, eager };
}

function topLevelOf(declaration: ts.Declaration, sf: ts.SourceFile): ts.Node | undefined {
  let node: ts.Node = declaration;
  while (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) node = node.parent;
  if (ts.isVariableDeclaration(node)) node = node.parent.parent;
  return node.parent === sf ? node : undefined;
}

export function readPlan(sourcePath: string, config: SplitConfig): Plan {
  const text = readFileSync(sourcePath, "utf8");
  const program = ts.createProgram({
    rootNames: [sourcePath],
    options: { noResolve: true, noLib: true, types: [], skipLibCheck: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true },
  });
  const sf = program.getSourceFile(sourcePath);
  if (sf === undefined) throw new Error(`cannot read ${sourcePath}`);
  const checker = program.getTypeChecker();
  const problems: string[] = [];
  const notes: string[] = [];

  const imports: ImportDecl[] = [];
  const decls: Decl[] = [];
  const declByName = new Map<string, Decl>();
  const importByLocal = new Map<string, { decl: ImportDecl; binding: ImportBinding }>();

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const bindings: ImportBinding[] = [];
      if (clause !== undefined) {
        if (clause.name !== undefined) bindings.push({ local: clause.name.text, imported: undefined, kind: "default", typeOnly: clause.isTypeOnly });
        const named = clause.namedBindings;
        if (named !== undefined && ts.isNamespaceImport(named)) bindings.push({ local: named.name.text, imported: undefined, kind: "namespace", typeOnly: clause.isTypeOnly });
        if (named !== undefined && ts.isNamedImports(named)) {
          for (const element of named.elements) bindings.push({ local: element.name.text, imported: element.propertyName?.text, kind: "named", typeOnly: clause.isTypeOnly || element.isTypeOnly });
        }
      }
      const decl: ImportDecl = {
        index: imports.length,
        specifier: (statement.moduleSpecifier as ts.StringLiteral).text,
        declarationTypeOnly: clause?.isTypeOnly ?? false,
        bindings,
        sideEffect: clause === undefined,
        start: leadingSpanStart(text, statement),
        end: trailingSpanEnd(text, statement),
        node: statement,
      };
      imports.push(decl);
      for (const binding of bindings) importByLocal.set(binding.local, { decl, binding });
      continue;
    }
    const described = describeStatement(statement);
    const decl: Decl = {
      index: decls.length,
      node: statement,
      names: described?.names ?? [],
      kind: described?.kind ?? "other",
      isLet: described?.isLet ?? false,
      exported: hasExportModifier(statement),
      spanStart: leadingSpanStart(text, statement),
      spanEnd: trailingSpanEnd(text, statement),
      nodeStart: statement.getStart(),
      module: KEEP,
      uses: new Map(),
      imports: new Map(),
    };
    decls.push(decl);
    for (const name of decl.names) {
      const earlier = declByName.get(name);
      if (earlier === undefined) declByName.set(name, decl);
      else notes.push(`${name} is declared twice (overload or merged declaration); both statements go to the module of the first`);
    }
  }

  // Assignment: anchors in source order; a statement belongs to the module of the nearest anchor at or before it.
  const anchorsMissing: string[] = [];
  const overridesMissing: string[] = [];
  const ranges: Array<{ index: number; module: string }> = [];
  for (const entry of config.modules) {
    if (entry.from === undefined) continue;
    const target = declByName.get(entry.from);
    if (target === undefined) { anchorsMissing.push(`${entry.name}: ${entry.from}`); continue; }
    if (ranges.some((range) => range.index === target.index)) { anchorsMissing.push(`${entry.name}: ${entry.from} (another module is anchored at the same declaration)`); continue; }
    ranges.push({ index: target.index, module: entry.name });
  }
  // The order of the config does not matter: each range starts where its anchor sits in this file.
  ranges.sort((a, b) => a.index - b.index);
  const keepFrom = config.keepFrom === undefined ? undefined : declByName.get(config.keepFrom);
  if (config.keepFrom !== undefined && keepFrom === undefined) anchorsMissing.push(`${KEEP}: ${config.keepFrom}`);
  for (const decl of decls) {
    let module = KEEP;
    for (const range of ranges) if (range.index <= decl.index) module = range.module;
    if (keepFrom !== undefined && decl.index >= keepFrom.index) module = KEEP;
    if (decl.kind === "other") module = KEEP;
    decl.module = module;
    if (decl.kind === "other" && (keepFrom === undefined || decl.index < keepFrom.index)) {
      problems.push(`line ${String(sf.getLineAndCharacterOfPosition(decl.nodeStart).line + 1)}: a top-level ${ts.SyntaxKind[decl.node.kind]} is not a declaration; left in broker.ts it would run after all the module code (and before it, moved): put it in the part that stays or move it by hand`);
    }
  }
  for (const [symbol, module] of Object.entries(config.overrides)) {
    const target = declByName.get(symbol);
    if (target === undefined) { overridesMissing.push(symbol); continue; }
    target.module = module;
  }
  for (const decl of decls) {
    for (const name of decl.names) {
      const first = declByName.get(name);
      if (first !== undefined && first !== decl && first.module !== decl.module) decl.module = first.module;
    }
  }
  for (const decl of decls) if (decl.kind !== "other" && decl.module === KEEP && decl.index < (ranges[0]?.index ?? 0)) notes.push(`${decl.names.join(",")} comes before the first anchor and stays in the source file`);

  // References: what each declaration reads from the file's own top level and from its imports.
  for (const decl of decls) {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const isDeclaringName = (ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent)) && parent.name === node && parent === decl.node;
        if (!isDeclaringName) {
          const symbol = ts.isShorthandPropertyAssignment(parent) && parent.name === node ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
          const declaration = symbol?.declarations?.[0];
          if (symbol !== undefined && declaration !== undefined) {
            if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
              const position = usePosition(node, decl.node);
              const known = decl.imports.get(symbol.name);
              decl.imports.set(symbol.name, { value: (known?.value ?? false) || position.value });
            } else if (symbol.declarations?.some((d) => topLevelOf(d, sf) !== undefined) === true) {
              const position = usePosition(node, decl.node);
              const known = decl.uses.get(symbol.name);
              decl.uses.set(symbol.name, { value: (known?.value ?? false) || position.value, eager: (known?.eager ?? false) || position.eager });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(decl.node, visit);
  }
  return { sourcePath, decls, imports, modules: new Map(), keep: [], problems, notes, exportsNeeded: new Set(), text, anchorsMissing, overridesMissing };
}

/** Everything that has to be true for the split to be a pure move; fills plan.problems. */
export function analyse(plan: Plan, config: SplitConfig): void {
  const byName = new Map<string, Decl>();
  for (const decl of plan.decls) for (const name of decl.names) if (!byName.has(name)) byName.set(name, decl);
  for (const decl of plan.decls) {
    const list = plan.modules.get(decl.module) ?? [];
    list.push(decl);
    plan.modules.set(decl.module, list);
  }
  plan.keep = plan.modules.get(KEEP) ?? [];
  plan.modules.delete(KEEP);
  for (const name of plan.modules.keys()) {
    if (!config.modules.some((entry) => entry.name === name)) plan.problems.push(`override names a module the config does not define: ${name}`);
  }

  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    const set = edges.get(from) ?? new Set<string>();
    set.add(to);
    edges.set(from, set);
  };
  const eagerEdges: Array<{ from: Decl; name: string; to: Decl }> = [];
  for (const decl of plan.decls) {
    for (const [name, use] of decl.uses) {
      const target = byName.get(name);
      if (target === undefined || target.module === decl.module) continue;
      if (target.module === KEEP) {
        plan.problems.push(`${decl.names.join(",")} (module ${decl.module}) needs ${name}, which stays in the source file; move it to a module (override) or its user to the source`);
        continue;
      }
      plan.exportsNeeded.add(target.index);
      if (use.value) addEdge(decl.module, target.module);
      if (use.eager) eagerEdges.push({ from: decl, name, to: target });
      if (target.isLet) plan.problems.push(`${name} is mutable module state (let) declared in ${target.module} but used from ${decl.module}: keep every user in one module`);
    }
  }
  // Cycles: Tarjan over the runtime import edges between modules (the source file only imports modules; none imports it).
  const names = [...plan.modules.keys()];
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const component = new Map<string, number>();
  let counter = 0;
  let components = 0;
  const strong = (node: string): void => {
    indexOf.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!indexOf.has(next)) { strong(next); low.set(node, Math.min(low.get(node)!, low.get(next)!)); }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, indexOf.get(next)!));
    }
    if (low.get(node) === indexOf.get(node)) {
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.set(member, components);
        if (member === node) break;
      }
      components += 1;
    }
  };
  for (const node of names) if (!indexOf.has(node)) strong(node);
  for (const edge of eagerEdges) {
    if (component.get(edge.from.module) !== component.get(edge.to.module)) continue;
    if (edge.to.kind !== "function") {
      plan.problems.push(`${edge.from.names.join(",")} (module ${edge.from.module}) reads ${edge.name} (module ${edge.to.module}) when the module loads, and those modules import each other (directly or not): move ${edge.name} next to its reader or to a leaf module`);
      continue;
    }
    // A function is hoisted, but calling it while the module loads runs its body: refuse if that body reads a constant of a module in the same cycle (one level deep).
    for (const [inner, innerUse] of edge.to.uses) {
      const reached = byName.get(inner);
      if (reached === undefined || !innerUse.value || reached.kind === "function" || typeKinds.has(reached.kind) || reached.module === edge.to.module) continue;
      if (component.get(reached.module) === component.get(edge.from.module)) {
        plan.problems.push(`${edge.from.names.join(",")} (module ${edge.from.module}) calls ${edge.name} when the module loads, and ${edge.name} reads ${inner} (module ${reached.module}) from the same import cycle`);
      }
    }
  }
  const sizes = new Map<number, number>();
  for (const member of names) sizes.set(component.get(member)!, (sizes.get(component.get(member)!) ?? 0) + 1);
  const cyclic = [...sizes.values()].filter((size) => size > 1);
  if (cyclic.length > 0) plan.notes.push(`import cycles between modules: ${String(cyclic.length)} group(s) of ${cyclic.join(", ")} modules (functions only; no load-time constant crosses them)`);

  // A declaration the source keeps is read by what moved? Already a problem above. A declaration exported by the source stays exported by the source (re-export below).
  // Types: an exported declaration's signature may name same-module types; export those too so declaration emit can name them.
  let changed = true;
  while (changed) {
    changed = false;
    for (const decl of plan.decls) {
      const exposed = decl.exported || plan.exportsNeeded.has(decl.index);
      if (!exposed || decl.module === KEEP) continue;
      for (const name of decl.uses.keys()) {
        const target = byName.get(name);
        if (target !== undefined && target.module === decl.module && typeKinds.has(target.kind) && !target.exported && !plan.exportsNeeded.has(target.index)) {
          plan.exportsNeeded.add(target.index);
          changed = true;
        }
      }
    }
  }
}

function relativeSpecifier(specifier: string, sourceDir: string, targetDir: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const relative = path.posix.relative(path.posix.resolve("/", targetDir), path.posix.resolve("/", sourceDir, specifier));
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** One import statement for a module: only the names it reads; `type` wherever it reads a name only as a type (consistent-type-imports). */
function formatImport(decl: ImportDecl, used: Map<string, boolean>, specifier: string): string | undefined {
  const bindings = decl.bindings.filter((binding) => used.has(binding.local));
  if (bindings.length === 0) return undefined;
  const isValue = (binding: ImportBinding): boolean => used.get(binding.local) === true;
  const allType = bindings.every((binding) => !isValue(binding));
  // An import whose every name was already inline-`type` still loaded the module at run time; keep that edge instead of turning it into `import type`.
  const keepsRuntimeEdge = !decl.declarationTypeOnly && decl.bindings.every((binding) => binding.typeOnly);
  const typeStatement = allType && !keepsRuntimeEdge;
  const clause: string[] = [];
  const named: string[] = [];
  for (const binding of bindings) {
    if (binding.kind === "default") clause.push(binding.local);
    else if (binding.kind === "namespace") clause.push(`* as ${binding.local}`);
    else {
      const label = binding.imported === undefined ? binding.local : `${binding.imported} as ${binding.local}`;
      named.push(!typeStatement && !isValue(binding) ? `type ${label}` : label);
    }
  }
  if (named.length > 0) clause.push(`{ ${named.join(", ")} }`);
  return `import ${typeStatement ? "type " : ""}${clause.join(", ")} from "${specifier}";`;
}

export interface Output { files: Map<string, string>; counts: Map<string, number>; exports: Map<string, string[]>; order: string[] }

function declText(plan: Plan, decl: Decl, withExport: boolean): string {
  const before = plan.text.slice(decl.spanStart, decl.nodeStart);
  const body = plan.text.slice(decl.nodeStart, decl.spanEnd);
  return `${before}${withExport && !decl.exported ? "export " : ""}${body}`;
}

function joinDecls(plan: Plan, list: Decl[], exportedNow: (decl: Decl) => boolean): string {
  let out = "";
  let previous: Decl | undefined;
  for (const decl of list) {
    if (previous !== undefined) {
      const gap = previous.index + 1 === decl.index ? plan.text.slice(previous.spanEnd, decl.spanStart) : "";
      out += /^\s*$/.test(gap) && gap.length > 0 ? (gap.split("\n").length > 2 ? "\n\n" : "\n") : "\n\n";
    }
    out += declText(plan, decl, exportedNow(decl));
    previous = decl;
  }
  return out;
}

export function render(plan: Plan, config: SplitConfig): Output {
  const sourceDir = path.posix.dirname(config.source);
  const files = new Map<string, string>();
  const counts = new Map<string, number>();
  const reexports = new Map<string, { values: string[]; types: string[] }>();
  const byName = new Map<string, Decl>();
  for (const decl of plan.decls) for (const name of decl.names) if (!byName.has(name)) byName.set(name, decl);

  const importsFor = (list: Decl[], here: string): string[] => {
    const lines: string[] = [];
    const targetDir = here === KEEP ? sourceDir : config.outDir;
    // External imports: original order and spelling, filtered to what this module reads.
    const useOf = new Map<string, boolean>();
    for (const decl of list) for (const [name, use] of decl.imports) useOf.set(name, (useOf.get(name) ?? false) || use.value);
    for (const imported of plan.imports) {
      if (imported.sideEffect) continue;
      const used = new Map<string, boolean>();
      for (const binding of imported.bindings) if (useOf.has(binding.local)) used.set(binding.local, useOf.get(binding.local)!);
      const line = formatImport(imported, used, relativeSpecifier(imported.specifier, sourceDir, targetDir));
      if (line !== undefined) lines.push(line);
    }
    // Siblings: what this module reads from other modules.
    const wanted = new Map<string, Map<string, boolean>>();
    for (const decl of list) {
      for (const [name, use] of decl.uses) {
        const target = byName.get(name);
        if (target === undefined || target.module === here || target.module === KEEP) continue;
        const forModule = wanted.get(target.module) ?? new Map<string, boolean>();
        forModule.set(name, (forModule.get(name) ?? false) || (use.value && !typeKinds.has(target.kind)));
        wanted.set(target.module, forModule);
      }
    }
    for (const module of [...wanted.keys()].sort()) {
      const entries = [...wanted.get(module)!.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
      const values = entries.filter(([, value]) => value).map(([name]) => name);
      const types = entries.filter(([, value]) => !value).map(([name]) => name);
      const from = here === KEEP ? `./${path.posix.relative(sourceDir, config.outDir)}/${module}.js` : `./${module}.js`;
      if (values.length > 0) lines.push(`import { ${[...values, ...types.map((name) => `type ${name}`)].join(", ")} } from "${from}";`);
      else lines.push(`import type { ${types.join(", ")} } from "${from}";`);
    }
    return lines;
  };

  for (const [module, list] of plan.modules) {
    const description = config.modules.find((entry) => entry.name === module)?.description ?? "";
    const exportedNow = (decl: Decl): boolean => plan.exportsNeeded.has(decl.index) || decl.exported;
    const header = `// ${config.headerPrefix} ${description}\n`;
    const importLines = importsFor(list, module);
    const body = joinDecls(plan, list, exportedNow);
    files.set(path.posix.join(config.outDir, `${module}.ts`), `${header}${importLines.length > 0 ? `\n${importLines.join("\n")}\n` : ""}\n${body}\n`);
    counts.set(module, (`${header}${importLines.join("\n")}\n${body}\n`).split("\n").length);
    for (const decl of list) {
      if (!decl.exported) continue;
      const entry = reexports.get(module) ?? { values: [], types: [] };
      for (const name of decl.names) (typeKinds.has(decl.kind) ? entry.types : entry.values).push(name);
      reexports.set(module, entry);
    }
  }

  // The source file: markers, the imports that must stay in place, imports of the modules it composes, re-exports of its public names, then what stays.
  const order = config.modules.map((entry) => entry.name).filter((name) => plan.modules.has(name));
  const out: string[] = [`// ${config.marker}`, `// ${MODULES_LINE} ${order.join(", ")}`, ""];
  // Load order: one bare import per original import, in the original order (a side-effect import keeps its comment), so every file the old broker.ts loaded loads in the sequence it
  // did, and what registers itself at load (member movers, home-card sources, approver rules) registers in the same order. Imports of this checkout's modules come after them.
  const prelude = new Set<string>();
  out.push("// The file's own imports, first and in their old order, so every dependency loads exactly as it did before the split.");
  for (const imported of plan.imports) {
    if (imported.declarationTypeOnly || prelude.has(imported.specifier)) continue;
    prelude.add(imported.specifier);
    const spelled = relativeSpecifier(imported.specifier, sourceDir, sourceDir);
    const comment = plan.text.slice(imported.start, imported.node.getStart()).trimEnd();
    if (comment !== "") out.push(comment);
    out.push(`import "${spelled}";`);
  }
  out.push(...importsFor(plan.keep, KEEP));
  const exportLines: string[] = [];
  for (const [module, entry] of [...reexports.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const from = `./${path.posix.relative(sourceDir, config.outDir)}/${module}.js`;
    if (entry.values.length > 0) exportLines.push(`export { ${entry.values.join(", ")} } from "${from}";`);
    if (entry.types.length > 0) exportLines.push(`export type { ${entry.types.join(", ")} } from "${from}";`);
  }
  const keepBody = joinDecls(plan, plan.keep, () => false);
  files.set(config.source, `${out.join("\n")}\n${exportLines.length > 0 ? `${exportLines.join("\n")}\n` : ""}\n${keepBody}\n`);
  counts.set(KEEP, files.get(config.source)!.split("\n").length);
  const exportsOut = new Map<string, string[]>();
  for (const [module, entry] of reexports) exportsOut.set(module, [...entry.values, ...entry.types]);
  return { files, counts, exports: exportsOut, order };
}

// Companion edits to the tests. Some tests read broker.ts as text (a call that must be present, an order, a function's body) or list it among the files they scan; once the code is in
// several files they must read all of them. This rewrites exactly three shapes, in files that name aws/broker.ts, and reports every other mention for a human to look at:
//   readFileSync(<expression naming aws/broker.ts>, "utf8")        -> readBrokerSource()                  (tests/support/broker-source.ts, written here)
//   ["aws/broker.ts", "<function>" ...                              -> ["aws/broker/<module>.ts", "<function>" ...   (the owner-read inventory's rows, by where the function went)
//   "packages/broker/src/aws/broker.ts" in a file the config lists  -> ...brokerSourceFiles()
const READ_SOURCE = /readFileSync\([^;\n]*?aws\/broker\.ts[^;\n]*?,\s*"utf8"\s*\)/g;

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

export interface TestPatch { file: string; content: string; changes: string[] }

export function patchTests(root: string, config: SplitConfig, manifest: Record<string, string>): { patches: TestPatch[]; review: string[] } {
  const patches: TestPatch[] = [];
  const review: string[] = [];
  const helperRel = (file: string): string => {
    const relative = path.posix.relative(path.posix.dirname(file), config.testHelper.replace(/\.ts$/, ".js"));
    return relative.startsWith(".") ? relative : `./${relative}`;
  };
  const testsDir = path.join(root, "tests");
  if (!existsSync(testsDir)) return { patches, review };
  for (const full of testFiles(testsDir)) {
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (rel === config.testHelper) continue;
    let content = readFileSync(full, "utf8");
    if (!content.includes("aws/broker.ts")) {
      if (/["'`]broker\.ts["'`]/.test(content)) review.push(`${rel}: names "broker.ts" as a file name (built into a path?); look at what it reads`);
      continue;
    }
    const original = content;
    const changes: string[] = [];
    const needs = new Set<string>();
    content = content.replace(READ_SOURCE, () => { changes.push("readFileSync(broker.ts) -> readBrokerSource()"); needs.add("readBrokerSource"); return "readBrokerSource()"; });
    content = content.replace(/\["aws\/broker\.ts", "([A-Za-z0-9_$]+)/g, (whole, name: string) => {
      const module = manifest[name];
      if (module === undefined || module === KEEP) { review.push(`${rel}: row for ${name} left on aws/broker.ts (${module === undefined ? "not found in the split" : "stays in broker.ts"})`); return whole; }
      changes.push(`row ${name} -> aws/broker/${module}.ts`);
      return `["aws/broker/${module}.ts", "${name}`;
    });
    if (config.testsListingSourceFiles.includes(rel)) {
      content = content.replace(/"packages\/broker\/src\/aws\/broker\.ts"(,?)/g, (_whole, comma: string) => { changes.push("source list -> ...brokerSourceFiles()"); needs.add("brokerSourceFiles"); return `...brokerSourceFiles()${comma}`; });
    }
    if (needs.size > 0) {
      const names = [...needs].sort().join(", ");
      const imports = [...content.matchAll(/^import [^\n]*;$/gm)];
      const last = imports[imports.length - 1];
      const at = last === undefined ? 0 : last.index + last[0].length;
      content = `${content.slice(0, at)}\nimport { ${names} } from "${helperRel(rel)}";${content.slice(at)}`;
      // readFileSync that nothing reads any more must leave its import (no-unused-vars).
      // The same for a `join` that only built the path just replaced.
      if (!/(?<![.\w])join\(/.test(content)) content = content.replace(/import \{ join \} from "node:path";\n/, "").replace(/\bjoin, /, "").replace(/, join\b/, "");
      if (!/(?<![.\w])readFileSync\(/.test(content)) content = content.replace(/^[ \t]*const \{ readFileSync \} = await import\("node:fs"\);\n/gm, "");
      if (!/\breadFileSync\(/.test(content)) content = content.replace(/import \{ readFileSync \} from "node:fs";\n/, "").replace(/\breadFileSync, /, "").replace(/, readFileSync\b/, "");
    }
    if (content !== original) patches.push({ file: rel, content, changes });
    const mentions = (content.match(/aws\/broker\.ts/g) ?? []).length;
    if (mentions > 0) review.push(`${rel}: still names aws/broker.ts ${String(mentions)} time(s) (a path, a comment or a deploy entry; check it is still right)`);
  }
  return { patches, review };
}

const helperSource = (order: readonly string[], config: SplitConfig): string => `// The broker's source as one text, for the tests that pin what the code says (a call that must be present, an order of two calls, a function's body). packages/broker/src/aws/broker.ts
// was split into broker.ts and the modules in packages/broker/src/aws/broker/ (scripts/split/split-broker.ts); the modules come first, in the order the one file had them, then broker.ts
// (the part that builds the Lambda's clients and the handler, which was at the end).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = "${config.outDir}";
const SOURCE = "${config.source}";
/** The modules in the order the original file had their parts (written by the split; a module file not listed comes after them, by name). */
const ORDER = ${JSON.stringify(order)};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The broker's source files (paths from the repository root) in the order the original single file had their parts. */
export function brokerSourceFiles(): string[] {
  const folder = path.join(ROOT, OUT_DIR);
  const present = new Set(readdirSync(folder).filter((name) => name.endsWith(".ts")));
  const ordered = ORDER.map((name) => \`\${name}.ts\`).filter((name) => present.delete(name));
  const rest = [...present].sort();
  return [...[...ordered, ...rest].map((name) => \`\${OUT_DIR}/\${name}\`), SOURCE];
}

/** All of it, as one string. */
export function readBrokerSource(): string {
  return brokerSourceFiles().map((file) => readFileSync(path.join(ROOT, file), "utf8")).join("\\n");
}
`;

export interface Report {
  status: "applied" | "dry-run" | "already-split" | "refused" | "not-split" | "split-complete" | "split-incomplete";
  lines: string[];
  problems: string[];
  manifest?: Record<string, string>;
}

export function manifestOf(plan: Plan): Record<string, string> {
  const manifest: Record<string, string> = {};
  for (const decl of plan.decls) for (const name of decl.names) manifest[name] = decl.module;
  return manifest;
}

/** What --manifest writes and --reference reads: for the source file, every declaration name and the file it lands in (the shape split-developer.ts writes, so compare-manifests.ts reads both). */
export function manifestFile(config: SplitConfig, flat: Record<string, string>): Record<string, Record<string, string>> {
  return { [config.source]: Object.fromEntries(Object.entries(flat).map(([name, module]) => [name, module === KEEP ? config.source : `${config.outDir}/${module}.ts`])) };
}

/** The shared config, with the private overlay merged in when this checkout has one; --config <module> uses that module's CONFIGS.broker alone. */
export async function loadBrokerConfig(here: string, configPath?: string): Promise<SplitConfig> {
  if (configPath !== undefined) return ((await import(pathToFileURL(path.resolve(configPath)).href)) as { CONFIGS: Record<string, SplitConfig> }).CONFIGS["broker"]!;
  const { CONFIGS } = (await import(pathToFileURL(path.join(here, "broker-config.ts")).href)) as { CONFIGS: Record<string, SplitConfig> };
  const overlayFile = path.join(here, "broker-config.private.ts");
  if (!existsSync(overlayFile)) return CONFIGS["broker"]!;
  const { OVERLAYS } = (await import(pathToFileURL(overlayFile).href)) as { OVERLAYS: Record<string, ConfigOverlay> };
  return mergeConfig(CONFIGS["broker"]!, OVERLAYS["broker"]);
}

export async function run(argv: readonly string[], here: string): Promise<{ code: number; report: Report }> {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const option = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const root = path.resolve(option("--root") ?? process.cwd());
  const config = await loadBrokerConfig(here, option("--config"));
  const sourcePath = path.join(root, config.source);
  const outDir = path.join(root, config.outDir);
  const lines: string[] = [];
  const log = (line: string): void => { lines.push(line); };

  if (!existsSync(sourcePath)) {
    log(`no ${config.source} under ${root}`);
    return { code: 2, report: { status: "refused", lines, problems: [`missing ${config.source}`] } };
  }
  const original = readFileSync(sourcePath, "utf8");
  const marked = original.startsWith(`// ${config.marker}`);
  if (flags.has("--check")) {
    if (!marked) { log("not split: broker.ts has no split marker"); return { code: 1, report: { status: "not-split", lines, problems: [] } }; }
    // The modules the split wrote are listed in the marker (a checkout whose anchors folded together has fewer than the config names).
    const listed = original.split("\n").find((line) => line.startsWith(`// ${MODULES_LINE}`))?.slice(`// ${MODULES_LINE}`.length).split(",").map((name) => name.trim()).filter((name) => name !== "") ?? [];
    const missing = listed.map((name) => `${name}.ts`).filter((file) => !existsSync(path.join(outDir, file)));
    if (missing.length > 0 || listed.length === 0) { log(`marker present but module file(s) missing: ${listed.length === 0 ? "the marker lists none" : missing.join(", ")}`); return { code: 2, report: { status: "split-incomplete", lines, problems: missing } }; }
    log("split in place: marker present and every listed module file exists");
    return { code: 0, report: { status: "split-complete", lines, problems: [] } };
  }
  if (marked) {
    log("already split: broker.ts carries the split marker; nothing to do");
    return { code: 0, report: { status: "already-split", lines, problems: [] } };
  }
  const dry = flags.has("--dry-run");
  const problems: string[] = [];
  // Everything below that would stop a real run is a problem in a dry run too, so a dry run predicts the real one.
  if (!flags.has("--force") && existsSync(outDir) && readdirSync(outDir).length > 0) {
    problems.push(`${config.outDir} already has files and ${config.source} has no marker (a half-applied split?); remove them or pass --force`);
  }

  const plan = readPlan(sourcePath, config);
  analyse(plan, config);
  const output = render(plan, config);
  const total = plan.decls.length;
  log(`source ${config.source}: ${String(original.split("\n").length)} lines, ${String(total)} top-level statements`);
  for (const [module, list] of plan.modules) log(`  ${module}: ${String(list.length)} declarations, ${String(output.counts.get(module) ?? 0)} lines${(output.counts.get(module) ?? 0) > config.maxLines ? "  (OVER the size limit)" : ""}`);
  log(`  ${config.source} (stays): ${String(plan.keep.length)} declarations, ${String(output.counts.get(KEEP) ?? 0)} lines`);
  const kept = plan.keep.filter((decl) => decl.names.length > 0).map((decl) => decl.names.join(","));
  if (kept.length > 0 && kept.length <= 80) log(`  stays in ${config.source}: ${kept.join(", ")}`);
  for (const miss of plan.anchorsMissing) log(`ANCHOR MISSING (its range is merged into the previous module): ${miss}`);
  for (const miss of plan.overridesMissing) log(`OVERRIDE SYMBOL NOT FOUND: ${miss}`);
  for (const note of plan.notes) log(`note: ${note}`);

  const manifest = manifestOf(plan);
  const referenceFile = option("--reference");
  if (referenceFile !== undefined) {
    const known = (JSON.parse(readFileSync(referenceFile, "utf8")) as Record<string, Record<string, string>>)[config.source] ?? {};
    const here2 = manifestFile(config, manifest)[config.source]!;
    const added = Object.keys(here2).filter((name) => !(name in known));
    const gone = Object.keys(known).filter((name) => !(name in here2));
    const moved = Object.keys(here2).filter((name) => name in known && known[name] !== here2[name]);
    log(`compared with the reference placement (${path.basename(referenceFile)}): ${String(added.length)} symbol(s) new in this checkout (placed by range), ${String(gone.length)} reference symbol(s) absent, ${String(moved.length)} placed differently`);
    if (added.length > 0) log(`  new here: ${added.slice(0, 200).map((name) => `${name}->${here2[name]}`).join(", ")}${added.length > 200 ? ", ..." : ""}`);
    if (gone.length > 0) log(`  absent here: ${gone.slice(0, 200).join(", ")}${gone.length > 200 ? ", ..." : ""}`);
    if (moved.length > 0) log(`  placed differently: ${moved.slice(0, 200).map((name) => `${name}: ${known[name]} -> ${here2[name]}`).join(", ")}`);
  }
  problems.push(...plan.problems);
  if (plan.anchorsMissing.length > 0) problems.push(`anchors missing: ${plan.anchorsMissing.join("; ")}`);
  if (plan.overridesMissing.length > 0) problems.push(`override symbols missing: ${plan.overridesMissing.join(", ")}`);
  for (const problem of problems) log(`PROBLEM: ${problem}`);
  const tests = patchTests(root, config, manifest);
  log(`tests that read or list broker.ts: ${String(tests.patches.length)} file(s) ${dry ? "would be" : "are"} patched${tests.patches.length > 0 ? ` (${tests.patches.map((patch) => path.basename(patch.file)).join(", ")})` : ""}`);
  for (const line of tests.review) log(`review: ${line}`);
  const manifestPath = option("--manifest");
  if (manifestPath !== undefined) {
    writeFileSync(manifestPath, `${JSON.stringify(manifestFile(config, manifest), null, 2)}\n`);
    log(`placement manifest written to ${manifestPath} (it names every symbol: keep it out of the public repository)`);
  }
  if (dry) {
    log(problems.length === 0 ? "dry run: the split would apply cleanly" : `dry run: the split would be refused (${String(problems.length)} problem(s)); nothing written`);
    return { code: problems.length === 0 ? 0 : 2, report: { status: "dry-run", lines, problems, manifest } };
  }
  if (problems.length > 0) {
    log("refusing: nothing written");
    return { code: 2, report: { status: "refused", lines, problems } };
  }
  // --force starts from an empty folder: a module file an earlier run wrote and this one does not must not stay behind.
  if (existsSync(outDir)) for (const name of readdirSync(outDir)) rmSync(path.join(outDir, name), { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [file, content] of output.files) writeFileSync(path.join(root, file), content);
  mkdirSync(path.dirname(path.join(root, config.testHelper)), { recursive: true });
  writeFileSync(path.join(root, config.testHelper), helperSource(output.order, config));
  for (const patch of tests.patches) writeFileSync(path.join(root, patch.file), patch.content);
  log(`wrote ${String(output.files.size)} files`);
  return { code: 0, report: { status: "applied", lines, problems: [], manifest } };
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  const { code, report } = await run(process.argv.slice(2), path.dirname(path.resolve(entry)));
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${report.lines.join("\n")}\n`);
  process.exitCode = code;
}
