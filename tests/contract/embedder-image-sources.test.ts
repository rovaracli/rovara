// The embedder image is built from a clean checkout (CI, the release job, another lane, an Enterprise bundle). Review C1 of lane self-hosted-embeddings: the build tools sat in an ignored
// `build/` folder, so the commit did not hold what the Dockerfile copies and no clean checkout could build the image. This keeps every file the Dockerfile COPYs or ADDs a file git tracks,
// and keeps the install lines of the image honest (hashes, no extra index).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url).pathname;
const context = "environments/embedder";
const dockerfile = readFileSync(join(root, context, "Dockerfile"), "utf8");
const tracked = new Set(execFileSync("git", ["ls-files", "-z", "--", context], { cwd: root, encoding: "utf8" }).split("\0").filter((name) => name !== ""));

/** Every COPY and ADD of the Dockerfile that reads from the build context (not `--from=<stage>`): its source paths, relative to the context. */
function contextSources(): string[] {
  const text = dockerfile.replace(/\\\n/g, " ");
  const sources: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(?:COPY|ADD)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const words = match[1]!.trim().split(/\s+/);
    const flags = words.filter((word) => word.startsWith("--"));
    if (flags.some((flag) => flag.startsWith("--from="))) continue;
    const paths = words.filter((word) => !word.startsWith("--"));
    sources.push(...paths.slice(0, -1));
  }
  return sources;
}

describe("the embedder image's build context", () => {
  it("copies something (the parser finds the COPY lines)", () => {
    const sources = contextSources();
    expect(sources).toEqual(expect.arrayContaining(["requirements-build.lock", "requirements-runtime.lock", "models.lock.json", "app/embedder_core.py", "tools/export_models.py", "tools/parity_check.py", "tools/reference_snapshots.py", "app/"]));
  });

  it("every file a COPY or ADD reads is tracked in git (a clean checkout can build the image)", () => {
    for (const source of contextSources()) {
      const path = posix.normalize(posix.join(context, source));
      expect(existsSync(join(root, path)), `${path} exists`).toBe(true);
      if (statSync(join(root, path)).isDirectory()) {
        const inside = [...tracked].filter((name) => name.startsWith(`${path.replace(/\/$/, "")}/`));
        expect(inside.length, `${path} holds tracked files`).toBeGreaterThan(0);
        // and every file in it that is on disk is tracked (an untracked or ignored file there would be in the image built here and not in CI)
        const onDisk = execFileSync("git", ["ls-files", "-z", "--others", "--exclude-standard", "--", path], { cwd: root, encoding: "utf8" }).split("\0").filter((name) => name !== "");
        expect(onDisk, `${path} has files git does not track`).toEqual([]);
      } else {
        expect(tracked.has(path), `${path} is tracked`).toBe(true);
      }
    }
  });

  it("none of the sources is ignored by git or left out by .dockerignore", () => {
    const dockerignore = readFileSync(join(root, context, ".dockerignore"), "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
    for (const source of contextSources()) {
      const path = posix.normalize(posix.join(context, source));
      // `git check-ignore -q` exits 0 when the path is ignored and 1 when it is not.
      const ignored = ((): boolean => { try { execFileSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: root }); return true; } catch { return false; } })();
      expect(ignored, `${path} is ignored by git`).toBe(false);
      for (const pattern of dockerignore) expect(source === pattern || source.startsWith(`${pattern}/`), `${source} is excluded by .dockerignore (${pattern})`).toBe(false);
    }
  });

  it("the folder of the build tools is not one .gitignore names (the original mistake)", () => {
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8").split("\n").map((line) => line.trim());
    expect(gitignore).toContain("build/");
    expect(existsSync(join(root, context, "build"))).toBe(false);
    for (const tool of ["export_models.py", "parity_check.py", "reference_snapshots.py", "build-image.sh"]) expect(tracked.has(`${context}/tools/${tool}`), tool).toBe(true);
  });

  it("installs every Python package by hash from the lock files, with no extra index and no resolution at build time", () => {
    const installs = dockerfile.replace(/\\\n/g, " ").split("\n").filter((line) => /\bpip install\b/.test(line) && !line.trim().startsWith("#"));
    expect(installs).toHaveLength(2);
    for (const line of installs) expect(line).toMatch(/--require-hashes.*--no-deps|--no-deps.*--require-hashes/);
    expect(dockerfile).not.toMatch(/--extra-index-url|--index-url|sentence-transformers==/);
    expect(dockerfile).toMatch(/RUN --network=none python .*smoke\.py/);
  });
});
