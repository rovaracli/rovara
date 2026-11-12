// A small source scanner for contract tests: which State-table partition-key prefixes does a Lambda's entry file touch, and with which DynamoDB action?
//
// It reads every call site that reaches the table (`getItem(deps, KEY)`, `new Get|Update|Delete|PutCommand({ Key | Item })`, `new QueryCommand` with a ":pk" value, and the
// `Update:` / `Put:` / `Delete:` / `ConditionCheck:` members of a TransactWriteCommand), then works out the key's partition prefix from the key expression: a literal `pk`, a key
// builder (taskKey and the like, called for real), a local `const` in the same function, or a function parameter (followed to the arguments of every caller in the file).
// A key it cannot work out is returned in `unresolved`, never skipped: the contract test fails on it, so a new key shape has to be taught here.
//
// What it cannot see, said plainly: keys built inside another file's functions that the entry file only calls (the session-binding items, the work-event rows, the run-limit reads).
// A test that uses this lists those by hand and checks that the named file still mentions them.

export type ItemAction = "GetItem" | "PutItem" | "UpdateItem" | "DeleteItem" | "Query" | "ConditionCheckItem";

export interface KeyUse { prefix: string; action: ItemAction; line: number }
export interface Unresolved { expression: string; action: ItemAction; line: number }

export interface Builders {
  /** Imported or local functions that return `{ pk, sk }` (or an update/put input whose Key is one): name to the prefixes they build. */
  [name: string]: string[];
}

/** The partition prefix of a sample pk: `DEVTASK#t1` is `DEVTASK#`, `NOTIFY_DM` is itself. */
export const prefixOfPk = (pk: string): string => (pk.includes("#") ? pk.slice(0, pk.indexOf("#") + 1) : pk);

/** The sample partition key a prefix stands for. */
export const sampleOfPrefix = (prefix: string): string => (prefix.endsWith("#") ? `${prefix}x0` : prefix);

function skipQuoted(s: string, start: number): number {
  const quote = s[start]!;
  let i = start + 1;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\") { i += 2; continue; }
    if (quote === "`" && c === "$" && s[i + 1] === "{") { i = closeOf(s, i + 1) + 1; continue; }
    if (c === quote) return i + 1;
    i++;
  }
  return s.length;
}

/** The index of the bracket that closes the one at `open`, skipping strings, template literals and comments. */
export function closeOf(s: string, open: number): number {
  const stack: string[] = [];
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\"" || c === "'" || c === "`") { i = skipQuoted(s, i) - 1; continue; }
    if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
    if (c === "/" && s[i + 1] === "*") { i = s.indexOf("*/", i + 2) + 1; if (i === 0) return s.length; continue; }
    if (pairs[c] !== undefined) stack.push(pairs[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Splits at the commas that sit at the top level of `text`. */
export function splitTop(text: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\"" || c === "'" || c === "`") { i = skipQuoted(text, i) - 1; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2) + 1; if (i === 0) break; continue; }
    if (c === "(" || c === "[" || c === "{") { i = closeOf(text, i); if (i < 0) break; continue; }
    if (c === ",") { parts.push(text.slice(from, i)); from = i + 1; }
  }
  parts.push(text.slice(from));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

const inner = (text: string): string => text.slice(1, -1);

/** The top-level entries of an object literal's text: properties by name, and spreads. */
function objectEntries(objectText: string): { props: Map<string, string>; spreads: string[] } {
  const props = new Map<string, string>();
  const spreads: string[] = [];
  for (const entry of splitTop(inner(objectText.trim()))) {
    if (entry.startsWith("...")) { spreads.push(entry.slice(3).trim()); continue; }
    const match = /^(?:(\w+)|"([^"]+)")\s*:\s*([\s\S]*)$/.exec(entry);
    if (match !== null) props.set(match[1] ?? match[2]!, match[3]!.trim());
    else if (/^\w+$/.test(entry)) props.set(entry, entry);
  }
  return { props, spreads };
}

interface FunctionRange { name: string; start: number; end: number; params: string[] }

function functionRanges(source: string): FunctionRange[] {
  const starts: Array<{ name: string; start: number; paramsOpen: number }> = [];
  const declaration = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>(]*>)?\s*\(|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:<[^>(]*>)?\(/gm;
  for (let match = declaration.exec(source); match !== null; match = declaration.exec(source)) {
    starts.push({ name: (match[1] ?? match[2])!, start: match.index, paramsOpen: match.index + match[0].length - 1 });
  }
  return starts.map((entry, index) => {
    const close = closeOf(source, entry.paramsOpen);
    const params = close < 0 ? [] : splitTop(source.slice(entry.paramsOpen + 1, close)).map((param) => /^[.\w]+/.exec(param.replace(/^\.\.\./, ""))?.[0] ?? "");
    return { name: entry.name, start: entry.start, end: starts[index + 1]?.start ?? source.length, params };
  });
}

/** The two branches of a top-level `a ? b : c`, or undefined when the text is not one. */
function ternaryBranches(text: string): [string, string] | undefined {
  let question = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\"" || c === "'" || c === "`") { i = skipQuoted(text, i) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") { i = closeOf(text, i); if (i < 0) return undefined; continue; }
    if (c === "?" && text[i + 1] !== "." && text[i + 1] !== "?" && text[i - 1] !== "?") { question = i; break; }
  }
  if (question < 0) return undefined;
  const rest = text.slice(question + 1);
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (c === "\"" || c === "'" || c === "`") { i = skipQuoted(rest, i) - 1; continue; }
    if (c === "(" || c === "[" || c === "{") { i = closeOf(rest, i); if (i < 0) return undefined; continue; }
    if (c === ":") return [rest.slice(0, i).trim(), rest.slice(i + 1).trim()];
  }
  return undefined;
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;

