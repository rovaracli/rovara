// N8: the install's settings for a company's own model endpoint (an internal gateway or a private Bedrock-compatible endpoint). Enterprise only, and OFF unless the
// operator asks. Checked at synth so a wrong setting stops the deploy, then handed to the broker as its environment and to the model access function as one IAM grant.
//
//   -c rovaraCustomModelEndpoints=true     the broker may save, check and route to a company's model endpoint (ROVARA_CUSTOM_MODEL_ENDPOINTS=1)
//   -c rovaraModelEndpointCidrs=10.4.0.0/16,...   private ranges an endpoint's host may resolve into (ROVARA_MODEL_ENDPOINT_CIDRS); unset: public addresses only
//
// The secret an endpoint needs is a Secrets Manager secret named under `rovara/model-endpoints/`. The model access function may read secrets under that prefix and nothing
// else; the broker never reads one. The grant exists only when the switch is on.
import { ArnFormat, type Stack } from "aws-cdk-lib";
import { aws_iam as iam } from "aws-cdk-lib";
import type { Edition } from "@agentx/contracts";
import { MODEL_ENDPOINT_SECRET_PREFIX } from "@agentx/contracts";
import { AGENTX_PRODUCTION_VPC_CIDR } from "./production-foundation.js";
import { ipv4RangesOverlap } from "./private-mcp.js";
import { parseEnterpriseEgressCidrs } from "./vpc-endpoints.js";

export const MODEL_ENDPOINT_CONTEXT_KEYS = { enable: "rovaraCustomModelEndpoints", cidrs: "rovaraModelEndpointCidrs" } as const;

export interface ModelEndpointInstall {
  enabled: boolean;
  /** Private ranges an endpoint's host may resolve into. Empty: public addresses only. */
  privateCidrs: string[];
  /** The network Rovara itself runs in, which a range may not overlap. */
  vpcCidrs: string[];
}

const isSet = (value: unknown): boolean => value !== undefined && value !== "";

function switchOf(value: unknown): boolean {
  if (value === undefined || value === false || value === "false" || value === 0 || value === "0" || value === "") return false;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  throw new Error(`${MODEL_ENDPOINT_CONTEXT_KEYS.enable} must be true or false`);
}

/**
 * Reads and checks the settings. Outside an Enterprise install none may be set. Ranges without the switch are a mistake (they would mean nothing), and a range that
 * overlaps the network Rovara runs in would let a pasted address find the install's own services.
 */
export function parseModelEndpointContext(input: { edition: Edition | undefined; get: (key: string) => unknown; vpcCidrs?: readonly string[] }): ModelEndpointInstall {
  const enabled = switchOf(input.get(MODEL_ENDPOINT_CONTEXT_KEYS.enable));
  const cidrsValue = input.get(MODEL_ENDPOINT_CONTEXT_KEYS.cidrs);
  const cidrsGiven = isSet(cidrsValue);
  const vpcCidrs = [...(input.vpcCidrs ?? [AGENTX_PRODUCTION_VPC_CIDR])];
  if ((enabled || cidrsGiven) && input.edition !== "enterprise") {
    throw new Error(`the model endpoint settings (${[...(enabled ? [MODEL_ENDPOINT_CONTEXT_KEYS.enable] : []), ...(cidrsGiven ? [MODEL_ENDPOINT_CONTEXT_KEYS.cidrs] : [])].join(", ")}) apply only to an Enterprise install (rovaraEdition=enterprise)`);
  }
  if (cidrsGiven && !enabled) throw new Error(`${MODEL_ENDPOINT_CONTEXT_KEYS.cidrs} needs ${MODEL_ENDPOINT_CONTEXT_KEYS.enable}=true`);
  let privateCidrs: string[] = [];
  if (cidrsGiven) {
    try {
      privateCidrs = parseEnterpriseEgressCidrs(cidrsValue);
    } catch (error) {
      throw new Error((error instanceof Error ? error.message : "is not valid").split("rovaraEnterpriseEgressCidrs").join(MODEL_ENDPOINT_CONTEXT_KEYS.cidrs), { cause: error });
    }
    for (const cidr of privateCidrs) {
      if (vpcCidrs.some((own) => ipv4RangesOverlap(cidr, own))) throw new Error(`${MODEL_ENDPOINT_CONTEXT_KEYS.cidrs} entry ${JSON.stringify(cidr)} overlaps the network Rovara itself runs in (${vpcCidrs.join(", ")}); list the customer's own ranges only`);
    }
  }
  return { enabled, privateCidrs, vpcCidrs };
}

/** The broker's environment for the install's model endpoint settings. Nothing when they are off. */
export function modelEndpointBrokerEnvironment(install: ModelEndpointInstall): Record<string, string> {
  if (!install.enabled) return {};
  return {
    ROVARA_CUSTOM_MODEL_ENDPOINTS: "1",
    ...(install.privateCidrs.length === 0 ? {} : { ROVARA_MODEL_ENDPOINT_CIDRS: install.privateCidrs.join(","), ROVARA_VPC_CIDRS: install.vpcCidrs.join(",") }),
  };
}

/** The model access function's one grant for model endpoints: read secrets named under the model-endpoint prefix, in this account and region. Never create or change one. */
export function modelEndpointSecretsStatement(stack: Stack): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: "ReadModelEndpointSecrets",
    actions: ["secretsmanager:GetSecretValue"],
    resources: [stack.formatArn({ service: "secretsmanager", resource: "secret", resourceName: `${MODEL_ENDPOINT_SECRET_PREFIX}*`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
  });
}
