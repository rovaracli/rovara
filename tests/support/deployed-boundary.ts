import { defaultBoundaryStatements } from "../../infra/lib/access-policies.js";

type DeployedStatement = Record<string, unknown>;

/**
 * The access stack leaves the Sids off the deployed boundary (it is capped at 6,144 characters and the Sids are optional), in the order of `defaultBoundaryStatements`.
 * This puts them back by position, after checking that nothing deployed has one and that the count matches, so a test can find a statement by its Sid.
 */
export function boundaryWithSids<T extends DeployedStatement>(deployed: readonly T[]): Array<T & { Sid: string }> {
  const sids = defaultBoundaryStatements({ env: "staging", partition: "aws", region: "us-east-1", account: "123456789012", cloudFormationRoleName: "x" }).map((statement) => statement.Sid);
  if (deployed.some((statement) => "Sid" in statement)) throw new Error("the deployed boundary should carry no Sids");
  if (deployed.length !== sids.length) throw new Error(`the deployed boundary has ${deployed.length} statements, defaultBoundaryStatements ${sids.length}`);
  return deployed.map((statement, index) => ({ ...statement, Sid: sids[index]! }));
}
