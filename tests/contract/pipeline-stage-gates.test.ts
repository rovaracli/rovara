import { describe, expect, it } from "vitest";
import { discoverGates, mergeGateRecords, runPhase } from "../../ops/pipeline/lib/gates.ts";
import { gate as integrity } from "../../ops/pipeline/gates/change-set-integrity.gate.ts";
import { gate as backfill } from "../../ops/pipeline/gates/own-key-backfill.gate.ts";
import { gate as gitleaks, WORK_NAMES, configExtras, describeFindings } from "../../ops/pipeline/gates/gitleaks.gate.ts";
import { readFileSync } from "node:fs";
import { countRows } from "../../ops/pipeline/lib/changesets.ts";
import type { ChangeRow, ChangeSetRecord, Gate, GateInput, Manifest, PipelineEnv } from "../../ops/pipeline/types.ts";
import { CDK_METADATA, EXEC8, EXEC_ID, FAKE_ACCOUNT, MODIFY_FUNCTION, config, makePorts, newState, row, sha } from "./pipeline-stage-fakes.ts";

const manifest = (mode: Manifest["mode"] = "release"): Manifest => ({
  schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "2026-11-24T12:00:00.000Z", mode,
  cloud: { tag: "v0.13.10", sha: sha("4"), ref: "latest-tag", trunk: "cloud/next", liveSha: { beta: null, production: null } },
  code: { sha: null, release: "run", requestedRelease: "run", pinnedSha: { beta: null, production: null }, supersedes: null },
  gateway: { digest: null, source: null, imageTag: null, repository: null }, stages: {},
});
const cs = (part: "web" | "app" | "gateway", rows: ChangeRow[], over: Partial<ChangeSetRecord> = {}): ChangeSetRecord => ({
  part, stack: `rovara-cloud-beta-${part}`, changeSetName: `rovara-pipeline-${EXEC8}`, changeSetId: "id", noChanges: false, status: "CREATE_COMPLETE", executionStatus: "AVAILABLE",
  templateSha256: "h", rows, counts: countRows(rows), previewedAt: "x", executedAt: null, finalStatus: null, ...over,
});
const input = (over: Partial<GateInput> & { state?: ReturnType<typeof newState>; env?: PipelineEnv } = {}): GateInput => ({
  env: over.env ?? "beta", phase: "change-sets", region: "us-east-1", config, manifest: manifest(), changeSets: [], dirs: { pipeline: "/p", cloud: "/c", out: "/out", work: "/w" },
  ports: makePorts(over.state ?? newState()), log: () => {}, ...over,
});
const fake = (name: string, outcome: () => Promise<{ result: "pass" | "fail" | "skipped"; skippedReason?: string; failures?: string[] }>, extra: Partial<Gate> = {}): Gate => ({ name, phases: ["preflight"], run: outcome, ...extra });
const phaseArgs = (gates: Gate[], required: string[] = [], env: PipelineEnv = "beta") => ({ env, phase: "preflight" as const, region: "us-east-1", config, gates, required, manifest: manifest(), changeSets: [], dirs: { pipeline: "/p", cloud: null, out: "/out", work: "/w" }, ports: makePorts(newState()), log: () => {} });

