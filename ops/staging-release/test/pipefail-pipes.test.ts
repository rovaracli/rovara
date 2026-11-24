// Under `set -euo pipefail` a pipe whose reader exits early (`| head`, `| grep -q`, `| grep -m1`, `| sed ...q`, `| awk ...exit`, `| read`, or a command that never
// reads its stdin) kills the writer with SIGPIPE: the script exits 141, timing-dependent (the flaky staging CI failure). GNU grep (the AL2023 CodeBuild runner) also stops at the
// first match when its stdout is /dev/null (grep.c dev_null_output, same as -q), and `grep -c`/`-l` are early readers or error-prone in the same way, so no pipe may feed
// grep with those either. Keep such pipes out of the pack's scripts: capture the output first, then select from it with a here-string (`grep -E pat <<<"$x"`), `[[ $x =~ $re ]]`,
// a `case` on the value, or one process (`jq -e`). A reader that is a plain filter writing to a file or a variable (`grep -v pat > f`, `awk 'NR <= 20'`) is fine.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PACK } from "./support/harness.ts";

const scripts = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "test" || n === "node_modules" ? [] : scripts(p);
    return n.endsWith(".sh") ? [p] : [];
  });

// one pipe stage that can stop reading before its writer is done (a single `|`, not `||`)
const PIPE = String.raw`(?<!\|)\|(?!\|)\s*`;
export const EARLY_READERS: Array<[string, RegExp]> = [
  ["| head", new RegExp(`${PIPE}head(?:\\s|$)`)],
  ["| grep -q / --quiet / --silent", new RegExp(`${PIPE}grep\\b[^|;&]*?(\\s-[A-Za-z]*q|--quiet|--silent)`)],
  ["| grep -m / --max-count", new RegExp(`${PIPE}grep\\b[^|;&]*?(\\s-[A-Za-z]*m|--max-count)`)],
  ["| sed ... q (quit early)", new RegExp(`${PIPE}sed\\b[^|]*?(?:^|[\\s;'"{])q(?:\\s|;|'|"|}|$)`)],
  ["| awk ... exit", new RegExp(`${PIPE}awk\\b[^|]*\\bexit\\b`)],
  ["| read / | { read", new RegExp(`${PIPE}(\\{\\s*)?read\\b`)],
  ["| grep with stdout on /dev/null (GNU grep: same as -q)", new RegExp(`${PIPE}grep\\b[^|;&]*>\\s*/dev/null`)],
  ["| grep -c / -l / --count / --files-with-matches", new RegExp(`${PIPE}grep\\b[^|;&]*?(\\s-[A-Za-z]*[cl]|--count|--files-with)`)],
  ["| docker login (--password-stdin consumer)", new RegExp(`${PIPE}docker\\s+login\\b`)],
];

/** Returns "file:line: stage" for each early-reader pipe in the script text (full-line comments are skipped). */
export function findEarlyReaderPipes(file: string, text: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    for (const [name, re] of EARLY_READERS) if (re.test(line)) hits.push(`${file}:${i + 1}: ${name}: ${line.trim().slice(0, 120)}`);
  });
  return hits;
}

describe("pipes in the pack's pipefail scripts", () => {
  const files = scripts(PACK);
  it("finds the pack's scripts", () => {
    expect(files.length).toBeGreaterThan(10);
  });
  it("no pipe has a reader that can exit before its writer (SIGPIPE, exit 141)", () => {
    const hits = files.flatMap((f) => findEarlyReaderPipes(relative(PACK, f), readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
  it("the detector flags each early-reader shape and ignores safe pipes", () => {
    const bad = [
      "a | head -1", "a | grep -E x >/dev/null", "a | grep -c x", "a | grep -Ec x", "a | grep -l x", "a | grep -Fx x >/dev/null || b", "a | jq -r . | grep -E x >/dev/null", "a | head -c 200", "a | grep -q x", "a | grep -Eq 'x'", "a | grep -Fxq x", "a | grep -m1 x", "a | grep --quiet x", "a | sed -n '1p;q'",
      "a | sed q", "a | awk 'NR==1{print; exit}'", "a | read -r x", "a | { read -r x; }", "a | docker login --password-stdin r",
    ];
    for (const l of bad) expect(findEarlyReaderPipes("x", l), l).toHaveLength(1);
    const ok = [
      "a | awk 'NR <= 20'", "a | sed 's/^/  /'", "a | jq -e . >/dev/null", "a || head -1", "# a | head -1",
      "grep -E x >/dev/null <<<\"$v\"", "grep -c x <<<\"$v\"", "a | grep -v x > f || true", "a | tr '\\n' ' '", "a | cut -c1-200", "a | sort | uniq", "x=${y%%$'\\n'*}", "b | jq -r '.q // empty'",
    ];
    for (const l of ok) expect(findEarlyReaderPipes("x", l), l).toEqual([]);
  });
});
