// Small, dependency-free helpers for the staging auto-approve evaluator (P8). Node runs this file directly (erasable TypeScript only).
import { createHash } from "node:crypto";

/** Thrown for any missing, mistyped or unparsable input. Every check catches it and turns it into a MANUAL reason (fail closed). */
export class InputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InputError";
    this.code = code;
  }
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** Own-property read: never walks the prototype chain, so a key such as "__proto__" or "constructor" cannot reach inherited values. */
export function own(target: Record<string, unknown>, key: string): unknown {
  return hasOwn(target, key) ? target[key] : undefined;
}

export function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw new InputError("input-invalid", `${where} must be an object`);
  return value;
}

export function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new InputError("input-invalid", `${where} must be an array`);
  return value;
}

export function asString(value: unknown, where: string): string {
  if (typeof value !== "string") throw new InputError("input-invalid", `${where} must be a string`);
  return value;
}

export function asNonEmptyString(value: unknown, where: string): string {
  const text = asString(value, where);
  if (text === "") throw new InputError("input-invalid", `${where} must not be empty`);
  return text;
}

export function asBoolean(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") throw new InputError("input-invalid", `${where} must be a boolean`);
  return value;
}

export function asFiniteNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new InputError("input-invalid", `${where} must be a finite number`);
  return value;
}

export function field(record: Record<string, unknown>, key: string, where: string): unknown {
  if (!hasOwn(record, key)) throw new InputError("input-missing", `${where}.${key} is missing`);
  return record[key];
}

/** Rejects any key that is not in the allowed list. Unknown fields are never ignored: they could carry meaning this evaluator does not understand. */
export function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new InputError("unknown-field", `${where} has unknown field "${key}"`);
  }
}

export function parseJsonText(text: unknown, where: string): unknown {
  if (typeof text !== "string") throw new InputError("input-invalid", `${where} must be JSON text`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InputError("parse-error", `${where} is not valid JSON`);
  }
}

/** A JSON value or JSON text: change-set template bodies and contexts arrive as either. */
export function jsonValue(value: unknown, where: string): unknown {
  return typeof value === "string" ? parseJsonText(value, where) : value;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export interface DiffEntry {
  /** Path segments; array indexes are numbers. */
  path: (string | number)[];
  kind: "add" | "remove" | "change";
  before: unknown;
  after: unknown;
}

/** Leaf-level structural diff. Arrays compare index by index; a length difference is an add or remove of the extra indexes. */
export function deepDiff(before: unknown, after: unknown, path: (string | number)[] = []): DiffEntry[] {
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: DiffEntry[] = [];
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i += 1) {
      if (i >= before.length) out.push({ path: [...path, i], kind: "add", before: undefined, after: after[i] });
      else if (i >= after.length) out.push({ path: [...path, i], kind: "remove", before: before[i], after: undefined });
      else out.push(...deepDiff(before[i], after[i], [...path, i]));
    }
    return out;
  }
  if (isRecord(before) && isRecord(after)) {
    const out: DiffEntry[] = [];
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      const inBefore = hasOwn(before, key);
      const inAfter = hasOwn(after, key);
      if (!inBefore) out.push({ path: [...path, key], kind: "add", before: undefined, after: after[key] });
      else if (!inAfter) out.push({ path: [...path, key], kind: "remove", before: before[key], after: undefined });
      else out.push(...deepDiff(before[key], after[key], [...path, key]));
    }
    return out;
  }
  if (canonicalJson(before) === canonicalJson(after)) return [];
  return [{ path, kind: "change", before, after }];
}

export function pathText(path: readonly (string | number)[]): string {
  return path.map((segment, index) => (typeof segment === "number" ? `[${segment}]` : index === 0 ? segment : `.${segment}`)).join("");
}

/** Glob to RegExp: `**` crosses directories (and `**` + `/` also matches zero directories), `*` stays inside one segment, `?` is one non-slash character. Case-insensitive by default, so a differently cased spelling of a manual path is still caught; the allow-list uses case-sensitive matching. */
export function globToRegExp(glob: string, ignoreCase = true): RegExp {
  let source = "";
  let i = 0;
  while (i < glob.length) {
    const char = glob[i] as string;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 3;
        } else {
          source += ".*";
          i += 2;
        }
      } else {
        source += "[^/]*";
        i += 1;
      }
    } else if (char === "?") {
      source += "[^/]";
      i += 1;
    } else {
      source += char.replace(/[\\^$.|+(){}[\]]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${source}$`, ignoreCase ? "i" : "");
}

export function matchesAnyGlob(path: string, globs: readonly string[], ignoreCase = true): boolean {
  return globs.some((glob) => globToRegExp(glob, ignoreCase).test(path));
}

export const HEX40 = /^[0-9a-f]{40}$/;
export const HEX64 = /^[0-9a-f]{64}$/;
export const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/** Compiles a pattern from the (pinned) policy. Always anchored by the policy author; an invalid pattern is an input error. */
export function policyRegExp(pattern: unknown, where: string): RegExp {
  const text = asNonEmptyString(pattern, where);
  if (!text.startsWith("^") || !text.endsWith("$")) throw new InputError("policy-invalid", `${where} must be anchored with ^ and $`);
  try {
    return new RegExp(text);
  } catch {
    throw new InputError("policy-invalid", `${where} is not a valid pattern`);
  }
}