describe("pipeline stage CLI: the gate runner", () => {
  it("runs every gate of the phase (no stop at the first failure) and writes one verdict JSON per gate", async () => {
    const args = phaseArgs([fake("a-fail", () => Promise.resolve({ result: "fail", failures: ["bad"] })), fake("b-pass", () => Promise.resolve({ result: "pass" })), fake("c-skip", () => Promise.resolve({ result: "skipped", skippedReason: "not here" }))]);
    const result = await runPhase(args);
    expect(result.failed).toBe(true);
    expect(result.records.map((r) => [r.name, r.result])).toEqual([["a-fail", "fail"], ["b-pass", "pass"], ["c-skip", "skipped"]]);
    expect(result.records[2]).toMatchObject({ schema: 1, skippedReason: "not here", executionId: EXEC_ID, cloudSha: sha("4") });
    expect(JSON.parse((args.ports.fs.readText("/out/gates/preflight-a-fail.json"))) as { failures: string[] }).toMatchObject({ failures: ["bad"] });
  });

  it("treats a throw, a skip without a reason and a fail without a message as failures", async () => {
    const result = await runPhase(phaseArgs([
      fake("thrower", () => Promise.reject(new Error("boom"))),
      fake("bare-skip", () => Promise.resolve({ result: "skipped" })),
      fake("mute-fail", () => Promise.resolve({ result: "fail" })),
      fake("odd", () => Promise.resolve({ result: "weird" as "pass" })),
    ]));
    expect(result.records.every((r) => r.result === "fail" && r.failures.length > 0)).toBe(true);
    expect(result.records[0]!.failures[0]).toMatch(/boom/);
    expect(result.records[1]!.failures[0]).toMatch(/without a reason/);
  });

  it("reports a required gate that is not there, and ignores gates of another phase or environment", async () => {
    const other: Gate = { name: "later", phases: ["proof"], run: () => Promise.resolve({ result: "fail", failures: ["no"] }) };
    const prodOnly: Gate = fake("prod-only", () => Promise.resolve({ result: "fail", failures: ["no"] }), { envs: ["production"] });
    const result = await runPhase(phaseArgs([other, prodOnly], ["needed"]));
    expect(result).toMatchObject({ failed: false, missing: ["needed"], records: [] });
  });

  it("replaces the records of a retried phase and keeps the others", () => {
    const old = [{ phase: "preflight", name: "a", scope: null, result: "fail" }, { phase: "proof", name: "p", scope: null, result: "pass" }, { phase: "change-sets", name: "c", scope: "app+web", result: "pass" }] as never[];
    const merged = mergeGateRecords(old, [{ phase: "preflight", name: "a", scope: null, result: "pass" }, { phase: "change-sets", name: "c", scope: "gateway", result: "pass" }] as never[]);
    expect(merged.map((r) => `${(r as { phase: string }).phase}/${(r as { name: string }).name}/${(r as { scope: string | null }).scope ?? ""}/${(r as { result: string }).result}`)).toEqual(["proof/p//pass", "change-sets/c/app+web/pass", "preflight/a//pass", "change-sets/c/gateway/pass"]);
  });

  it("discovers gate files and refuses a broken one", async () => {
    const state = newState();
    state.files["/g/x-gate.gate.ts"] = "";
    state.files["/g/readme.md"] = "";
    const load = (): Promise<Record<string, unknown>> => Promise.resolve({ gate: fake("x-gate", () => Promise.resolve({ result: "pass" })) });
    expect((await discoverGates(makePorts(state), "/g", load)).map((g) => g.name)).toEqual(["x-gate"]);
    await expect(discoverGates(makePorts(state), "/g", () => Promise.resolve({ gate: fake("other-name", () => Promise.resolve({ result: "pass" })) }))).rejects.toThrow(/must export a gate named x-gate/);
    await expect(discoverGates(makePorts(state), "/g", () => Promise.resolve({}))).rejects.toThrow(/must export a gate/);
  });

  it("discovers the real gates of the tree", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const ports = makePorts(newState());
    ports.fs.readdir = (p) => readdirSync(p);
    const dir = new URL("../../ops/pipeline/gates", import.meta.url).pathname;
    const found = (await discoverGates(ports, dir)).map((g) => g.name);
    // Every gate the policy requires exists as a file (a lane that adds a name to gate-policy.json must add its gate).
    const policy = JSON.parse(readFileSync(new URL("../../ops/pipeline/gate-policy.json", import.meta.url), "utf8")) as { required: Record<string, string[]> };
    for (const names of Object.values(policy.required)) for (const name of names) expect(found).toContain(name);
    expect(found).toEqual(["canary", "change-set-integrity", "deployed-drift", "gateway-digest-equal", "gateway-runprice", "gateway-settled", "gitleaks", "own-key-backfill", "price-freshness", "protected", "rollback-floor"]);
  });
});

