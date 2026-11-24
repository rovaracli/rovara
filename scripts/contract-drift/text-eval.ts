// Contract drift, text half (the reader): the current value of a string constant or a small pure template function in Rovara Code's source, read WITHOUT running Code. Code's sentences live in its broker and
// contracts files, whose imports (stores, AWS clients) cannot be loaded here, so the file is parsed with the TypeScript compiler and the one expression a rule names is evaluated by hand.
//
// What it understands: string and template literals, numbers, booleans, objects and arrays of those, `as const` / `satisfies`, property access, `+`, arrow functions with an expression body (or one `return`),
// calls of such a function, top-level `const`s of the same file and of files it imports with a relative path. Anything else throws `Unreadable`: a Code refactor that moves a constant out of reach fails the
// check loudly, so the rule is looked at again, instead of passing for a value nobody read.
import path from "node:path";
import ts from "typescript";

export class Unreadable extends Error {}

/** Reads a Code source file by its repository-relative path (`undefined` when the file does not exist). */
export type ReadCodeFile = (file: string) => string | undefined;

type Value = string | number | boolean | undefined | readonly Value[] | { readonly [key: string]: Value } | Fn;
interface Fn { readonly params: readonly string[]; readonly body: ts.Expression; readonly scope: Scope }
interface Scope { readonly file: string; readonly locals: ReadonlyMap<string, Value>; readonly parent?: Scope }

const parsed = new Map<string, ts.SourceFile>();

export function evaluateCodeExpression(read: ReadCodeFile, file: string, expression: string): Value {
  const scope = scopeOf(read, file, new Set());
  const source = ts.createSourceFile("expression.ts", `(${expression});`, ts.ScriptTarget.Latest, true);
  const statement = source.statements[0];
  if (statement === undefined || !ts.isExpressionStatement(statement)) throw new Unreadable(`not an expression: ${expression}`);
  return evaluate(read, statement.expression, scope, 0);
}

/** An evaluated value as the flat strings a rule checks: a string is itself; an object is one string per own member (`key`), nested members `key.inner`. */
export function flatten(value: Value, label: string): Record<string, string> {
  if (typeof value === "string") return { [label]: value };
  if (typeof value === "object" && value !== null && !Array.isArray(value) && !("params" in value && "body" in value)) {
    const out: Record<string, string> = {};
    for (const [key, inner] of Object.entries(value as Record<string, Value>)) Object.assign(out, flatten(inner, `${label}.${key}`));
    return out;
  }
  throw new Unreadable(`${label} is not a string or an object of strings`);
}

function scopeOf(read: ReadCodeFile, file: string, visiting: Set<string>): Scope {
  const text = read(file);
  if (text === undefined) throw new Unreadable(`Code has no file ${file}`);
  let source = parsed.get(`${file}\0${text.length}\0${hash(text)}`);
  if (source === undefined) {
    source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    parsed.set(`${file}\0${text.length}\0${hash(text)}`, source);
  }
  const locals = new Map<string, Value>();
  // `scope` is the object handed out below (its `locals` resolve lazily), so a function defined in this file sees the same names the caller does.
  const scope: Scope = { file, get locals() { return resolving; } };
  const lazy = new Map<string, () => Value>();
  const imports = new Map<string, { from: string; name: string }>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          const initializer = declaration.initializer;
          lazy.set(declaration.name.text, () => evaluate(read, initializer, scope, 0));
        }
      }
    } else if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings !== undefined && ts.isNamedImports(statement.importClause.namedBindings) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith(".")) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), statement.moduleSpecifier.text.replace(/\.js$/u, ".ts")));
      for (const element of statement.importClause.namedBindings.elements) imports.set(element.name.text, { from: target, name: (element.propertyName ?? element.name).text });
    }
  }
  // Top-level names resolve on first use, so the order of the constants in the file does not matter and an unreadable constant only fails the rule that needs it.
  const resolving: ReadonlyMap<string, Value> =
    new Proxy(locals, {
      get(target, property) {
        if (property === "get") return (name: string): Value => {
          if (target.has(name)) return target.get(name);
          const make = lazy.get(name);
          if (make !== undefined) { const value = make(); target.set(name, value); return value; }
          const imported = imports.get(name);
          if (imported !== undefined) {
            if (visiting.has(imported.from)) throw new Unreadable(`import cycle at ${imported.from}`);
            const inner = scopeOf(read, imported.from, new Set([...visiting, file]));
            return (inner.locals as { get(name: string): Value }).get(imported.name);
          }
          throw new Unreadable(`${name} is not a constant of ${file} (or not one this reader can follow)`);
        };
        if (property === "has") return (name: string): boolean => target.has(name) || lazy.has(name) || imports.has(name);
        const own = Reflect.get(target, property) as unknown;
        return typeof own === "function" ? (own as (...args: unknown[]) => unknown).bind(target) : own;
      },
    });
  return scope;
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return h;
}

