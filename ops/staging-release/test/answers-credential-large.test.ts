// Opus security review of 8ba557dfe: answers-from-deployed.sh must refuse a credential ANYWHERE in a large answers.json, including near the start
// (the reader may stop at the first match while jq is still writing: SIGPIPE, exit 141 under pipefail, and the `if` reads as "no credential").
// GNU grep (the AL2023 CodeBuild runner) treats stdout=/dev/null like -q (grep.c: dev_null_output -> done_on_match), so `grep -E ... >/dev/null` stops early there
// exactly like `grep -q`; the "GNU semantics" case emulates that on any host.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PACK } from "./support/harness.ts";

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

// the script's exact credential-scan block (between its BEGIN/END markers), so the test follows any change to it
function refusalLine(): string {
  const src = readFileSync(join(PACK, "answers-from-deployed.sh"), "utf8");
  const a = src.indexOf("# BEGIN credential scan");
  const b = src.indexOf("# END credential scan");
  if (a < 0 || b < a) throw new Error("no credential scan block in answers-from-deployed.sh");
  return src.slice(src.indexOf("\n", a) + 1, b).replaceAll('"$RUN_DIR/answers.json"', '"$1"');
}

function runCheck(answers: object, gnuShim: boolean): { status: number | null; out: string } {
  dir = mkdtempSync(join(tmpdir(), "answers-cred-"));
  const f = join(dir, "answers.json");
  writeFileSync(f, JSON.stringify(answers));
  const shimDir = join(dir, "bin");
  spawnSync("mkdir", ["-p", shimDir]);
  const realGrep = spawnSync("sh", ["-c", "command -v grep"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(
    join(shimDir, "grep"),
    `#!/usr/bin/env bash\nif [ /dev/stdout -ef /dev/null ]; then exec ${realGrep} -q "$@"; fi\nexec ${realGrep} "$@"\n`,
  );
  chmodSync(join(shimDir, "grep"), 0o755);
  const script = `set -euo pipefail\nrefuse() { echo "REFUSED: $*" >&2; exit 3; }\n${refusalLine()}\necho NO-CREDENTIAL\n`;
  const r = spawnSync("bash", ["-c", script, "check", f], {
    encoding: "utf8",
    env: { ...process.env, PATH: gnuShim ? `${shimDir}:${process.env.PATH}` : process.env.PATH },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

const fakeKey = () => ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
const big = () => Array.from({ length: 400 }, (_, i) => `name-${i}-${"x".repeat(1000)}`); // ~400 KiB of strings after the secret

describe("answers.json credential refusal on a large file", () => {
  for (const gnu of [false, true]) {
    it(`refuses a credential near the start of a >256 KiB answers.json (${gnu ? "GNU grep semantics" : "host grep"})`, () => {
      for (let i = 0; i < 3; i++) {
        const r = runCheck({ env: "staging", key: fakeKey(), pad: big() }, gnu);
        expect(r.status, r.out).toBe(3);
      }
    });
    it(`passes a large answers.json with names only (${gnu ? "GNU grep semantics" : "host grep"})`, () => {
      const r = runCheck({ env: "staging", secretName: "arn:aws:secretsmanager:us-west-2:123456789012:secret:x", pad: big() }, gnu);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain("NO-CREDENTIAL");
    });
  }
  it("fails closed (refuses, exit 3) when answers.json cannot be read or parsed", () => {
    const r = runCheck({ env: "staging" }, false);
    expect(r.status).toBe(0);
    dir = mkdtempSync(join(tmpdir(), "answers-cred-"));
    const bad = join(dir, "answers.json");
    writeFileSync(bad, "{not json");
    for (const file of [bad, join(dir, "missing.json")]) {
      const out = spawnSync("bash", ["-c", `set -euo pipefail\nrefuse() { echo "REFUSED: $*" >&2; exit 3; }\n${refusalLine()}\necho NO-CREDENTIAL\n`, "check", file], { encoding: "utf8" });
      expect(out.status, out.stdout + out.stderr).toBe(3);
      expect(out.stderr).toContain("cannot scan");
    }
  });
});
