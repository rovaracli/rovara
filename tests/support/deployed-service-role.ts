import { serviceRoleStatements } from "../../infra/lib/access-policies.js";

type DeployedStatement = Record<string, unknown>;

/**
 * The access stack leaves the Sids off the deployed deploy policy (a role's inline policies are capped at 10,240 characters in all), in the order of `serviceRoleStatements`. This puts them back by position,
 * after checking that nothing deployed has one and that the count matches, so a test can find a statement by its Sid. Since 0.5.18 the custom domain's statements are not in it (they are the managed policy
 * CustomDomainDeployPolicy), so no deployed statement is condition-wrapped, and one is refused.
 */
export function serviceRoleWithSids<T extends DeployedStatement>(deployed: readonly T[]): T[] {
  const scope = { env: "staging", partition: "aws", region: "us-east-1", account: "123456789012", artifactBucketArn: "x", pullThroughPrefix: "x", cloudFormationRoleName: "x" };
  const sources = serviceRoleStatements(scope);
  if (sources.length !== deployed.length) throw new Error(`the deployed deploy policy has ${deployed.length} statements, serviceRoleStatements ${sources.length}`);
  return deployed.map((statement, index) => {
    if ("Fn::If" in statement) throw new Error(`position ${index} (${sources[index]!.Sid}) is condition-wrapped in the deployed deploy policy`);
    if ("Sid" in statement) throw new Error("the deployed deploy policy should carry no Sids");
    // A position carries the source statement's actions: a mis-assigned Sid is refused, not guessed.
    if (JSON.stringify(statement.Action) !== JSON.stringify(sources[index]!.Action)) throw new Error(`position ${index} (${sources[index]!.Sid}) has other actions deployed than serviceRoleStatements gives it`);
    return { ...statement, Sid: sources[index]!.Sid };
  });
}