/** Reads a pk expression: a string or a template literal that begins with a literal name. Undefined when it is something else. */
function literalPrefix(expression: string): string | undefined {
  const text = expression.trim();
  const plain = /^(["'])([A-Z][A-Z0-9_]*)\1$/.exec(text);
  if (plain !== null) return plain[2]!;
  const template = /^`([A-Z][A-Z0-9_]*)(#?)/.exec(text);
  if (template !== null) return template[2] === "#" ? `${template[1]}#` : template[1]!;
  return undefined;
}

export interface ScanOptions {
  /** Key builders by name, with the prefixes each one builds. */
  builders: Builders;
  /**
   * Keys the scan cannot follow, with the prefixes they hold: an expression's exact text (`notice.proofItem`, an item the stream hands over), or `function:variable` for a variable
   * that holds an item read back from the table (the entry names the function and the variable; the test says which query produced it).
   */
  members?: Record<string, string[]>;
}

export function scanStateKeyUses(source: string, options: ScanOptions): { uses: KeyUse[]; unresolved: Unresolved[] } {
  const ranges = functionRanges(source);
  const rangeAt = (index: number): FunctionRange | undefined => ranges.filter((range) => range.start <= index && index < range.end).at(-1);
  const localBuilders: Builders = { ...options.builders };
  // Local arrow functions that return a key literal: `const noticeMarker = (a, b) => ({ pk: `DEVTASK#${a}`, sk: ... })`.
  for (const match of source.matchAll(/^const\s+(\w+)\s*=\s*\([^)]*\)\s*=>\s*\(\{\s*pk:\s*([^,]+),/gm)) {
    const prefix = literalPrefix(match[2]!);
    if (prefix !== undefined) localBuilders[match[1]!] = [prefix];
  }

  const resolveIdentifier = (name: string, at: number, depth: number): string[] | undefined => {
    if (depth > 5) return undefined;
    const range = rangeAt(at);
    if (range === undefined) return undefined;
    const stated = options.members?.[`${range.name}:${name}`];
    if (stated !== undefined) return stated;
    const body = source.slice(range.start, at);
    const declared = [...body.matchAll(new RegExp(`\\b(?:const|let)\\s+${name}\\b(?:\\s*:[^=]+)?\\s*=\\s*`, "g"))].at(-1);
    if (declared !== undefined) {
      const from = range.start + declared.index + declared[0].length;
      let end = from;
      for (; end < source.length; end++) {
        const c = source[end]!;
        if (c === "\"" || c === "'" || c === "`") { end = skipQuoted(source, end) - 1; continue; }
        if (c === "(" || c === "[" || c === "{") { end = closeOf(source, end); if (end < 0) return undefined; continue; }
        if (c === ";" || c === "\n") break;
      }
      return resolveExpression(source.slice(from, end), from, depth + 1);
    }
    const index = range.params.indexOf(name);
    if (index < 0) return undefined;
    const found = new Set<string>();
    let callers = 0;
    for (const call of source.matchAll(new RegExp(`(?<!function\\s)\\b${range.name}\\s*(?:<[^>(]*>)?\\(`, "g"))) {
      const open = call.index + call[0].length - 1;
      if (open === range.start || source.slice(Math.max(0, call.index - 9), call.index) === "function ") continue;
      const close = closeOf(source, open);
      if (close < 0) continue;
      const argument = splitTop(source.slice(open + 1, close))[index];
      if (argument === undefined) continue;
      callers++;
      const resolved = resolveExpression(argument, open, depth + 1);
      if (resolved === undefined) return undefined;
      for (const prefix of resolved) found.add(prefix);
    }
    return callers === 0 ? undefined : [...found];
  };

  /** The prefixes of the partition key an expression stands for. */
  const resolveExpression = (expression: string, at: number, depth: number): string[] | undefined => {
    const text = expression.split(/\s+as\s+/)[0]!.trim();
    if (text === "" || depth > 6) return undefined;
    if (options.members?.[text] !== undefined) return options.members[text];
    const branches = ternaryBranches(text);
    if (branches !== undefined) {
      const found = new Set<string>();
      for (const branch of branches) {
        if (branch === "undefined") continue;
        const resolved = resolveExpression(branch, at, depth + 1);
        if (resolved === undefined) return undefined;
        for (const prefix of resolved) found.add(prefix);
      }
      return found.size === 0 ? undefined : [...found];
    }
    if (text.startsWith("{")) {
      const { props, spreads } = objectEntries(text);
      const pk = props.get("pk");
      if (pk !== undefined) return resolvePk(pk, at, depth);
      for (const spread of spreads) {
        const resolved = resolveExpression(spread, at, depth + 1);
        if (resolved !== undefined) return resolved;
      }
      return undefined;
    }
    const call = /^(\w+)\s*(?:<[^>(]*>)?\(/.exec(text);
    if (call !== null) return localBuilders[call[1]!];
    if (/^\w+$/.test(text)) return resolveIdentifier(text, at, depth);
    return undefined;
  };

  const resolvePk = (expression: string, at: number, depth: number): string[] | undefined => {
    const literal = literalPrefix(expression);
    if (literal !== undefined) return [literal];
    const member = /^(\w+)\.pk$/.exec(expression.trim());
    if (member !== null) return resolveIdentifier(member[1]!, at, depth + 1);
    return undefined;
  };

  const uses: KeyUse[] = [];
  const unresolved: Unresolved[] = [];
  const record = (action: ItemAction, expression: string | undefined, at: number, resolver: "key" | "pk" = "key") => {
    const line = lineOf(source, at);
    const prefixes = expression === undefined ? undefined : resolver === "pk" ? resolvePk(expression, at, 0) : resolveExpression(expression, at, 0);
    if (prefixes === undefined || prefixes.length === 0) { unresolved.push({ expression: (expression ?? "(no key)").replace(/\s+/g, " ").slice(0, 120), action, line }); return; }
    for (const prefix of prefixes) uses.push({ prefix, action, line });
  };

  // getItem(deps, KEY) and getItem<T>(deps, KEY)
  // `getItem` itself is the shared one-line wrapper: its callers carry the keys.
  const wrapper = ranges.find((range) => range.name === "getItem");
  for (const match of source.matchAll(/(?<!function\s)(?<![\w.])getItem\s*(<)?/g)) {
    let open = match.index + match[0].length;
    if (match[1] !== undefined) {
      let depthAngle = 1;
      for (; open < source.length && depthAngle > 0; open++) {
        const c = source[open]!;
        if (c === "<") depthAngle++;
        else if (c === ">" && source[open - 1] !== "=") depthAngle--;
        else if (c === "{" || c === "(") { open = closeOf(source, open); }
      }
    }
    while (/\s/.test(source[open] ?? "")) open++;
    if (source[open] !== "(") continue;
    const close = closeOf(source, open);
    record("GetItem", splitTop(source.slice(open + 1, close))[1], match.index);
  }

  const COMMANDS: Record<string, ItemAction> = { GetCommand: "GetItem", UpdateCommand: "UpdateItem", DeleteCommand: "DeleteItem", PutCommand: "PutItem", QueryCommand: "Query" };
  for (const match of source.matchAll(/new\s+(Get|Update|Delete|Put|Query)Command\s*\(/g)) {
    if (wrapper !== undefined && match.index >= wrapper.start && match.index < wrapper.end) continue;
    const open = match.index + match[0].length - 1;
    const close = closeOf(source, open);
    const argument = source.slice(open + 1, close).trim();
    const action = COMMANDS[`${match[1]}Command`]!;
    if (!argument.startsWith("{")) { record(action, argument, match.index); continue; }
    const { props } = objectEntries(argument);
    if (action === "Query") {
      const values = props.get("ExpressionAttributeValues");
      record(action, values === undefined ? undefined : objectEntries(values).props.get(":pk"), match.index, "pk");
    } else if (action === "PutItem") record(action, props.get("Item"), match.index);
    else record(action, props.get("Key"), match.index);
  }

  const MEMBERS: Record<string, ItemAction> = { Update: "UpdateItem", Put: "PutItem", Delete: "DeleteItem", ConditionCheck: "ConditionCheckItem" };
  for (const match of source.matchAll(/new\s+TransactWriteCommand\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = closeOf(source, open);
    const items = objectEntries(source.slice(open + 1, close).trim()).props.get("TransactItems");
    if (items === undefined || !items.startsWith("[")) { record("PutItem", undefined, match.index); continue; }
    for (const element of splitTop(inner(items))) {
      if (element.startsWith("...")) continue; // another file's items: listed by the test by hand
      const { props } = objectEntries(element);
      for (const [member, action] of Object.entries(MEMBERS)) {
        const body = props.get(member);
        if (body === undefined) continue;
        const parts = objectEntries(body).props;
        record(action, action === "PutItem" ? parts.get("Item") : parts.get("Key"), match.index);
      }
    }
  }
  return { uses, unresolved };
}