function lookup(scope: Scope, name: string): Value {
  for (let at: Scope | undefined = scope; at !== undefined; at = at.parent) if (at.locals.has(name)) return at.locals.get(name);
  throw new Unreadable(`${name} is not defined in ${scope.file}`);
}

function evaluate(read: ReadCodeFile, node: ts.Node, scope: Scope, depth: number): Value {
  if (depth > 60) throw new Unreadable("expression too deep");
  const next = (inner: ts.Node, at: Scope = scope): Value => evaluate(read, inner, at, depth + 1);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) return next(node.expression);
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const inner = next(span.expression);
      if (typeof inner !== "string" && typeof inner !== "number" && typeof inner !== "boolean") throw new Unreadable(`a template part is not plain text in ${scope.file}`);
      out += String(inner) + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    const left = next(node.left), right = next(node.right);
    if (kind === ts.SyntaxKind.PlusToken) {
      if (typeof left === "number" && typeof right === "number") return left + right;
      if ((typeof left === "string" || typeof left === "number") && (typeof right === "string" || typeof right === "number")) return `${String(left)}${String(right)}`;
      throw new Unreadable(`+ of non-text in ${scope.file}`);
    }
    if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right;
    if (kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
    if (typeof left === "number" && typeof right === "number") {
      if (kind === ts.SyntaxKind.PercentToken) return left % right;
      if (kind === ts.SyntaxKind.SlashToken) return left / right;
      if (kind === ts.SyntaxKind.AsteriskToken) return left * right;
      if (kind === ts.SyntaxKind.MinusToken) return left - right;
    }
    throw new Unreadable(`an operator this reader does not follow in ${scope.file}`);
  }
  if (ts.isConditionalExpression(node)) {
    const condition = next(node.condition);
    if (typeof condition !== "boolean") throw new Unreadable(`a condition that is not true or false in ${scope.file}`);
    return next(condition ? node.whenTrue : node.whenFalse);
  }
  if (ts.isIdentifier(node)) return lookup(scope, node.text);
  if (ts.isPropertyAccessExpression(node)) return member(next(node.expression), node.name.text, scope);
  if (ts.isElementAccessExpression(node) && (ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression))) return member(next(node.expression), node.argumentExpression.text, scope);
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, Value> = {};
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) out[property.name.text] = next(property.initializer);
      else if (ts.isShorthandPropertyAssignment(property)) out[property.name.text] = lookup(scope, property.name.text);
      else throw new Unreadable(`an object member this reader does not follow in ${scope.file}`);
    }
    return out;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => next(element));
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const params = node.parameters.map((parameter) => (ts.isIdentifier(parameter.name) ? parameter.name.text : ""));
    if (params.includes("")) throw new Unreadable(`a destructured parameter in ${scope.file}`);
    let body: ts.Expression | undefined;
    if (ts.isBlock(node.body)) {
      const only = node.body.statements.length === 1 ? node.body.statements[0] : undefined;
      if (only !== undefined && ts.isReturnStatement(only) && only.expression !== undefined) body = only.expression;
    } else body = node.body;
    if (body === undefined) throw new Unreadable(`a function that is not one expression in ${scope.file}`);
    return { params, body, scope };
  }
  if (ts.isCallExpression(node)) {
    // The few built-ins Code's word builders use: Object.freeze(x), String(x), (n).toFixed(d).
    const called = node.expression;
    if (ts.isPropertyAccessExpression(called) && ts.isIdentifier(called.expression) && called.expression.text === "Object" && called.name.text === "freeze" && node.arguments.length === 1) return next(node.arguments[0]!);
    if (ts.isIdentifier(called) && called.text === "String" && node.arguments.length === 1 && !scope.locals.has("String")) {
      const plain = next(node.arguments[0]!);
      if (typeof plain === "string" || typeof plain === "number" || typeof plain === "boolean") return String(plain);
      throw new Unreadable(`String() of something that is not plain text in ${scope.file}`);
    }
    if (ts.isPropertyAccessExpression(called) && called.name.text === "toFixed" && node.arguments.length === 1) {
      const number = next(called.expression), digits = next(node.arguments[0]!);
      if (typeof number === "number" && typeof digits === "number") return number.toFixed(digits);
    }
    const callee = next(node.expression);
    if (typeof callee !== "object" || callee === null || !("params" in callee) || !("body" in callee)) throw new Unreadable(`a call of something this reader cannot run in ${scope.file}`);
    const fn = callee as Fn;
    const locals = new Map<string, Value>();
    fn.params.forEach((name, index) => locals.set(name, node.arguments[index] === undefined ? undefined : next(node.arguments[index])));
    return evaluate(read, fn.body, { file: fn.scope.file, locals, parent: fn.scope }, depth + 1);
  }
  throw new Unreadable(`${ts.SyntaxKind[node.kind]} in ${scope.file} is not something this reader follows`);
}

function member(owner: Value, name: string, scope: Scope): Value {
  if (typeof owner === "object" && owner !== null && !("params" in owner && "body" in owner) && name in (owner as object)) return (owner as Record<string, Value>)[name];
  throw new Unreadable(`no member ${name} in ${scope.file}`);
}
