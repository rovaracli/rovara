import { serviceRoleStatements } from "../../infra/lib/access-policies.js";

type DeployedStatement = Record<string, unknown>;

/**
 * The access stack leaves the Sids off the deployed deploy policy (a role's inline policies are capped at 10,240 characters in all and the Sids were the difference with a custom domain), in the order of
 * `serviceRoleStatements`. This puts them back by position, after checking that nothing deployed has one and that the count matches (with the seven custom-domain statements, as the hosted cloud's stack has
 * them, or without), so a test can find a statement by its Sid. A custom-domain statement is an Fn::If; its Sid goes on the statement it grants.
 */
export function serviceRoleWithSids<T extends DeployedStatement>(deployed: readonly T[]): T[] {
  const scope = { env: "staging", partition: "aws", region: "us-east-1", account: "123456789012", artifactBucketArn: "x", pullThroughPrefix: "x", cloudFormationRoleName: "x" };
  const sidLists = [serviceRoleStatements(scope), serviceRoleStatements({ ...scope, customDomain: { domainName: "x.example.com", hostedZoneId: "Z1" } })].map((statements) => statements.map((statement) => statement.Sid));
  const sids = sidLists.find((list) => list.length === deployed.length);
  if (sids === undefined) throw new Error(`the deployed deploy policy has ${deployed.length} statements, serviceRoleStatements ${sidLists.map((list) => list.length).join(" or ")}`);
  return deployed.map((statement, index) => {
    const wrapped = statement["Fn::If"] as [unknown, DeployedStatement, unknown] | undefined;
    const target = wrapped === undefined ? statement : wrapped[1];
    if ("Sid" in target) throw new Error("the deployed deploy policy should carry no Sids");
    const withSid = { ...target, Sid: sids[index]! };
    return (wrapped === undefined ? withSid : { ...statement, "Fn::If": [wrapped[0], withSid, wrapped[2]] }) as T;
  });
}
