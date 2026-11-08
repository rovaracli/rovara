/**
 * Reads a GitHub Actions expression the way one repository sees it.
 *
 * The workflow files live on both the public repository (PrepLabsAI/Rovara) and the private Cloud one (PrepLabsAI/Rovara-cloud). Cloud guards some of their
 * expressions with `github.repository == '...'` (a job that must never run there, a longer time limit for its slower runners). A contract test that pins a
 * workflow's `if` or `timeout-minutes` reads it with `forRepository(text, PUBLIC_REPOSITORY)` to get exactly what the public copy says, or with
 * CLOUD_REPOSITORY to get what Cloud runs. On a file with no repository guard the text comes back unchanged, so one test serves both copies.
 *
 * Only `github.repository` and `github.repository_owner` comparisons are decided; every other term is kept as written and the result is simplified around them: `true && x` is `x`,
 * `false && x` is `false`, and `a && 40 || 25` is the number it evaluates to. Parentheses are kept only where precedence needs them. `x || false` and `x && true` are read as `x` (the file's conditions are booleans).
 */
export const PUBLIC_REPOSITORY = "PrepLabsAI/Rovara";
export const CLOUD_REPOSITORY = "PrepLabsAI/Rovara-cloud";

type Node =
  | { kind: "const"; value: boolean | number | string }
  | { kind: "text"; text: string }
  | { kind: "not"; operand: Node }
  | { kind: "and" | "or"; left: Node; right: Node }
  | { kind: "compare"; op: "==" | "!=" | "<" | ">" | "<=" | ">="; left: Node; right: Node }
  | { kind: "group"; inner: Node };

const TOKEN = /\s*(&&|\|\||==|!=|<=|>=|<|>|!|\(|\)|'(?:[^']|'')*'|[^\s&|=!<>()']+(?:\((?:[^()']|'(?:[^']|'')*')*\))?)/y;

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    if (/^\s*$/.test(source.slice(TOKEN.lastIndex))) break;
    const match = TOKEN.exec(source);
    if (match === null) throw new Error(`workflow expression not understood at "${source.slice(TOKEN.lastIndex)}"`);
    tokens.push(match[1]!);
  }
  return tokens;
}

function parse(tokens: string[], repository: string): Node {
  let at = 0;
  const peek = () => tokens[at];
  const atom = (): Node => {
    const token = tokens[at++];
    if (token === undefined) throw new Error("workflow expression ended early");
    if (token === "(") {
      const inner = or();
      if (tokens[at++] !== ")") throw new Error("workflow expression has an unclosed parenthesis");
      return { kind: "group", inner };
    }
    if (token === "!") return { kind: "not", operand: atom() };
    if (token === "github.repository") return { kind: "const", value: repository };
    if (token === "github.repository_owner") return { kind: "const", value: repository.slice(0, repository.indexOf("/")) };
    if (token === "true" || token === "false") return { kind: "const", value: token === "true" };
    if (/^-?\d+(\.\d+)?$/.test(token)) return { kind: "const", value: Number(token) };
    if (token.startsWith("'")) return { kind: "const", value: token.slice(1, -1).replace(/''/g, "'") };
    return { kind: "text", text: token };
  };
  const compare = (): Node => {
    const left = atom();
    const op = peek();
    if (op === "==" || op === "!=" || op === "<" || op === ">" || op === "<=" || op === ">=") {
      at += 1;
      return { kind: "compare", op, left, right: atom() };
    }
    return left;
  };
  const and = (): Node => {
    let left = compare();
    while (peek() === "&&") {
      at += 1;
      left = { kind: "and", left, right: compare() };
    }
    return left;
  };
  const or = (): Node => {
    let left = and();
    while (peek() === "||") {
      at += 1;
      left = { kind: "or", left, right: and() };
    }
    return left;
  };
  const tree = or();
  if (at !== tokens.length) throw new Error(`workflow expression has extra input at "${tokens.slice(at).join(" ")}"`);
  return tree;
}

const strip = (node: Node): Node => (node.kind === "group" ? strip(node.inner) : node);
const isConst = (node: Node): node is { kind: "const"; value: boolean | number | string } => node.kind === "const";
const truthy = (value: boolean | number | string): boolean => (typeof value === "string" ? value !== "" : Boolean(value));

function simplify(node: Node): Node {
  switch (node.kind) {
    case "group":
      return strip(simplify(node.inner));
    case "not": {
      const operand = simplify(node.operand);
      return isConst(operand) ? { kind: "const", value: !truthy(operand.value) } : { kind: "not", operand };
    }
    case "compare": {
      const left = simplify(node.left);
      const right = simplify(node.right);
      if (isConst(left) && isConst(right) && (node.op === "==" || node.op === "!=")) {
        // GitHub compares strings without regard to case.
        const norm = (value: boolean | number | string) => (typeof value === "string" ? value.toLowerCase() : value);
        const same = norm(left.value) === norm(right.value);
        return { kind: "const", value: node.op === "==" ? same : !same };
      }
      return { kind: "compare", op: node.op, left, right };
    }
    case "and": {
      const left = simplify(node.left);
      const right = simplify(node.right);
      if (isConst(left)) return truthy(left.value) ? right : left;
      // In a condition `x && true` is `x`.
      if (isConst(right) && right.value === true) return left;
      return { kind: "and", left, right };
    }
    case "or": {
      const left = simplify(node.left);
      const right = simplify(node.right);
      if (isConst(left)) return truthy(left.value) ? left : right;
      // In a condition `x || false` is `x`.
      if (isConst(right) && right.value === false) return left;
      return { kind: "or", left, right };
    }
    default:
      return node;
  }
}

function render(node: Node, parent: "none" | "and" | "or" | "not" | "compare" = "none"): string {
  switch (node.kind) {
    case "const":
      return typeof node.value === "string" ? `'${node.value.replace(/'/g, "''")}'` : String(node.value);
    case "text":
      return node.text;
    case "group":
      return render(node.inner, parent);
    case "not":
      return `!${render(node.operand, "not")}`;
    case "compare": {
      const text = `${render(node.left, "compare")} ${node.op} ${render(node.right, "compare")}`;
      return parent === "not" ? `(${text})` : text;
    }
    case "and": {
      const text = `${render(node.left, "and")} && ${render(node.right, "and")}`;
      return parent === "not" || parent === "compare" ? `(${text})` : text;
    }
    case "or": {
      const text = `${render(node.left, "or")} || ${render(node.right, "or")}`;
      return parent === "not" || parent === "compare" || parent === "and" ? `(${text})` : text;
    }
  }
}

/** The expression with every `github.repository` comparison decided for `repository`, simplified, as text; a string that holds no such comparison is returned as it was. */
export function forRepository(expression: string | number | undefined, repository: string): string | undefined {
  if (expression === undefined) return undefined;
  const raw = String(expression);
  if (!raw.includes("github.repository")) return raw;
  const wrapped = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(raw);
  const body = (wrapped?.[1] ?? raw).trim();
  return render(simplify(parse(tokenize(body), repository)));
}

/** A job's or step's `if` as `repository` sees it: undefined when it has none or always runs, `"false"` when it never runs there. */
export function conditionFor(expression: string | undefined, repository: string): string | undefined {
  const resolved = forRepository(expression, repository);
  return resolved === "true" ? undefined : resolved;
}

/** A `timeout-minutes` as `repository` sees it. */
export function timeoutFor(value: string | number | undefined, repository: string): number {
  return Number(forRepository(value, repository));
}
