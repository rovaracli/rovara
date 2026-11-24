/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- the tests read the JSON records the scripts write and edit plain JSON documents, which a typed document would not allow */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { copyPack, makeWorld, runPack, type World } from "./support/harness.ts";
import { BUCKET, EXEC_ID, PIPE_ENV, SHA, writeChangeSets, writePackage, writePointers, writeRunRecords, writeStacks } from "./support/fixtures.ts";

let w: World;
let root: string;
const env = (): Record<string, string> => ({ ...PIPE_ENV(w), GATEWAY_HEALTHZ_URL: "https://gateway.example.test/healthz" });
const marker = (n: string): any => JSON.parse(readFileSync(join(w.work, "out/gates", `${n}.json`), "utf8"));
const stub = (name: string, rc: number, line = ""): void => writeFileSync(join(root, "gates", name), `#!/usr/bin/env bash\n${line ? `echo "${line}"\n` : ""}exit ${rc}\n`);

beforeEach(() => {
  w = makeWorld();
  const pkg = writePackage(join(w.work, "release"));
  writeStacks(w); writeChangeSets(w); writePointers(w);
  writeRunRecords(w, pkg);
  for (const f of ["decide/decision.json", "guard/guard.json", "gates/gates/15-gate.json", "gates/gates/25-gate.json", "gates/gates/45-gate.json", "gates/gates/46-gate.json"]) rmSync(join(w.dir, "s3", BUCKET, f.split("/")[0]!, EXEC_ID, ...f.split("/").slice(1)));
  root = copyPack(w);
  for (const n of ["15-role-sim.sh", "25-change-set-gates.sh", "45-checks.sh", "gate-gateway-deployed.sh"]) stub(n, 0);
  writeFileSync(join(w.dir, "curl.code"), "200");
  writeFileSync(join(w.dir, "curl.body"), JSON.stringify({ ok: true, runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 9 } }));
  w.answer("cloudformation.describe-stacks.agentx-staging-control-plane.json", { Stacks: [{ StackStatus: "UPDATE_COMPLETE", Parameters: [], Outputs: [] }] });
});
afterEach(() => w.cleanup());
const gates = () => runPack(w, "gates.sh", env(), [], w.work, root);

describe("gates.sh", () => {
  it("writes one JSON marker per gate in the evaluator's shape; 46 is the standing skip; the dry run fails only ready-guard", () => {
    const r = gates();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const n of ["15-gate", "25-gate", "45-gate", "gate-gateway-runprice", "gate-gateway-deployed"]) expect(marker(n), n).toMatchObject({ name: n, sha: SHA, result: "pass", failures: [] });
    expect(marker("46-gate")).toMatchObject({ result: "skipped", skippedReason: "DEC 254zzz397" });
    expect(marker("50-dry-run")).toMatchObject({ name: "50-dry-run", sha: SHA, result: "pass", failures: ["ready-guard"] });
    expect(marker("15-gate").writtenAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });
  it("a failing gate is data: its [FAIL] lines become the marker's failures, and the stage still exits 0", () => {
    stub("25-change-set-gates.sh", 1, "  [FAIL] G5 an Add row");
    const r = gates();
    expect(r.status).toBe(0);
    expect(marker("25-gate")).toMatchObject({ result: "fail", failures: ["[FAIL] G5 an Add row"] });
    expect(marker("15-gate").result).toBe("pass");
  });
  it("the gateway gate fails on a gateway that does not serve runPrice v1 with the snapshot floor", () => {
    writeFileSync(join(w.dir, "curl.body"), JSON.stringify({ ok: true, runPrice: { version: 1, admissionVersion: 1, snapshotVersion: 3 } }));
    gates();
    expect(marker("gate-gateway-runprice").result).toBe("fail");
    writeFileSync(join(w.dir, "curl.code"), "503");
    gates();
    expect(marker("gate-gateway-runprice").result).toBe("fail");
  });
  it("a dry run with another failing guard besides ready-guard makes the 50-dry-run gate fail", () => {
    writeFileSync(join(w.dir, "s3", BUCKET, `build/${EXEC_ID}/release/answers.json`), "{}");
    gates();
    const m = marker("50-dry-run");
    expect(m.result).toBe("fail");
    expect(m.failures).toContain("package-hash");
  });
  it("refuses without a preview record, and in the wrong region", () => {
    rmSync(join(w.dir, "s3", BUCKET, "preview"), { recursive: true });
    expect(gates().status).toBe(3);
    expect(runPack(w, "gates.sh", { ...env(), AWS_REGION: "us-east-1" }, [], w.work, root).status).toBe(3);
  });
});
