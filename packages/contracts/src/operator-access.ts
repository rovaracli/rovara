// Enterprise foundations, task N6 (owner decision 2026-10-31, evening): under the managed-VPC agreement Rovara holds one standing operator role in the
// customer's account. It can start the deployment of a release bundle whose id the customer approved, through the customer's own deploy role, and nothing
// else; the customer can suspend it at any moment. This file holds the names and settings both the infrastructure code and the CLI need.

export const OPERATOR_ACCESS_STATES = ["enabled", "suspended"] as const;
export type OperatorAccessState = (typeof OPERATOR_ACCESS_STATES)[number];

/** CDK context: `disabled` (the default; nothing is created), `enabled` or `suspended`. */
export const OPERATOR_ACCESS_CONTEXT_KEY = "rovaraOperatorAccess";
/** CDK context: the one Rovara role that may assume the operator role, an IAM role ARN in Rovara's account. */
export const OPERATOR_PRINCIPAL_CONTEXT_KEY = "rovaraOperatorPrincipalArn";
/** CDK context: the external id the customer holds; the trust policy requires it. */
export const OPERATOR_EXTERNAL_ID_CONTEXT_KEY = "rovaraOperatorExternalId";
/** CDK context: comma-separated log group names the operator may read (groups that hold no content). Empty: none. */
export const OPERATOR_LOG_GROUPS_CONTEXT_KEY = "rovaraOperatorLogGroups";

/** The key prefix of the customer-owned approval bucket under which a customer places a bundle after approving its id: `approved/<bundle id>/...`. */
export const APPROVED_BUNDLE_PREFIX = "approved/";

/** The operator role's fixed name. It never matches `environmentOperatorRoleName` (the customer's own platform-team role). */
export function rovaraOperatorRoleName(env: string): string {
  return `agentx-${env}-rovara-operator`;
}

/** True for a session of the Rovara operator role of `env`. */
export function isRovaraOperatorArn(callerArn: string, env: string): boolean {
  return callerArn.includes(`:assumed-role/${rovaraOperatorRoleName(env)}/`);
}
