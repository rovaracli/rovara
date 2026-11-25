// L9: the rollback floors file (tolerant read, never "no floors" on a bad file) and the rollback-floor gate (fakes only; no AWS, no git).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gate } from "../../ops/pipeline/gates/rollback-floor.gate.ts";
import { FLOORS_PATH, judgeDigest, judgeRef, loadFloors, parseFloors } from "../../ops/pipeline/lib/floors.ts";
import { runPhase } from "../../ops/pipeline/lib/gates.ts";
import { gate as integrity } from "../../ops/pipeline/gates/change-set-integrity.gate.ts";
import type { ChangeSetRecord, GateInput, Manifest } from "../../ops/pipeline/types.ts";
import { DIGEST_A, DIGEST_B, EXEC8, EXEC_ID, config, makePorts, newState, sha } from "./pipeline-stage-fakes.ts";
import type { FakeState } from "./pipeline-stage-fakes.ts";

/** expect.stringMatching typed as a string, so it can sit inside toMatchObject without an any. */
const like = (re: RegExp): string => expect.stringMatching(re) as string;
const FILE = `/p/${FLOORS_PATH}`;
const floorsJson = (over: Record<string, unknown> = {}): string => JSON.stringify({
  schema: 1, about: "t",
  floors: { web: [{ sha: sha("2"), reason: "web train two" }], gateway: [sha("1")] },
  gatewayDigests: { belowFloor: [{ digest: DIGEST_B, reason: "no price bands" }] },
  pending: [{ group: "web", tag: "v0.13.19", sha: sha("4"), when: "Code train 27 is live", reason: "later" }],
  ...over,
});
const manifest = (mode: Manifest["mode"], tag: string, cloudSha: string, digest: string | null = null): Manifest => ({
  schema: 1, executionId: EXEC_ID, exec8: EXEC8, createdAt: "2026-11-24T12:00:00.000Z", mode,
  cloud: { tag, sha: cloudSha, ref: "CLOUD_REF", trunk: "cloud/next", liveSha: { beta: null, production: null } },
  code: { sha: null, release: "run", requestedRelease: "run", pinnedSha: { beta: null, production: null }, supersedes: null },
  gateway: { digest, source: digest === null ? null : "supplied", imageTag: null, repository: null }, stages: {},
});
const cs = (part: "web" | "gateway"): ChangeSetRecord => ({ part, stack: `s-${part}`, changeSetName: "n", changeSetId: "i", noChanges: false, status: "CREATE_COMPLETE", executionStatus: "AVAILABLE", templateSha256: "h", rows: [], counts: { add: 0, modify: 0, remove: 0, replace: 0 }, previewedAt: "x", executedAt: null, finalStatus: null });
const input = (state: FakeState, m: Manifest, phase: GateInput["phase"] = "preflight", changeSets: ChangeSetRecord[] = []): GateInput => ({
  env: "beta", phase, region: "us-east-1", config, manifest: m, changeSets, dirs: { pipeline: "/p", cloud: "/c", out: "/out", work: "/w" }, ports: makePorts(state), log: () => {},
});
const world = (file: string | null = floorsJson()): FakeState => newState(file === null ? {} : { files: { [FILE]: file } });

