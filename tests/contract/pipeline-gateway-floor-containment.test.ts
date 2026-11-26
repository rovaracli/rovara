// #1478 phase 2 (pre-review MUST-1): what a `gatewayCode` floor row says about its Cloud counterpart must be TRUE. The first version said "blob-equal"; that held for 5 of 5 files of one floor and
// only 4 of 7 of the other (Code's first commit already carries LATER versions of three files). The honest rule is CONTAINMENT: for every gateway file the Cloud floor commit changed,
//   - every line that commit ADDED is present in the Code floor commit's version of the file, and
//   - every line that commit REMOVED is absent from it (a line removed in one place and added in another is a move, and not counted),
// comparing lines with leading/trailing whitespace removed and blank lines ignored. The real-git part needs both repositories (this one, and a Code clone named by ROVARA_CODE_REPO, the variable
// the pipeline itself uses) and is skipped where either commit is not there; the rest always runs (the containment rule on planted cases, and the words of the shipped files).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gatewayCodeFloors, parseFloors } from "../../ops/pipeline/lib/floors.ts";

const GATEWAY_PATHS = ["packages/model-gateway", "environments/model-gateway", "infra/lib/model-gateway.ts", "tsconfig.base.json"];
/** Each Cloud gateway floor commit and the Code commit that stands for it, with the files the Cloud commit changed that are byte-identical in the Code commit (all others are later versions). */
const PAIRS = [
  {
    cloud: "465e372f105b7d413db71259eaa020b499a3796c", code: "d531e8357c4056a9d2a7e54776deecc541971f42",
    changed: ["agent-openai", "charge-receipt", "dynamo-meter", "meter", "openrouter-policy", "server", "source-stop"], identical: ["charge-receipt", "dynamo-meter", "meter", "source-stop"],
  },
  {
    cloud: "59edd60f2bff237a42a06380222269264e6889d5", code: "5e6c41b127a3be962f8e9790f98dc6420b0f3c1e",
    changed: ["bedrock-byo", "bedrock-byo-sessions", "process", "product-keys", "service-call"], identical: ["bedrock-byo", "bedrock-byo-sessions", "process", "product-keys", "service-call"],
  },
] as const;

const lineSet = (text: string): Set<string> => new Set(text.split("\n").map((line) => line.trim()).filter((line) => line !== ""));
const trimmed = (lines: readonly string[]): string[] => lines.map((line) => line.trim()).filter((line) => line !== "");

/** What a diff added and removed (as lines), against the file in the Code commit: the added lines the file lacks, and the removed lines (not re-added elsewhere) it still has. */
function containment(added: readonly string[], removed: readonly string[], codeFile: string): { missing: string[]; stillThere: string[] } {
  const there = lineSet(codeFile);
  const addedSet = new Set(trimmed(added));
  return { missing: trimmed(added).filter((line) => !there.has(line)), stillThere: trimmed(removed).filter((line) => !addedSet.has(line) && there.has(line)) };
}

describe("the containment rule itself", () => {
  const code = ["export function price() {", "  return bands.pick(model);", "}", ""].join("\n");
  it("passes when every added line is present and every removed line is gone (whitespace and blank lines do not count)", () => {
    expect(containment(["  return bands.pick(model);", ""], ["return old(model);"], code)).toEqual({ missing: [], stillThere: [] });
  });
  it("reports an added line the Code file lacks", () => {
    expect(containment(["return bands.pick(model, extra);"], [], code).missing).toEqual(["return bands.pick(model, extra);"]);
  });
  it("reports a removed line the Code file still has", () => {
    expect(containment([], ["return bands.pick(model);"], code).stillThere).toEqual(["return bands.pick(model);"]);
  });
  it("does not count a removed line that the same change added again (a moved line)", () => {
    expect(containment(["return bands.pick(model);"], ["return bands.pick(model);"], code)).toEqual({ missing: [], stillThere: [] });
  });
});

describe("the shipped floors and install text say what is true", () => {
  const raw = readFileSync(new URL("../../ops/pipeline/rollback-floors.json", import.meta.url), "utf8");
  const floors = parseFloors(raw);
  const doc = readFileSync(new URL("../../docs/rovara-cloud-install.md", import.meta.url), "utf8");
  it("no 'blob-equal' or 'byte-identical' claim covers a pair that is not (the first pair: 4 of 7 identical, 3 later versions)", () => {
    expect(raw).not.toMatch(/blob[- ]equal/iu);
    expect(doc).not.toMatch(/blob[- ]equal/iu);
    const reasons = gatewayCodeFloors(floors).map((f) => f.reason);
    expect(reasons[0]).toMatch(/4 of the 7 files .*byte-identical, 3 .*later versions/u);
    expect(reasons[1]).toMatch(/all 5 files are byte-identical/u);
    expect(PAIRS[0].identical).toHaveLength(4);
    expect(PAIRS[0].changed).toHaveLength(7);
    expect(PAIRS[1].identical).toHaveLength(PAIRS[1].changed.length);
  });
  it("every gateway floor of the file has a pair here (a new gateway floor needs its containment checked), and each pair's Code commit is a gatewayCode row", () => {
    const gateway = floors.floors.filter((f) => f.group === "gateway").map((f) => f.sha);
    expect(PAIRS.map((p) => p.cloud).sort()).toEqual([...gateway].sort());
    expect(gatewayCodeFloors(floors).map((f) => f.sha)).toEqual(PAIRS.map((p) => p.code));
  });
});

const run = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const has = (repo: string | undefined, sha: string): boolean => {
  if (repo === undefined || repo === "") return false;
  try { run(repo, "cat-file", "-e", `${sha}^{commit}`); return true; } catch { return false; }
};
const CODE_REPO = process.env.ROVARA_CODE_REPO;
const CLOUD_REPO = process.cwd();
const runnable = PAIRS.every((p) => has(CLOUD_REPO, p.cloud) && has(CODE_REPO, p.code));

describe.skipIf(!runnable)("real git: every change a Cloud gateway floor commit made is contained in its Code counterpart", () => {
  for (const pair of PAIRS) {
    it(`${pair.cloud.slice(0, 9)} -> ${pair.code.slice(0, 9)}: the files, which are byte-identical, and every added/removed line`, () => {
      const repo = CODE_REPO!;
      const files = run(CLOUD_REPO, "diff", "--name-only", `${pair.cloud}^1`, pair.cloud, "--", ...GATEWAY_PATHS).split("\n").filter((f) => f !== "");
      expect(files.map((f) => f.replace(/^.*\/([^/]+)\.ts$/u, "$1")).sort()).toEqual([...pair.changed].sort());
      const identical: string[] = [];
      for (const file of files) {
        const name = file.replace(/^.*\/([^/]+)\.ts$/u, "$1");
        const cloudBlob = run(CLOUD_REPO, "rev-parse", `${pair.cloud}:${file}`).trim();
        const codeBlob = run(repo, "rev-parse", `${pair.code}:${file}`).trim();
        if (cloudBlob === codeBlob) identical.push(name);
        const diff = run(CLOUD_REPO, "diff", "-U0", `${pair.cloud}^1`, pair.cloud, "--", file).split("\n");
        const added = diff.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
        const removed = diff.filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1));
        const found = containment(added, removed, run(repo, "show", `${pair.code}:${file}`));
        expect(found, file).toEqual({ missing: [], stillThere: [] });
        expect(added.length + removed.length, `${file} has a change to check`).toBeGreaterThan(0);
      }
      expect(identical.sort()).toEqual([...pair.identical].sort());
    });
  }
});
