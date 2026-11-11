// The cdk engine deploys the access stack's other stacks through the AgentX CloudFormation role,
// and the CDK deploy role must be allowed to hand that role to CloudFormation. agentx init adds
// that one narrow inline permission to the deploy role, after printing it and with no question
// (a human decision: it is narrow, printed, and removed again by agentx destroy). When the AWS
// credentials cannot add it, init stops with the exact policy so a cloud team can add it.
import { DeleteRolePolicyCommand, GetRolePolicyCommand, PutRolePolicyCommand, type IAMClient } from "@aws-sdk/client-iam";
import { ListStacksCommand, StackStatus, type CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { agentXError } from "@rovara-code/contracts";

export const CDK_PASS_ROLE_POLICY_NAME = "AgentXPassCloudFormationRole";
/** The qualifier `cdk bootstrap` uses unless told otherwise. */
const DEFAULT_QUALIFIER = "hnb659fds";

export function cdkDeployRoleName(input: { account: string; region: string; qualifier?: string }): string {
  return `cdk-${input.qualifier ?? DEFAULT_QUALIFIER}-deploy-role-${input.account}-${input.region}`;
}

export interface PassRolePolicyDocument {
  Version: string;
  Statement: Array<{
    Sid: string; Effect: string; Action: string; Resource: string[];
    Condition: { StringEquals: { "iam:PassedToService": string } };
  }>;
}

/** The inline policy: PassRole of the AgentX CloudFormation roles, to CloudFormation only. */
export function passRolePolicyDocument(input: { partition: string; account: string }): PassRolePolicyDocument {
  const prefix = `arn:${input.partition}:iam::${input.account}:role`;
  return {
    Version: "2012-10-17",
    Statement: [{
      Sid: "PassAgentXCloudFormationRole",
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: [`${prefix}/agentx-*-cloudformation`, `${prefix}/*/agentx-*-cloudformation`],
      Condition: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } },
    }],
  };
}

const errorName = (error: unknown): string | undefined => (typeof error === "object" && error !== null && typeof (error as { name?: unknown }).name === "string" ? (error as { name: string }).name : undefined);
const isAccessDenied = (error: unknown): boolean => ["AccessDenied", "AccessDeniedException"].includes(errorName(error) ?? "");
const isNoSuchEntity = (error: unknown): boolean => errorName(error) === "NoSuchEntity";

/** The same JSON with every object's keys in sorted order, so two documents compare as text. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

/** Whether IAM's stored document (URL-encoded JSON) is the same policy as `wanted`. */
function sameDocument(stored: string | undefined, wanted: PassRolePolicyDocument): boolean {
  if (stored === undefined) return false;
  try {
    return JSON.stringify(canonical(JSON.parse(decodeURIComponent(stored)))) === JSON.stringify(canonical(wanted));
  } catch {
    return false;
  }
}

/**
 * Makes sure the CDK deploy role carries the PassRole policy. Present and equal: nothing is written
 * or printed. Otherwise the policy is printed and then put, with no question. AccessDenied (on
 * reading or writing) stops with the policy and the command that adds it.
 */
export async function ensureCdkPassRole(input: {
  iam: Pick<IAMClient, "send">; write: (line: string) => void; account: string; region: string; partition: string;
}): Promise<"present" | "added"> {
  const role = cdkDeployRoleName({ account: input.account, region: input.region });
  const document = passRolePolicyDocument({ partition: input.partition, account: input.account });
  const compact = JSON.stringify(document);
  const pretty = JSON.stringify(document, null, 2);
  const denied = (): Error => agentXError("CONFIG_INVALID", [
    `init cannot continue: the deploy role needs a permission your AWS credentials cannot add. Ask your cloud team to add this inline policy named ${CDK_PASS_ROLE_POLICY_NAME} to role ${role}:`,
    pretty,
    `or to run: aws iam put-role-policy --role-name ${role} --policy-name ${CDK_PASS_ROLE_POLICY_NAME} --policy-document '${compact}'`,
  ].join("\n"));

  try {
    const existing = await input.iam.send(new GetRolePolicyCommand({ RoleName: role, PolicyName: CDK_PASS_ROLE_POLICY_NAME }));
    if (sameDocument(existing.PolicyDocument, document)) return "present";
  } catch (error) {
    if (isAccessDenied(error)) throw denied();
    // No policy yet, or the role itself is missing (Put reports that below).
    if (!isNoSuchEntity(error)) throw error;
  }

  input.write(`Rovara is letting the CDK deploy role ${role} hand the AgentX CloudFormation role to CloudFormation. Adding this inline policy named ${CDK_PASS_ROLE_POLICY_NAME}:`);
  input.write(pretty);
  try {
    await input.iam.send(new PutRolePolicyCommand({ RoleName: role, PolicyName: CDK_PASS_ROLE_POLICY_NAME, PolicyDocument: compact }));
  } catch (error) {
    if (isAccessDenied(error)) throw denied();
    if (isNoSuchEntity(error)) {
      throw agentXError("CONFIG_INVALID", `init cannot continue: the CDK deploy role ${role} does not exist. Bootstrap CDK in ${input.region} with the default qualifier (npx cdk bootstrap aws://${input.account}/${input.region}), then run agentx init again`);
    }
    throw error;
  }
  return "added";
}

const ACCESS_STACK = /^agentx-([a-z0-9-]+)-access$/;
const LIVE_STATUSES = Object.values(StackStatus).filter((status) => status !== StackStatus.DELETE_COMPLETE);

/** The environments, other than `env`, that still have an access stack in the region. */
async function otherEnvironments(cloudformation: Pick<CloudFormationClient, "send">, env: string): Promise<string[]> {
  const found = new Set<string>();
  let token: string | undefined;
  do {
    const page = await cloudformation.send(new ListStacksCommand({ StackStatusFilter: LIVE_STATUSES, ...(token === undefined ? {} : { NextToken: token }) }));
    for (const summary of page.StackSummaries ?? []) {
      if (summary.StackStatus === StackStatus.DELETE_COMPLETE) continue;
      const name = ACCESS_STACK.exec(summary.StackName ?? "")?.[1];
      if (name !== undefined && name !== env) found.add(name);
    }
    token = page.NextToken;
  } while (token !== undefined);
  return [...found].sort();
}

/**
 * Takes the policy off the CDK deploy role once the last environment in the region is gone; while
 * another environment's access stack exists, it stays and the kept line says why.
 */
export async function removeCdkPassRole(input: {
  iam: Pick<IAMClient, "send">; cloudformation: Pick<CloudFormationClient, "send">; write: (line: string) => void;
  env: string; account: string; region: string;
}): Promise<"removed" | "kept" | "absent"> {
  const others = await otherEnvironments(input.cloudformation, input.env);
  if (others.length > 0) {
    input.write(`Kept ${CDK_PASS_ROLE_POLICY_NAME}: environments ${others.join(", ")} in ${input.region} still use it.`);
    return "kept";
  }
  try {
    await input.iam.send(new DeleteRolePolicyCommand({ RoleName: cdkDeployRoleName({ account: input.account, region: input.region }), PolicyName: CDK_PASS_ROLE_POLICY_NAME }));
  } catch (error) {
    if (isNoSuchEntity(error)) return "absent";
    throw error;
  }
  return "removed";
}
