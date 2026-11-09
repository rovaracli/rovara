import { serviceRoleStatements } from "../../infra/lib/access-policies.js";

type DeployedStatement = Record<string, unknown>;

/**
 * The access stack leaves the Sids off the deployed deploy policy (a role's inline policies are capped at 10,240 characters in all and the Sids were the difference with a custom domain), in the order of
 * `serviceRoleStatements`. This puts them back by position, after checking that nothing deployed has one and that the count matches (with the seven custom-domain statements, as the hosted cloud's stack has
 * them, or without), so a test can find a statement by its Sid. A custom-domain statement is an Fn::If; its Sid goes on the statement it grants.
 */
export function serviceRoleWithSids<T extends DeployedStatement>(deployed: readonly T[]): T[] {
  const scope = { env: "staging", partition: "aws", region: "us-east-1", account: "123456789012", artifactBucketArn: "x", pullThroughPrefix: "x", cloudFormationRoleName: "x" };
  const statementLists = [serviceRoleStatements(scope), serviceRoleStatements({ ...scope, customDomain: { domainName: "x.example.com", hostedZoneId: "Z1" } })];
  const sidLists = statementLists.map((statements) => statements.map((statement) => statement.Sid));
  const which = sidLists.findIndex((list) => list.length === deployed.length);
  if (which === -1) throw new Error(`the deployed deploy policy has ${deployed.length} statements, serviceRoleStatements ${sidLists.map((list) => list.length).join(" or ")}`);
  const sids = sidLists[which]!;
  const sources = statementLists[which]!;
  return deployed.map((statement, index) => {
    const wrapped = statement["Fn::If"] as [unknown, DeployedStatement, unknown] | undefined;
    const target = wrapped === undefined ? statement : wrapped[1];
    if ("Sid" in target) throw new Error("the deployed deploy policy should carry no Sids");
    // A position is condition-wrapped exactly when it is a custom-domain statement, and carries the source statement's actions: a mis-assigned Sid is refused, not guessed.
    if ((wrapped !== undefined) !== sids[index]!.startsWith("CustomDomain")) throw new Error(`position ${index} (${sids[index]}) is ${wrapped === undefined ? "not " : ""}condition-wrapped in the deployed deploy policy`);
    if (JSON.stringify(target.Action) !== JSON.stringify(sources[index]!.Action)) throw new Error(`position ${index} (${sids[index]}) has other actions deployed than serviceRoleStatements gives it`);
    const withSid = { ...target, Sid: sids[index]! };
    return (wrapped === undefined ? withSid : { ...statement, "Fn::If": [wrapped[0], withSid, wrapped[2]] }) as T;
  });
}
