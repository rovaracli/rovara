// ONE test id for the whole product (NH-1 fix 1). The nightly run's failing set and coverage map, the evidence pack's test names, the known-failing marks, the selection's inventory and its "last night's failures" all name a
// test the same way, so a failure that is already on the default branch is the SAME string in each of them:
//
//   file::name     `tests/test_cart.py::TestRules::test_discount_fails[x]`  (pytest's own node id; `file` is the report's file, relative to the check's directory; `name` is the class path and the test)
//   name           when the report names no file
//
// An id is never rewritten: whitespace, control and hidden characters are NOT turned into something else (two different tests would become one). An id that has any of them is simply not SAFE: it is counted in the totals, but it
// is left out of every list that is matched or passed on a command line (the failing set, the map, the marks, a rerun), so nothing excuses it and nothing runs it by accident. Nothing here imports a Node module.
import { z } from "zod";

/** The longest id: the nightly result, the map, the marks and the evidence pack all hold up to this. */
export const TEST_ID_MAX = 500;
const UNSAFE_CHARACTER = /[\s\p{Cc}\p{Cf}]/u;

/** Whether an id may be listed, matched, marked and put on a command line: not empty, short enough, one token (no whitespace or hidden characters), and not readable as an option (`-x`) or an argument file (`@file`). */
export function isSafeTestId(id: string): boolean {
  return id.length > 0 && id.length <= TEST_ID_MAX && !id.startsWith("-") && !id.startsWith("@") && !UNSAFE_CHARACTER.test(id);
}

/** A safe test id, as a schema. */
export const TestIdSchema = z.string().min(1).max(TEST_ID_MAX).refine(isSafeTestId, "a test id is one token with no whitespace or control characters");

/** The id of a test a report names: `file::name`, or the name alone when the report names no file. Not rewritten and not checked: ask `isSafeTestId`. */
export function testIdOf(test: { file?: string | undefined; name: string }): string {
  return test.file === undefined || test.file === "" ? test.name : `${test.file}::${test.name}`;
}
