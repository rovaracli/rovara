/**
 * RFC 8785 (JSON Canonicalization Scheme) for the values this format holds:
 * null, booleans, strings, safe integers, arrays and plain objects.
 * Keys sort by UTF-16 code units, there is no whitespace, strings are written
 * the way `JSON.stringify` writes them, and numbers other than safe integers
 * are refused, which sidesteps the ECMAScript number-to-string rules entirely.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export function canonicalJson(value: JsonValue): string {
  return write(value);
}

function write(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return writeString(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new RangeError("audit json: only safe integers");
      // String() writes -0 as "0", which is what RFC 8785 requires.
      return String(value);
    case "object":
      return Array.isArray(value) ? writeArray(value) : writeObject(value);
    default:
      // undefined, bigint, function and symbol have no JSON form.
      throw new TypeError(`audit json: cannot write a value of type ${typeof value}`);
  }
}

/** String.prototype.isWellFormed (Node 20+); the ES2023 lib this repo compiles with predates its typing. */
export function isWellFormed(value: string): boolean {
  return (value as string & { isWellFormed(): boolean }).isWellFormed();
}

/** RFC 8785 3.2.2.2: a lone surrogate is an error (and would not survive a UTF-8 round trip). */
function writeString(value: string): string {
  if (!isWellFormed(value)) throw new TypeError("audit json: lone surrogate in string");
  return JSON.stringify(value);
}

function writeArray(items: readonly unknown[]): string {
  const parts: string[] = [];
  // An index loop, not map: a hole in a sparse array must reach write() as undefined and throw.
  for (let i = 0; i < items.length; i++) parts.push(write(items[i]));
  return `[${parts.join(",")}]`;
}

function writeObject(object: object): string {
  const prototype: unknown = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("audit json: only plain objects");
  }
  if (Object.getOwnPropertySymbols(object).length > 0) {
    throw new TypeError("audit json: symbol keys are not allowed");
  }
  const entries = Object.entries(object as Record<string, unknown>);
  // The default sort compares strings by UTF-16 code units, as RFC 8785 3.2.3 requires.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, member]) => `${writeString(key)}:${write(member)}`).join(",")}}`;
}
