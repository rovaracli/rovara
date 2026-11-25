// The account check (NO ACCOUNT IDS IN COMMITTED FILES). The account is whatever STS says for the credentials in use (the deploy role's); it must equal the
// account the stage expects, which comes from outside git (ROVARA_EXPECTED_DEPLOY_ACCOUNT: a pipeline variable or an SSM value). The comparison is L0's own
// `resolveDeployAccount` (ops/pipeline/switches.ts), reused here for every environment, not forked: unset, malformed or different is refused.
import { DEPLOY_ACCOUNT_PLACEHOLDER, resolveDeployAccount } from "../switches.ts";
import type { DeployAccountSource } from "../switches.ts";
import { StageError } from "../types.ts";
import { errorText } from "./context.ts";
import type { StepContext } from "./context.ts";

/** What L0's loader reads: `resolved` is the STS caller account of the deploy role, `expected` the stage's account from outside git. */
export function accountSource(ctx: StepContext): DeployAccountSource {
  return { resolved: ctx.account ?? undefined, expected: ctx.inputs.expectedAccount ?? undefined };
}

export async function checkAccount(ctx: StepContext): Promise<string> {
  if (ctx.inputs.region === null) throw new StageError("REFUSED", "AWS_REGION is not set");
  if (ctx.inputs.region !== ctx.row.region) throw new StageError("REFUSED", `AWS_REGION is ${ctx.inputs.region}; ${ctx.env} is ${ctx.row.region} (switches.json)`);
  const resolved = await ctx.ports.sts.account();
  try {
    // A row that deploys into a separate account holds the placeholder; any row is checked the same way here.
    const account = resolveDeployAccount({ ...ctx.row, deployAccount: DEPLOY_ACCOUNT_PLACEHOLDER }, { resolved, expected: ctx.inputs.expectedAccount ?? undefined });
    if (account === null) throw new Error("the account did not resolve");
    return account;
  } catch (error) {
    throw new StageError("REFUSED", errorText(error));
  }
}
