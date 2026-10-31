// Enterprise foundations, N6 fix round 1: how the Rovara operator starts an upgrade. It does not deploy anything itself. It invokes the customer-owned deployer in the
// customer's account with a bundle id and nothing else, and reports what the deployer answers. The deployer re-verifies the bundle against the customer's approval.
import { DeployerResultSchema, DeployerRequestSchema, agentXError, bundleDeployerFunctionName, type DeployerResult } from "@agentx/contracts";

export interface DeployerInvoker {
  /** Invokes the function with `payload` (synchronously) and returns its parsed response; a function error or an unparsable response is thrown. */
  invoke(functionName: string, payload: unknown): Promise<unknown>;
}

/** A deployment that outlasts one invocation is resumed by invoking again; this bounds how often. */
export const MAX_DEPLOYER_CALLS = 40;

export async function startApprovedDeployment(input: { env: string; bundleId: string; invoker: DeployerInvoker; write: (line: string) => void }): Promise<DeployerResult> {
  const request = DeployerRequestSchema.safeParse({ bundleId: input.bundleId.toLowerCase() });
  if (!request.success) throw agentXError("CONFIG_INVALID", "a bundle id is 64 hexadecimal characters (the SHA-256 of bundle.json)");
  const functionName = bundleDeployerFunctionName(input.env);
  input.write(`Starting the deployer ${functionName} for bundle ${request.data.bundleId}`);
  for (let call = 1; call <= MAX_DEPLOYER_CALLS; call += 1) {
    let raw: unknown;
    try {
      raw = await input.invoker.invoke(functionName, request.data);
    } catch {
      throw agentXError("CONFIG_INVALID", `the deployer ${functionName} could not be started; if its call was refused, the role may be suspended`);
    }
    const parsed = DeployerResultSchema.safeParse(raw);
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "the deployer answered in a form this agentx does not know; nothing more was started");
    const result = parsed.data;
    input.write(`Deployer: ${result.status}${result.done === undefined ? "" : `; done: ${result.done.join(", ") || "none"}`}${result.remaining === undefined || result.remaining.length === 0 ? "" : `; to do: ${result.remaining.join(", ")}`}${result.reason === undefined ? "" : `; ${result.reason}`}`);
    if (result.status !== "in-progress") return result;
  }
  throw agentXError("CONFIG_INVALID", `the deployment was still in progress after ${MAX_DEPLOYER_CALLS} calls; run the command again to continue it`);
}
