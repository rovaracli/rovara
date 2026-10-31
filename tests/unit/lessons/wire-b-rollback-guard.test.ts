// Wiring lane B, WA-2: a lesson-set rollback must always run the normal tier check again on what it restores (`rollbackLessonSetSettled`). Nothing outside the lessons lane calls
// the bare `rollbackLessonSet`, so a rollback route written later cannot skip the check by accident.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/u.test(name)) out.push(path);
  }
  return out;
};

describe("rollback call sites", () => {
  it("only the settled wrapper calls rollbackLessonSet in source code", () => {
    const callers = walk(join(ROOT, "packages")).filter((file) => /\brollbackLessonSet\s*\(/u.test(readFileSync(file, "utf8"))).map((file) => relative(ROOT, file)).sort();
    // approve.ts defines it; rollback.ts is the one wrapper that passes the tier check.
    expect(callers).toEqual(["packages/broker/src/lessons/approve.ts", "packages/broker/src/lessons/rollback.ts"]);
  });
  it("the guard sees a call (control)", () => {
    expect(/\brollbackLessonSet\s*\(/u.test("await rollbackLessonSet(deps, input)")).toBe(true);
    expect(/\brollbackLessonSet\s*\(/u.test("await rollbackLessonSetSettled(deps, input)")).toBe(false);
  });
});