describe("rollback floors file: tolerant read", () => {
  it("accepts a bare sha or an object, defaults a missing reason, ignores unknown keys and says so", () => {
    const floors = parseFloors(floorsJson({ somethingNew: { a: 1 } }));
    expect(floors.floors).toEqual([
      { group: "web", sha: sha("2"), reason: "web train two" },
      { group: "gateway", sha: sha("1"), reason: `the gateway floor in ${FLOORS_PATH}` },
    ]);
    expect(floors.belowFloorDigests).toEqual([{ digest: DIGEST_B, reason: "no price bands" }]);
    expect(floors.ignored).toEqual(["somethingNew"]);
  });

  it("keeps an entry that is not a full sha (so the gate can fail on it) and a floor group of any name", () => {
    const floors = parseFloors(floorsJson({ floors: { web: ["abc1234"], newgroup: [{ sha: sha("3"), reason: "r" }] } }));
    expect(floors.floors).toEqual([{ group: "web", sha: null, reason: `the web floor in ${FLOORS_PATH}` }, { group: "newgroup", sha: sha("3"), reason: "r" }]);
  });

  it("refuses a file that is missing, not JSON, the wrong schema or without floors (never read as no floors)", () => {
    expect(() => loadFloors(makePorts(newState()), "/p")).toThrow(/missing from the pipeline tree/);
    expect(() => parseFloors("{")).toThrow(/not JSON/);
    expect(() => parseFloors(JSON.stringify({ schema: 2, floors: {} }))).toThrow(/no schema 1/);
    expect(() => parseFloors(JSON.stringify({ schema: 1 }))).toThrow(/no floors object/);
    expect(() => parseFloors(JSON.stringify({ schema: 1, floors: { web: "x" } }))).toThrow(/not a list/);
  });

  it("the committed file parses, names full shas, carries the floors the plan lists and pins the digest below the gateway floor", () => {
    const floors = parseFloors(readFileSync(new URL("../../ops/pipeline/rollback-floors.json", import.meta.url), "utf8"));
    expect(floors.floors.map((f) => f.group).sort()).toEqual(["code", "gateway", "gateway", "web", "web"]);
    expect(floors.floors.every((f) => f.sha !== null && f.reason.length > 20)).toBe(true);
    expect(floors.floors.find((f) => f.group === "web")!.sha!.startsWith("fbe943520")).toBe(true);
    expect(floors.belowFloorDigests.map((d) => d.digest.slice(0, 15))).toEqual(["sha256:68af1b9e"]);
    expect(floors.pending[0]).toMatchObject({ tag: "v0.13.19", when: like(/train 27/u) });
    expect(floors.ignored).toEqual([]);
  });

  it("enforces the Bedrock no_answer floor in all three groups (web and gateway at the Cloud train commit, Code at the Code merge of BEDROCK-BYO-CHECK-FIXES); nothing of it is pending (older readers fail the whole company document)", () => {
    const floors = parseFloors(readFileSync(new URL("../../ops/pipeline/rollback-floors.json", import.meta.url), "utf8"));
    const enforced = floors.floors.filter((floor) => /no_answer/u.test(floor.reason));
    expect(enforced.map((floor) => floor.group).sort()).toEqual(["code", "gateway", "web"]);
    for (const floor of enforced) expect(floor.reason).toMatch(/whole company product-AI document/u);
    expect(enforced.filter((floor) => floor.group !== "code").every((floor) => floor.sha === "59edd60f2bff237a42a06380222269264e6889d5")).toBe(true);
    expect(enforced.find((floor) => floor.group === "code")!.sha).toBe("5e6c41b127a3be962f8e9790f98dc6420b0f3c1e");
    expect(floors.pending.filter((row) => row.tag === "BEDROCK-BYO-CHECK-FIXES")).toEqual([]);
  });
});

