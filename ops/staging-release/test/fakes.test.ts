// The fake CLI answers only with fields the real API has (skeletons generated from the botocore models): the class of bug where a script reads a field the API does not return.
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PACK, makeWorld, type World } from "./support/harness.ts";

let w: World;
afterEach(() => w?.cleanup());
const aws = (...args: string[]) => spawnSync(join(w.bin, "aws"), args, { encoding: "utf8", env: { PATH: process.env.PATH ?? "", FAKE_AWS_DIR: w.dir, FAKE_AWS_SKELETONS: join(PACK, "test/fixtures/skeletons") } });

describe("the fake aws CLI conforms to the AWS output models", () => {
  it("refuses an answer with lastUpdatedBy on ListActionExecutions (the real field is updatedBy)", () => {
    w = makeWorld();
    w.answer("codepipeline.list-action-executions.p.json", { actionExecutionDetails: [{ stageName: "Approve", lastUpdatedBy: "arn:x" }] });
    const r = aws("codepipeline", "list-action-executions", "--pipeline-name", "p");
    expect(r.status).toBe(99);
    expect(r.stderr).toContain("FAKE-NONCONFORMING");
    expect(r.stderr).toContain("lastUpdatedBy");
    w.answer("codepipeline.list-action-executions.p.json", { actionExecutionDetails: [{ stageName: "Approve", updatedBy: "arn:x" }] });
    expect(aws("codepipeline", "list-action-executions", "--pipeline-name", "p").status).toBe(0);
  });
  it("refuses an invented field at any depth, and a call that has no skeleton", () => {
    w = makeWorld();
    w.answer("cloudformation.describe-change-set.s.c.json", { Status: "CREATE_COMPLETE", Changes: [{ ResourceChange: { Action: "Modify", Invented: 1 } }] });
    expect(aws("cloudformation", "describe-change-set", "--stack-name", "s", "--change-set-name", "c").stderr).toContain("ResourceChange.Invented");
    w.answer("kms.list-keys.json", { Keys: [] });
    expect(aws("kms", "list-keys").stderr).toContain("NoSkeleton");
  });
  it("has a skeleton for every operation the scripts call through ro/a (a new call needs a skeleton)", () => {
    const have = new Set(readdirSync(join(PACK, "test/fixtures/skeletons")).map((f) => f.replace(/\.json$/, "")));
    const called = new Set<string>();
    for (const f of ["lib/common.sh", "preview.sh", "gates.sh", "deploy.sh", "guard.sh", "postcheck.sh", "settings-record.sh", "build-images.sh", "synth-diffs.sh", "answers-from-deployed.sh", "gates/gate-gateway-runprice.sh", "gates/gate-gateway-deployed.sh", "gates/45-checks.sh", "gates/lib/role_sim.py", "lib/decide_input.py"]) {
      const src = readFileSync(join(PACK, f), "utf8");
      for (const m of src.matchAll(/\b(?:ro|ro_or|a|aws|run)\s+(sts|cloudformation|ssm|ecr|lambda|cloudwatch|ecs|codepipeline|iam|route53resolver|secretsmanager|s3api)\s+([a-z0-9-]+)/g)) called.add(`${m[1]}.${m[2]}`);
      for (const m of src.matchAll(/"(sts|cloudformation|ssm|ecr|lambda|cloudwatch|ecs|codepipeline|iam|route53resolver|secretsmanager|s3api)",\s*"([a-z0-9-]+)"/g)) called.add(`${m[1]}.${m[2]}`);
    }
    called.delete("cloudformation.wait");
    called.delete("ecr.get-login-password");
    for (const c of called) expect(have.has(c), `no skeleton for ${c}`).toBe(true);
  });
});
