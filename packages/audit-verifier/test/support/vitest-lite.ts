/**
 * The few vitest functions the verifier's tests use, written on node:test and node:assert, so the package
 * tests run with `node --test` and need no test framework to install.
 */
import assert from "node:assert/strict";
import { after, describe as nodeDescribe, it as nodeIt } from "node:test";

type Fn = () => void | Promise<void>;
type Timeout = number | undefined;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function format(name: string, row: readonly unknown[]): string {
  let i = 0;
  const out = name.replace(/%[sidj]/g, (spec) => {
    const value = row[i];
    i += 1;
    return spec === "%j" ? JSON.stringify(value) : String(value);
  });
  return out;
}

function eachRow<T extends readonly unknown[]>(rows: readonly T[]): (name: string, fn: (...args: Mutable<T>) => void | Promise<void>, timeout?: Timeout) => void;
function eachRow<T>(rows: readonly T[]): (name: string, fn: (arg: T) => void | Promise<void>, timeout?: Timeout) => void;
function eachRow(rows: readonly unknown[]) {
  return (name: string, fn: (...args: never[]) => void | Promise<void>, timeout?: Timeout): void => {
    for (const row of rows) {
      const args = Array.isArray(row) ? (row as unknown[]) : [row];
      const test = (): void | Promise<void> => (fn as (...a: unknown[]) => void | Promise<void>)(...args);
      if (timeout === undefined) void nodeIt(format(name, args), test);
      else void nodeIt(format(name, args), { timeout }, test);
    }
  };
}

function itImpl(name: string, fn: Fn, timeout?: Timeout): void {
  if (timeout === undefined) void nodeIt(name, fn);
  else void nodeIt(name, { timeout }, fn);
}
export const it = Object.assign(itImpl, { each: eachRow });
export function describe(name: string, fn: () => void): void {
  void nodeDescribe(name, fn);
}
export const afterAll = (fn: Fn): void => {
  void after(fn);
};

// ---- expect ----

const ARRAY_CONTAINING = Symbol("arrayContaining");
type ArrayContaining = { [ARRAY_CONTAINING]: true; items: readonly unknown[] };
const isArrayContaining = (value: unknown): value is ArrayContaining =>
  typeof value === "object" && value !== null && ARRAY_CONTAINING in value;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Structural equality in the way vitest's toEqual has it: undefined properties are ignored, prototypes are not compared. */
function equals(a: unknown, b: unknown): boolean {
  if (isArrayContaining(b)) return Array.isArray(a) && b.items.every((item) => a.some((x) => equals(x, item)));
  if (Object.is(a, b)) return true;
  if (!isObject(a) || !isObject(b)) return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false;
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equals(v, b[i]));
  const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
  const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
  return keysA.length === keysB.length && keysA.every((k) => k in b && equals(a[k], b[k]));
}

function matchesObject(actual: unknown, expected: unknown): boolean {
  if (!isObject(expected) || isArrayContaining(expected)) return equals(actual, expected);
  if (!isObject(actual)) return false;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => matchesObject(actual[i], v));
  return Object.keys(expected).every((k) => matchesObject(actual[k], expected[k]));
}

const show = (value: unknown): string => {
  try {
    return typeof value === "bigint" ? `${value}n` : (JSON.stringify(value) ?? String(value));
  } catch {
    return String(value);
  }
};

class Matchers {
  constructor(
    private readonly actual: unknown,
    private readonly negate: boolean,
    private readonly note: string | undefined,
  ) {}

  get not(): Matchers {
    return new Matchers(this.actual, !this.negate, this.note);
  }

  private check(pass: boolean, what: string): void {
    const prefix = this.note === undefined ? "" : `${this.note}: `;
    assert.ok(this.negate ? !pass : pass, `${prefix}expected ${show(this.actual)}${this.negate ? " not" : ""} ${what}`);
  }

  toBe(expected: unknown): void {
    this.check(Object.is(this.actual, expected), `to be ${show(expected)}`);
  }
  toEqual(expected: unknown): void {
    this.check(equals(this.actual, expected), `to equal ${show(expected)}`);
  }
  toMatchObject(expected: unknown): void {
    this.check(matchesObject(this.actual, expected), `to match ${show(expected)}`);
  }
  toContain(item: unknown): void {
    const actual = this.actual;
    const pass = typeof actual === "string" ? actual.includes(String(item)) : Array.isArray(actual) && actual.some((x) => Object.is(x, item));
    this.check(pass, `to contain ${show(item)}`);
  }
  toHaveLength(length: number): void {
    const actual = this.actual as { length?: number };
    this.check(actual.length === length, `to have length ${length}`);
  }
  toBeDefined(): void {
    this.check(this.actual !== undefined, "to be defined");
  }
  toBeUndefined(): void {
    this.check(this.actual === undefined, "to be undefined");
  }
  toBeGreaterThan(n: number | bigint): void {
    this.check((this.actual as number) > n, `to be greater than ${String(n)}`);
  }
  toBeGreaterThanOrEqual(n: number | bigint): void {
    this.check((this.actual as number) >= n, `to be at least ${String(n)}`);
  }
  toBeLessThan(n: number | bigint): void {
    this.check((this.actual as number) < n, `to be less than ${String(n)}`);
  }
  toMatch(pattern: RegExp): void {
    this.check(typeof this.actual === "string" && pattern.test(this.actual), `to match ${String(pattern)}`);
  }
  toHaveProperty(key: string): void {
    this.check(isObject(this.actual) && key in this.actual, `to have property ${key}`);
  }
  toThrow(expected?: unknown): void {
    let thrown: unknown;
    let didThrow = false;
    try {
      (this.actual as () => unknown)();
    } catch (error) {
      didThrow = true;
      thrown = error;
    }
    let pass = didThrow;
    if (didThrow && expected !== undefined) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      if (typeof expected === "function") pass = thrown instanceof (expected as new (...args: never[]) => Error);
      else if (typeof expected === "string") pass = message.includes(expected);
      else if (expected instanceof RegExp) pass = expected.test(message);
      else if (expected instanceof Error) pass = message === expected.message;
    }
    this.check(pass, `to throw ${expected === undefined ? "" : show(expected)}`.trim());
  }
}

export function expect(actual: unknown, note?: string): Matchers {
  return new Matchers(actual, false, note);
}
expect.arrayContaining = (items: readonly unknown[]): ArrayContaining => ({ [ARRAY_CONTAINING]: true, items });
