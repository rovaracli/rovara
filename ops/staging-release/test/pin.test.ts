// The pack's pin: the same value from every implementation that computes it, and a refusal for anything that is not a regular file.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { symlinkSync } from "node:fs";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { manifestHash } from "../evaluator/src/evaluate.ts";
import { PACK, copyPack, makeWorld, runPack, type World } from "./support/harness.ts";

let w: World;
afterEach(() => w?.cleanup());
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).sort().flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n), base) : ["./" + join(dir, n).slice(base.length + 1)]));
}

describe("the pack pin", () => {
  it("pin.sh, the pipeline's own pin command, the evaluator's manifest hash and the TS recipe all give the same value for this tree", () => {
    w = makeWorld();
    const r = runPack(w, "pin.sh", {});
    expect(r.status, r.stderr).toBe(0);
    const pin = r.stdout.trim();
    expect(pin).toMatch(/^[0-9a-f]{64}$/);
    const paths = walk(PACK).sort();
    const manifest = paths.map((p) => ({ path: p, sha256: sha(readFileSync(join(PACK, p))) }));
    expect(manifestHash(manifest)).toBe(pin); // the evaluator's recipe (Decide hands it exactly this manifest)
    expect(sha(manifest.map((m) => `${m.sha256}  ${m.path}\n`).join(""))).toBe(pin);
    // the pipeline's pin step (infra/lib/environment-release-pipeline.ts POLICY_HASH_COMMAND), with shasum standing in for sha256sum where coreutils is absent
    const shell = `cd "${PACK}" && test -z "$(find . ! -type f ! -type d)" && find . -type f | LC_ALL=C sort | xargs ${spawnSync("sh", ["-c", "command -v sha256sum"]).status === 0 ? "sha256sum" : "shasum -a 256"} | ${spawnSync("sh", ["-c", "command -v sha256sum"]).status === 0 ? "sha256sum" : "shasum -a 256"} | cut -d' ' -f1`;
    const p1 = spawnSync("bash", ["-c", shell], { encoding: "utf8" });
    expect(p1.stdout.trim()).toBe(pin);
  });
  it("covers every file: changing any file under the pack (a test, a fixture, a script) changes the pin; a symlink is refused", () => {
    w = makeWorld();
    const copy = copyPack(w);
    const before = runPack(w, "pin.sh", {}, [], w.work, copy).stdout.trim();
    spawnSync("sh", ["-c", `echo '# x' >> "${join(copy, "s3-access.json")}"`]);
    expect(runPack(w, "pin.sh", {}, [], w.work, copy).stdout.trim()).not.toBe(before);
    symlinkSync("/etc/hosts", join(copy, "link"));
    const r = runPack(w, "pin.sh", {}, [], w.work, copy);
    expect(r.status).toBe(3);
    expect(r.stdout.trim()).toBe("");
  });
});
