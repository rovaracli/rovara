// Gate (#1478 phase 2): the FIRST gateway change set made from Code's CDK app must change no resource of the gateway stack Cloud last deployed. Runs on the gateway change set only,
// and only while the live gateway stack has no DeployedCodeSha output (that is, while it was last deployed from Cloud): afterwards the stack is Code's and the protected rules govern
// every change as they do for any stack. It compares the change set's own template with the live stack's (read-only: cloudformation:GetTemplate), by lib/gateway-switch.ts.
// Any other difference stops the step before anything executes, on beta first and then production.
import { stackName } from "../config.ts";
import { judgeGatewaySwitch } from "../lib/gateway-switch.ts";
import { liveGatewayCodeSha } from "../lib/refs.ts";
import type { Gate } from "../types.ts";

export const gate: Gate = {
  name: "gateway-source-switch",
  phases: ["change-sets"],
  async run(input) {
    const record = input.changeSets.find((cs) => cs.part === "gateway");
    if (record === undefined) return { result: "skipped", skippedReason: "no gateway change set in this scope" };
    const name = stackName(input.config, input.env, "gateway");
    const live = await input.ports.cfn.describeStack(name);
    if (live === null) return { result: "skipped", skippedReason: "the gateway stack does not exist yet: nothing is being switched from Cloud" };
    const deployedFrom = liveGatewayCodeSha(live.outputs);
    if (deployedFrom !== null) return { result: "skipped", skippedReason: `the live gateway was already deployed from Code (${deployedFrom.slice(0, 12)})` };
    if (record.noChanges) return { result: "pass", notes: ["the gateway change set has no changes at all"], data: { noChanges: true } };
    // Stack-level properties outside the template (the stack tags, the role ARNs, termination protection) are not in the two templates compared below. With the same image (the live ImageDigest
    // equals this run's digest) and templates equal outside the Outputs, the change set must have NO row at all: any row means something outside the template changed.
    const liveDigest = live.parameters.ImageDigest;
    if (record.rows.length > 0 && liveDigest !== undefined && liveDigest === input.manifest.gateway.digest) {
      return { result: "fail", failures: [`the gateway image is unchanged (${liveDigest.slice(0, 19)}...), so the first change set made from Code must have no resource row, but it has ${record.rows.length}: something outside the template changed (stack tags, role, termination protection?)`], data: { rows: record.rows.length } };
    }
    const codeSha = input.manifest.gateway.codeSha ?? null;
    if (codeSha === null) return { result: "fail", failures: ["the manifest names no Code commit for the gateway, so the switch from Cloud cannot be judged"] };
    const [liveTemplate, nextTemplate] = [await input.ports.cfn.liveTemplateBody(name), await input.ports.cfn.templateBody(name, record.changeSetName)];
    if (liveTemplate === null) return { result: "fail", failures: [`the live template of ${name} cannot be read`] };
    const verdict = judgeGatewaySwitch(liveTemplate, nextTemplate, codeSha);
    const data = { codeSha, rows: record.rows.length };
    return verdict.failures.length === 0
      ? { result: "pass", notes: ["the first gateway change set made from Code changes no resource: the templates are equal except for the outputs"], data }
      : { result: "fail", failures: verdict.failures, data };
  },
};
