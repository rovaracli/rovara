// Test harness for the gate pack's shell scripts: runs a pack script for real, with a fake `aws` (support/fake-aws.py) on PATH and a world directory the test fills.
// Nothing here touches the network or a real AWS account. Fixtures use the fake account 111111111111.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertS3Covered } from "./s3access.ts";

export const PACK = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FAKE_ACCOUNT = "111111111111";

export interface World {
  dir: string;
  bin: string;
  work: string;
  /** Write a JSON answer (or an error) for the fake CLI: file name is `<svc>.<op>[.<stack>[.<changeset>]|.<selector>].json`. */
  answer(file: string, doc: unknown): void;
  /** Put a file in the fake S3. */
  s3Put(bucket: string, key: string, body: string | Buffer): void;
  s3Get(bucket: string, key: string): string | undefined;
  s3Has(bucket: string, key: string): boolean;
  calls(): string[];
  cleanup(): void;
}

export function makeWorld(): World {
  const root = mkdtempSync(join(tmpdir(), "pack-test-"));
  const dir = join(root, "world");
  const bin = join(root, "bin");
  const work = join(root, "work");
  for (const d of [dir, bin, work, join(dir, "s3")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dir, "calls.log"), "");
  const fake = join(bin, "fake-aws.py");
  copyFileSync(join(PACK, "test/support/fake-aws.py"), fake);
  writeFileSync(join(bin, "aws"), `#!/bin/sh\nexec python3 -I "${fake}" "$@"\n`);
  chmodSync(join(bin, "aws"), 0o755);
  // a fake curl: prints the status code in <world>/curl.code (default 000) and writes <world>/curl.body to the -o file
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nout=""\nwhile [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; esac; shift; done\ncode=$(cat "$FAKE_AWS_DIR/curl.code" 2>/dev/null || echo 000)\n[ -n "$out" ] && [ "$out" != /dev/null ] && { cat "$FAKE_AWS_DIR/curl.body" 2>/dev/null > "$out" || true; }\nprintf '%s' "$code"\n`);
  chmodSync(join(bin, "curl"), 0o755);
  return {
    dir,
    bin,
    work,
    answer(file, doc) {
      writeFileSync(join(dir, file), typeof doc === "string" ? doc : JSON.stringify(doc));
    },
    s3Put(bucket, key, body) {
      const p = join(dir, "s3", bucket, key);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    },
    s3Get(bucket, key) {
      const p = join(dir, "s3", bucket, key);
      return existsSync(p) ? readFileSync(p, "utf8") : undefined;
    },
    s3Has(bucket, key) {
      return existsSync(join(dir, "s3", bucket, key));
    },
    calls() {
      return readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter((l) => l !== "");
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `bash <PACK>/<script> args` in `cwd` (default: the world's work dir) with the fake aws first on PATH. `env` overrides the defaults. */
export function runPack(world: World, script: string, env: Record<string, string> = {}, args: string[] = [], cwd: string = world.work, root: string = PACK): Run {
  const before = world.calls().length;
  const r = spawnSync("bash", [join(root, script), ...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: `${world.bin}:${process.env.PATH ?? ""}`,
      HOME: world.work,
      FAKE_AWS_DIR: world.dir,
      FAKE_AWS_SKELETONS: join(PACK, "test/fixtures/skeletons"),
      ENVIRONMENT: "staging",
      RUN_DIR: join(world.work, "out"),
      ...env,
    },
    timeout: 120_000,
  });
  assertS3Covered(script, world.calls().slice(before));
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Runs a snippet that first sources lib/common.sh (for testing the shim's functions). */
export function runShim(world: World, snippet: string, env: Record<string, string> = {}): Run {
  const r = spawnSync("bash", ["-c", `set -euo pipefail; source "${PACK}/lib/common.sh"; ${snippet}`], {
    cwd: world.work,
    encoding: "utf8",
    env: { PATH: `${world.bin}:${process.env.PATH ?? ""}`, HOME: world.work, FAKE_AWS_DIR: world.dir, FAKE_AWS_SKELETONS: join(PACK, "test/fixtures/skeletons"), ENVIRONMENT: "staging", RUN_DIR: join(world.work, "out"), ...env },
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A copy of the pack in the world's work dir (so a test can edit order.txt, add a symlink, ...). */
export function copyPack(world: World): string {
  const dest = join(world.work, "pack-copy");
  cpSync(PACK, dest, { recursive: true, filter: (src) => !src.includes("/evaluator/test/") && !src.includes("/node_modules") });
  return dest;
}