describe("pipeline stage CLI: gate change-set-integrity", () => {
  it("passes recorded change sets under the execution's name", async () => {
    expect((await integrity.run(input({ changeSets: [cs("web", [MODIFY_FUNCTION]), cs("app", [], { noChanges: true, changeSetId: null, templateSha256: null, status: null, executionStatus: null })] }))).result).toBe("pass");
  });

  it("fails a wrong name, a missing id or hash, a bad status, a duplicate stack, or no change set at all", async () => {
    const result = await integrity.run(input({ changeSets: [cs("web", [], { changeSetName: "hand-made" }), cs("web", [], { changeSetId: null }), cs("app", [], { executionStatus: "OBSOLETE" })] }));
    expect(result.result).toBe("fail");
    const text = (result.failures ?? []).join("\n");
    expect(text).toMatch(/not rovara-pipeline-1a2b3c4d/);
    expect(text).toMatch(/more than one/);
    expect(text).toMatch(/no id or template hash/);
    expect(text).toMatch(/not CREATE_COMPLETE\/AVAILABLE/);
    expect((await integrity.run(input())).failures?.[0]).toMatch(/no change set was recorded/);
  });

  it("adoption allows nothing but the CDK metadata row", async () => {
    const adoption = (rows: ChangeRow[]) => integrity.run(input({ manifest: manifest("adoption"), changeSets: [cs("web", rows)] }));
    expect((await adoption([CDK_METADATA])).result).toBe("pass");
    const bad = await adoption([CDK_METADATA, row("Add", "ImageRow", "AWS::ECS::TaskDefinition"), row("Modify", "Fn", "AWS::Lambda::Function")]);
    expect(bad.result).toBe("fail");
    expect(bad.failures).toHaveLength(2);
    expect((await integrity.run(input({ manifest: manifest("release"), changeSets: [cs("web", [MODIFY_FUNCTION])] }))).result).toBe("pass");
  });
});

describe("pipeline stage CLI: gate own-key-backfill", () => {
  it("skips, with the reason, when the tree has no such script", async () => {
    const result = await backfill.run(input({ phase: "preflight" }));
    expect(result).toMatchObject({ result: "skipped" });
    expect(result.skippedReason).toMatch(/predates the check/);
  });

  it("runs the check with the env's lookup role, web stack and marker, and fails on a non-zero exit", async () => {
    const state = newState();
    state.files["/c/scripts/agent-own-key-backfill.mjs"] = "";
    state.exec = () => ({ code: 0, stdout: "ok", stderr: "" });
    expect((await backfill.run(input({ phase: "preflight", state }))).result).toBe("pass");
    const call = state.calls.find((c) => c.startsWith("exec node "))!;
    expect(call).toContain("--check --release-stack rovara-cloud-beta-web");
    expect(call).toContain(`--lookup-role arn:aws:iam::${FAKE_ACCOUNT}:role/cdk-hnb659fds-lookup-role-${FAKE_ACCOUNT}-us-east-1`);
    expect(call).toContain("--marker /rovara-cloud/beta/release-checks/agent-own-key-backfill --region us-east-1");
    state.exec = () => ({ code: 1, stdout: "", stderr: "marker missing" });
    const failed = await backfill.run(input({ phase: "preflight", state }));
    expect(failed.result).toBe("fail");
    expect(failed.failures?.[0]).toMatch(/exited 1.*marker missing/);
  });
});

const GITLEAKS_CONFIG = '# comment\ntitle = "Rovara Cloud secret scan"\n\n[extend]\nuseDefault = true\n';
const gitleaksState = (config: string | null = GITLEAKS_CONFIG) => {
  const state = newState();
  if (config !== null) state.files["/p/.gitleaks.toml"] = config;
  return state;
};

