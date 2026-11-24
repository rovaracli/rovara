/* eslint-disable @typescript-eslint/no-explicit-any -- evaluator inputs are plain JSON the tests edit at a path */
import { World, EXEC, OPERATOR, PREFIX, SLACK } from "../../canary/test/fakes.ts";
import { evaluate } from "../../evaluator/src/index.ts";
import type { ExecutionFacts, RollbackContext, RollbackPorts } from "../src/types.ts";
import { cloneDeep } from "../../evaluator/test/clone.ts";
import { codeInput } from "../../evaluator/test/fixtures.ts";

export const SHA_A = "b".repeat(40); // last-good (the evaluator fixtures use this sha)
export const SHA_B = "c".repeat(40); // a deploy whose canary was skipped (cap)
export const SHA_C = "d".repeat(40); // the bad release, installed now
export const EXEC_A = "aaaaaaaa-1111-4222-8333-444455556666";
export const EXEC_B = "bbbbbbbb-1111-4222-8333-444455556666";
export const EXEC_C = "cccccccc-1111-4222-8333-444455556666";
export const R1 = "11111111-1111-4222-8333-444455556666";
export const R2 = "22222222-1111-4222-8333-444455556666";
export const R3 = "33333333-1111-4222-8333-444455556666";

export class RollbackWorld extends World {
  executions = new Map<string, ExecutionFacts>();
  canaryResults = new Map<string, unknown>();
  packages = new Set<string>();
  rollbackStageCalls: string[] = [];
  failExecutionRead = new Set<string>();

  /** The state after: A passed its canary (last-good), B was installed unproven (cap), C is installed and failed, a HOLD from C's FAIL exists. */
  static standard(): RollbackWorld {
    const w = new RollbackWorld();
    w.params.set(`${PREFIX}/code-installed`, SHA_C);
    w.params.set(`${PREFIX}/code-last-good`, SHA_A);
    w.params.set(`${PREFIX}/code-last-good-execution`, EXEC_A);
    w.params.set(`${PREFIX}/code-hold/canary-fail-${EXEC_C.slice(0, 8)}`, "{}");
    w.executions.set(EXEC_A, { executionType: "STANDARD", status: "Succeeded", rollbackTargetId: null, sourceSha: SHA_A });
    w.executions.set(EXEC_B, { executionType: "STANDARD", status: "Succeeded", rollbackTargetId: null, sourceSha: SHA_B });
    w.executions.set(EXEC_C, { executionType: "STANDARD", status: "Failed", rollbackTargetId: null, sourceSha: SHA_C });
    w.executions.set(R1, { executionType: "ROLLBACK", status: "InProgress", rollbackTargetId: EXEC_A, sourceSha: SHA_A });
    w.canaryResults.set(EXEC_A, { result: "PASS", sha: SHA_A, executionId: EXEC_A, executionType: "STANDARD", lastGoodMoved: true });
    w.canaryResults.set(EXEC_B, { result: "SKIPPED-CAP", sha: SHA_B, executionId: EXEC_B, executionType: "STANDARD", lastGoodMoved: false });
    w.packages.add(EXEC_A).add(EXEC_B).add(EXEC_C);
    return w;
  }

  rollbackPorts(): RollbackPorts {
    const base = this.ports();
    /* eslint-disable @typescript-eslint/unbound-method -- the base ports are arrow-function closures that never read `this` */
    return {
      nowMs: base.nowMs,
      getParameter: base.getParameter,
      putHold: base.putHold,
      publish: base.publish,
      writeFile: base.writeFile,
      /* eslint-enable @typescript-eslint/unbound-method */
      listHolds: (dir) => Promise.resolve(this.holdNames().filter((n) => n.startsWith(dir))),
      getExecution: (id) => {
        if (this.failExecutionRead.has(id)) return Promise.reject(new Error("no such execution"));
        const e = this.executions.get(id);
        return e === undefined ? Promise.reject(new Error("no such execution")) : Promise.resolve({ ...e });
      },
      readCanaryResult: (id) => Promise.resolve(this.canaryResults.get(id) ?? null),
      releasePackagePresent: (id) => Promise.resolve(this.packages.has(id)),
      rollbackStage: (target) => {
        this.log("rollback-stage", target);
        this.rollbackStageCalls.push(target);
        return Promise.resolve();
      },
      evaluate: (input) => evaluate(input),
    };
  }

  /** What the canary stage wrote to out/ is what the guard later reads back as canary/<execution>/result.json. */
  recordCanary(executionId: string): void {
    this.canaryResults.set(executionId, JSON.parse(this.files.get("result.json") ?? "null") as unknown);
    this.files.clear();
  }
}

export function ctx(executionId = R1, overrides: Partial<RollbackContext> = {}): RollbackContext {
  return { kind: "code", executionId, executionType: "ROLLBACK", parameterPrefix: PREFIX, topics: { operator: OPERATOR, slack: SLACK }, s3Path: "s3://runs/guard/x/", ...overrides };
}

/** The evaluator input a rollback-preview step would assemble, from the evaluator's own routine Code fixture in rollback mode. */
export function rollbackInput(world: RollbackWorld, edit: (i: Record<string, any>) => void = () => undefined): Record<string, any> {
  const i = cloneDeep(codeInput()) as Record<string, any>;
  i.sha = SHA_A;
  i.previousInstalledSha = world.params.get(`${PREFIX}/code-installed`);
  i.trigger = { kind: "rollback", variables: {}, rollback: { lastGoodSha: SHA_A, floorAncestry: {}, targetIsAncestorOfInstalled: true, priorAutoRollbacksThisHold: 0 } };
  i.holdParameters = world.holdNames();
  edit(i);
  return i;
}

export { EXEC };