describe("judging a ref and a digest", () => {
  it("passes a ref equal to or above every floor and names the floor's reason for one below", async () => {
    const floors = parseFloors(floorsJson());
    const ports = makePorts(newState());
    expect((await judgeRef(ports, floors, { tag: "v0.13.9", sha: sha("3") })).failures).toEqual([]);
    expect((await judgeRef(ports, floors, { tag: "v0.13.2", sha: sha("2") })).failures).toEqual([]);
    const below = await judgeRef(ports, floors, { tag: "v0.13.1", sha: sha("1") });
    expect(below.failures).toEqual([`v0.13.1 (${sha("1").slice(0, 12)}) is below the web floor ${sha("2").slice(0, 12)}: web train two`]);
    expect(below.notes.join(" ")).toMatch(/pending floor \(not enforced\): web v0\.13\.19 once Code train 27 is live/);
  });

  it("fails (never passes) when a floor is not a full sha or git does not know it", async () => {
    const ports = makePorts(newState());
    const shaless = await judgeRef(ports, parseFloors(floorsJson({ floors: { web: ["abc"] } })), { tag: "v0.13.9", sha: sha("3") });
    expect(shaless.failures[0]).toMatch(/not a full 40-hex sha/);
    const unknown = await judgeRef(ports, parseFloors(floorsJson({ floors: { web: [{ sha: sha("8"), reason: "gone" }] } })), { tag: "v0.13.9", sha: sha("3") });
    // The fake treats a floor outside the history as "not an ancestor" (false), which is also a refusal.
    expect(unknown.failures).toHaveLength(1);
    const noDescendant = makePorts(newState());
    const thrown = await judgeRef(noDescendant, parseFloors(floorsJson()), { tag: "v9", sha: sha("9") });
    expect(thrown.failures.every((f) => /not in this repository/.test(f))).toBe(true);
  });

  it("refuses a gateway digest the file lists as below the floor, and only that one", () => {
    const floors = parseFloors(floorsJson());
    expect(judgeDigest(floors, DIGEST_B)).toEqual([`gateway digest ${DIGEST_B.slice(0, 19)}... is below the gateway floor: no price bands`]);
    expect(judgeDigest(floors, DIGEST_A)).toEqual([]);
  });
});

describe("the rollback-floor gate", () => {
  it("fails a rollback below a floor with the reason, and passes one at the floor", async () => {
    const bad = await gate.run(input(world(), manifest("rollback", "v0.13.1", sha("1"))));
    expect(bad.result).toBe("fail");
    expect(bad.failures!.join(" ")).toMatch(/below the web floor .*web train two/);
    expect((await gate.run(input(world(), manifest("rollback", "v0.13.2", sha("2"))))).result).toBe("pass");
  });

  it("applies in a release too (a rollback cannot be told from a release while the live sha is unknown)", async () => {
    expect((await gate.run(input(world(), manifest("release", "v0.13.1", sha("1"))))).result).toBe("fail");
    expect((await gate.run(input(world(), manifest("release", "v0.13.10", sha("4"))))).result).toBe("pass");
  });

  it("skips an adoption run with a reason", async () => {
    expect(await gate.run(input(world(), manifest("adoption", "v0.13.1", sha("1"))))).toMatchObject({ result: "skipped", skippedReason: like(/already live/u) });
  });

  it("fails when the floors file is missing or broken, never passes", async () => {
    for (const file of [null, "{", JSON.stringify({ schema: 9 })]) {
      const out = await gate.run(input(world(file), manifest("release", "v0.13.10", sha("4"))));
      expect(out.result).toBe("fail");
    }
  });

  it("judges the gateway digest with the gateway change set, and says why it skips the web and app change sets", async () => {
    const m = manifest("rollback", "v0.13.9", sha("3"), DIGEST_B);
    const gateway = await gate.run(input(world(), m, "change-sets", [cs("gateway")]));
    expect(gateway).toMatchObject({ result: "fail", failures: [like(/no price bands/u)] });
    expect((await gate.run(input(world(), manifest("rollback", "v0.13.9", sha("3"), DIGEST_A), "change-sets", [cs("gateway")]))).result).toBe("pass");
    expect(await gate.run(input(world(), m, "change-sets", [cs("web")]))).toMatchObject({ result: "skipped", skippedReason: like(/judged in preflight/u) });
  });

  it("stops a preflight through the runner (exit 20 path) with the floor's reason in the verdict file", async () => {
    const state = world();
    const result = await runPhase({ env: "beta", phase: "preflight", region: "us-east-1", config, gates: [gate, integrity], required: ["rollback-floor"], manifest: manifest("rollback", "v0.13.1", sha("1")), changeSets: [], dirs: { pipeline: "/p", cloud: null, out: "/out", work: "/w" }, ports: makePorts(state), log: () => {} });
    expect(result).toMatchObject({ failed: true, missing: [] });
    expect(JSON.parse(state.files["/out/gates/preflight-rollback-floor.json"]!)).toMatchObject({ result: "fail", failures: [like(/web train two/u)] });
  });
});
