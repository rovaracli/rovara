import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeWorld, runShim, type World } from "./support/harness.ts";

let w: World;
afterEach(() => w?.cleanup());

describe("the shim (lib/common.sh)", () => {
  it("refuses an environment that is not staging", () => {
    w = makeWorld();
    const r = runShim(w, "pack_init", { ENVIRONMENT: "production" });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("staging pipeline only");
  });
  it("refuses a region other than us-west-2", () => {
    w = makeWorld();
    expect(runShim(w, "pack_init", { AWS_REGION: "us-east-1" }).status).toBe(3);
    expect(runShim(w, "pack_init", { AWS_DEFAULT_REGION: "eu-west-1" }).status).toBe(3);
    expect(runShim(w, "pack_init", { AWS_REGION: "us-west-2" }).status).toBe(0);
  });
  it("refuses an unsafe RUN_DIR", () => {
    w = makeWorld();
    for (const bad of ["/", ".", "..", "a/../b"]) expect(runShim(w, "pack_init", { RUN_DIR: bad }).status).toBe(3);
  });
  it("derives the change set name from the execution id and rejects a bad id or sha", () => {
    w = makeWorld();
    const ok = runShim(w, 'pack_init; echo "$CS_NAME"', { EXEC_ID: "0123abcd-0000-4000-8000-000000000000", RELEASE_SHA: "a".repeat(40) });
    expect(ok.stdout.trim()).toBe("rovara-pipeline-0123abcd");
    expect(runShim(w, "pack_init", { EXEC_ID: "not-an-id" }).status).toBe(3);
    expect(runShim(w, "pack_init", { RELEASE_SHA: "abc" }).status).toBe(3);
  });
  it("asks STS for the account and refuses a bad answer", () => {
    w = makeWorld();
    expect(runShim(w, 'require_account; echo "$ACCOUNT"').stdout.trim()).toBe("111111111111");
    w.answer("sts.get-caller-identity.json", { Account: "nope" });
    expect(runShim(w, "require_account").status).toBe(3);
  });
  it("ro refuses write verbs, secret reads and decryption", () => {
    w = makeWorld();
    for (const bad of ["cloudformation delete-stack --stack-name x", "secretsmanager get-secret-value --secret-id x", "ssm get-parameter --name x --with-decryption", "s3api put-object", "lambda invoke --function-name x", "ssm put-parameter --name x"]) {
      const r = runShim(w, `ro ${bad}`);
      expect(r.status, bad).toBe(3);
      expect(r.stderr).toContain("REFUSED");
    }
  });
  it("ro removes Environment blocks from Lambda reads", () => {
    w = makeWorld();
    w.answer("lambda.get-function-configuration.fn1.json", { FunctionName: "fn1", LastUpdateStatus: "Successful", Environment: { Variables: { KEY: "secret-value" } } });
    const r = runShim(w, "ro lambda get-function-configuration --function-name fn1");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Successful");
    expect(r.stdout).not.toContain("secret-value");
  });
  it("writes a gate marker in the evaluator's shape", () => {
    w = makeWorld();
    const sha = "b".repeat(40);
    const r = runShim(w, 'pack_init; gate_marker 45-gate pass; gate_marker 46-gate skipped "DEC 254zzz397"; gate_marker 50-dry-run fail "" ready-guard "other"', { RELEASE_SHA: sha });
    expect(r.status, r.stderr).toBe(0);
    const g = (n: string) => JSON.parse(readFileSync(join(w.work, "out/gates", `${n}.json`), "utf8")) as Record<string, unknown>;
    expect(g("45-gate")).toMatchObject({ name: "45-gate", sha, result: "pass", failures: [] });
    expect(g("46-gate")).toMatchObject({ result: "skipped", skippedReason: "DEC 254zzz397" });
    expect(g("50-dry-run")).toMatchObject({ result: "fail", failures: ["ready-guard", "other"] });
    expect(g("45-gate").writtenAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });
  it("has no default overrides file", () => {
    w = makeWorld();
    expect(runShim(w, "overrides_file").status).toBe(3);
    writeFileSync(join(w.work, "o.json"), JSON.stringify({ runtime: { WorkerImageUri: "x" } }));
    const r = runShim(w, "overrides_get runtime WorkerImageUri", { OVERRIDES_FILE: join(w.work, "o.json") });
    expect(r.stdout.trim()).toBe("x");
    expect(existsSync(join(w.work, "o.json"))).toBe(true);
  });
  it("order_parts never lists the access stack", () => {
    w = makeWorld();
    const r = runShim(w, "pack_init; order_parts");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(["control-plane", "runtime", "slack", "foundation", "identity"]);
  });
});