describe("pipeline stage CLI: gate gitleaks", () => {
  it("scans a clean export of the tracked files with the pipeline tree's config (--config), and passes on exit 0", async () => {
    const state = gitleaksState();
    expect((await gitleaks.run(input({ phase: "preflight", state }))).result).toBe("pass");
    expect(state.calls.some((c) => c.startsWith("exec bash -c") && c.includes("git -C") && c.includes("archive"))).toBe(true);
    expect(state.calls).toContain("exec gitleaks dir --no-banner --redact --exit-code 1 --ignore-gitleaks-allow --config /p/.gitleaks.toml -i /w/gitleaks-no-ignore /w/gitleaks-tree");
  });

  it("fails when gitleaks finds something, is missing, or the export fails", async () => {
    const state = gitleaksState();
    state.exec = (cmd) => (cmd === "gitleaks" ? { code: 1, stdout: "", stderr: "1 leaks found" } : { code: 0, stdout: "", stderr: "" });
    expect((await gitleaks.run(input({ phase: "preflight", state }))).failures?.[0]).toMatch(/leaks found/);
    state.exec = (cmd) => (cmd === "gitleaks" ? { code: 127, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" });
    expect((await gitleaks.run(input({ phase: "preflight", state }))).failures?.[0]).toMatch(/not installed/);
    state.exec = (cmd) => (cmd === "bash" ? { code: 1, stdout: "", stderr: "tar failed" } : { code: 0, stdout: "", stderr: "" });
    expect((await gitleaks.run(input({ phase: "preflight", state }))).failures?.[0]).toMatch(/could not export/);
  });

  it("never scans without its config, and refuses a config with any allow entry (nothing runs)", async () => {
    const missing = gitleaksState(null);
    expect((await gitleaks.run(input({ phase: "preflight", state: missing }))).failures?.[0]).toMatch(/config .*\.gitleaks\.toml is missing/);
    expect(missing.calls.some((c) => c.startsWith("exec gitleaks"))).toBe(false);
    for (const extra of ['[allowlist]\npaths = ["tests/"]', '[[allowlists]]\nregexes = ["x"]', '[[rules]]\nid = "x"', 'stopwords = ["x"]', "useDefault = false", '[extend]\npath = "other.toml"']) {
      const state = gitleaksState(`${GITLEAKS_CONFIG}${extra}\n`);
      const result = await gitleaks.run(input({ phase: "preflight", state }));
      expect(result.result, extra).toBe("fail");
      expect(result.failures?.[0], extra).toMatch(/no allowlist or rule change is allowed/);
      expect(state.calls.some((c) => c.startsWith("exec gitleaks")), extra).toBe(false);
    }
  });

  it("fails on any tracked .gitleaksignore, at the root or deeper, before it scans (it would switch findings off)", async () => {
    for (const path of [".gitleaksignore", "packages/x/.gitleaksignore"]) {
      const state = gitleaksState();
      state.exec = (cmd, args) => (cmd === "git" && args.includes("ls-tree") ? { code: 0, stdout: `a.ts\0${path}\0`, stderr: "" } : { code: 0, stdout: "", stderr: "" });
      const result = await gitleaks.run(input({ phase: "preflight", state }));
      expect(result.result, path).toBe("fail");
      expect(result.failures?.[0], path).toMatch(/tracks a \.gitleaksignore/);
      expect(state.calls.some((c) => c.startsWith("exec gitleaks")), path).toBe(false);
    }
  });

  it("fails when the export is not the tracked tree (export-ignore drops a file, or something extra appears), and passes when they are equal", async () => {
    const world = (tracked: string[], exported: string[]) => {
      const state = gitleaksState();
      state.exec = (cmd, args) => {
        if (cmd === "git" && args.includes("ls-tree")) return { code: 0, stdout: tracked.map((f) => `${f}\0`).join(""), stderr: "" };
        if (cmd === "bash" && args.includes("list")) return { code: 0, stdout: exported.map((f) => `./${f}\0`).join(""), stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      };
      return state;
    };
    const dropped = world(["a.ts", "secrets/k.ts"], ["a.ts"]);
    const droppedResult = await gitleaks.run(input({ phase: "preflight", state: dropped }));
    expect(droppedResult.result).toBe("fail");
    expect(droppedResult.failures?.[0]).toMatch(/1 tracked file\(s\) missing from the export.*secrets\/k\.ts/);
    expect(dropped.calls.some((c) => c.startsWith("exec gitleaks"))).toBe(false);
    const extra = world(["a.ts"], ["a.ts", "b.ts"]);
    expect((await gitleaks.run(input({ phase: "preflight", state: extra }))).failures?.[0]).toMatch(/1 extra/);
    expect((await gitleaks.run(input({ phase: "preflight", state: world(["a.ts", "d/b.ts"], ["d/b.ts", "a.ts"]) }))).result).toBe("pass");
  });

  it("fails on a tracked node_modules/ directory or a gitleaks config other than the root one, before it scans (the default config skips both)", async () => {
    for (const [path, text] of [["node_modules/x/index.js", /under node_modules\//], ["packages/a/node_modules/y.js", /under node_modules\//], ["sub/gitleaks.toml", /gitleaks config other than the root/], ["gitleaks.toml", /gitleaks config other than the root/], ["docs/.gitleaks.toml", /gitleaks config other than the root/], ["x/My-GitLeaks.TOML", /gitleaks config other than the root/]] as const) {
      const state = gitleaksState();
      state.exec = (cmd, args) => (cmd === "git" && args.includes("ls-tree") ? { code: 0, stdout: `a.ts\0${path}\0`, stderr: "" } : { code: 0, stdout: "", stderr: "" });
      const result = await gitleaks.run(input({ phase: "preflight", state }));
      expect(result.result, path).toBe("fail");
      expect(result.failures?.join("\n"), path).toMatch(text);
      expect(state.calls.some((c) => c.startsWith("exec gitleaks")), path).toBe(false);
    }
    // the root .gitleaks.toml and a path that merely contains the words are fine
    const ok = gitleaksState();
    ok.exec = (cmd, args) => (cmd === "git" && args.includes("ls-tree") ? { code: 0, stdout: ".gitleaks.toml\0src/node_modules_note.ts\0", stderr: "" } : cmd === "bash" && args.includes("list") ? { code: 0, stdout: "./.gitleaks.toml\0./src/node_modules_note.ts\0", stderr: "" } : { code: 0, stdout: "", stderr: "" });
    expect((await gitleaks.run(input({ phase: "preflight", state: ok }))).result).toBe("pass");
  });

  it("scans a second copy of every tracked file under neutral names with the same config, and reports a finding there by its tracked path", async () => {
    const state = gitleaksState();
    expect((await gitleaks.run(input({ phase: "preflight", state }))).result).toBe("pass");
    const copy = state.calls.find((c) => c.startsWith("exec node -e") && c.includes("ARCHIVE_MAGIC"))!;
    expect(copy).toContain('padStart(5, "0") + ".txt"');
    expect(copy).toContain('Buffer.from("\\n"), body');
    expect(copy).toContain("/w/gitleaks-tree /w/gitleaks-as-text /w/gitleaks-as-text-map.tsv /w/gitleaks-archives.txt");
    expect(state.calls.filter((c) => c.startsWith("exec gitleaks"))).toEqual([
      "exec gitleaks dir --no-banner --redact --exit-code 1 --ignore-gitleaks-allow --config /p/.gitleaks.toml -i /w/gitleaks-no-ignore /w/gitleaks-tree",
      "exec gitleaks dir --no-banner --redact --exit-code 1 --ignore-gitleaks-allow --config /p/.gitleaks.toml -i /w/gitleaks-no-ignore --report-format json --report-path /w/gitleaks-as-text-report.json /w/gitleaks-as-text",
    ]);
    // the first scan is clean and the second finds something: the gate fails and names the tracked path, not the neutral name
    const found = gitleaksState();
    let scans = 0;
    found.exec = (cmd) => (cmd === "gitleaks" ? ((scans += 1) === 2 ? { code: 1, stdout: "", stderr: "leaks found: 1" } : { code: 0, stdout: "", stderr: "" }) : { code: 0, stdout: "", stderr: "" });
    found.files["/w/gitleaks-as-text-map.tsv"] = "00001.txt\ta.ts\n00002.txt\tassets/logo.svg\n";
    found.files["/w/gitleaks-as-text-report.json"] = JSON.stringify([{ RuleID: "github-pat", File: "/w/gitleaks-as-text/00002.txt", StartLine: 7, Secret: "REDACTED" }]);
    const result = await gitleaks.run(input({ phase: "preflight", state: found }));
    expect(result.result).toBe("fail");
    expect(result.failures?.[0]).toMatch(/second scan.*github-pat assets\/logo\.svg:6/);
    // an archive the copy step listed fails the gate before the second scan
    const archived = gitleaksState();
    archived.files["/w/gitleaks-archives.txt"] = "dist/a.zip\nb/c.tgz\n";
    const archivedResult = await gitleaks.run(input({ phase: "preflight", state: archived }));
    expect(archivedResult.failures?.[0]).toMatch(/tracks 2 archive file\(s\) by content \(dist\/a\.zip, b\/c\.tgz\)/);
    expect(archived.calls.filter((c) => c.startsWith("exec gitleaks")).length).toBe(1);
    // the copy failing, and gitleaks missing on the second run, fail too
    const broken = gitleaksState();
    broken.exec = (cmd, args) => (cmd === "node" && args.includes("-e") ? { code: 1, stdout: "", stderr: "cp failed" } : { code: 0, stdout: "", stderr: "" });
    expect((await gitleaks.run(input({ phase: "preflight", state: broken }))).failures?.[0]).toMatch(/could not copy the tree for the second/);
    expect(describeFindings("not json", "")).toEqual([]);
    expect(describeFindings(JSON.stringify([{ RuleID: "r", File: "/x/00009.txt", StartLine: 3 }]), "")).toEqual(["r 00009.txt:2"]);
  });

  it("refuses a work directory whose path holds an allowlisted part (gitleaks would scan nothing under it), and a differently-cased node_modules in the tree", async () => {
    for (const work of ["/w/node_modules/x", "/Node_Modules", "/w/vendor/run", "/w/gitleaks.toml.d", "/w/a/vendor"]) {
      const state = gitleaksState();
      const result = await gitleaks.run(input({ phase: "preflight", state, dirs: { pipeline: "/p", cloud: "/c", out: "/out", work } }));
      expect(result.result, work).toBe("fail");
      expect(result.failures?.[0], work).toMatch(/work directory .* has node_modules, vendor or gitleaks\.toml in its path/);
      expect(state.calls.some((c) => c.startsWith("exec gitleaks") || c.startsWith("exec git ")), work).toBe(false);
    }
    const fine = gitleaksState();
    expect((await gitleaks.run(input({ phase: "preflight", state: fine, dirs: { pipeline: "/p", cloud: "/c", out: "/out", work: "/tmp/rovara-pipeline-1a2b3c4d" } }))).result).toBe("pass");
    const cased = gitleaksState();
    cased.exec = (cmd, args) => (cmd === "git" && args.includes("ls-tree") ? { code: 0, stdout: "a.ts\0web/Node_Modules/x.js\0", stderr: "" } : { code: 0, stdout: "", stderr: "" });
    expect((await gitleaks.run(input({ phase: "preflight", state: cased }))).failures?.join("\n")).toMatch(/under node_modules\//);
  });

  it("removes its copies of the tree, the map and the report at the end: after a pass, a failure at any step, and a throw", async () => {
    const rm = (state: ReturnType<typeof gitleaksState>) => state.calls.filter((c) => c.startsWith("exec rm "));
    const want = `exec rm -rf ${WORK_NAMES.map((n) => `/w/${n}`).join(" ")}`;
    const pass = gitleaksState();
    await gitleaks.run(input({ phase: "preflight", state: pass }));
    expect(rm(pass)).toEqual([want]);
    expect(WORK_NAMES).toEqual(expect.arrayContaining(["gitleaks-tree", "gitleaks-as-text", "gitleaks-as-text-map.tsv", "gitleaks-as-text-report.json"]));
    const failed = gitleaksState();
    failed.exec = (cmd) => (cmd === "gitleaks" ? { code: 1, stdout: "", stderr: "1 leaks found" } : { code: 0, stdout: "", stderr: "" });
    await gitleaks.run(input({ phase: "preflight", state: failed }));
    expect(rm(failed)).toEqual([want]);
    const threw = gitleaksState();
    threw.exec = (cmd) => { if (cmd === "gitleaks") throw new Error("boom"); return { code: 0, stdout: "", stderr: "" }; };
    await expect(gitleaks.run(input({ phase: "preflight", state: threw }))).rejects.toThrow("boom");
    expect(rm(threw)).toEqual([want]);
  });

  it("the committed .gitleaks.toml of this repository has no allow entry", () => {
    const text = readFileSync(new URL("../../.gitleaks.toml", import.meta.url), "utf8");
    expect(configExtras(text)).toEqual([]);
    expect(text).toMatch(/useDefault = true/);
  });
});

export type { PipelineEnv };
