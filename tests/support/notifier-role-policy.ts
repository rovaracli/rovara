import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CONTROL_PLANE_LAMBDAS, type CfnTemplate } from "../../scripts/test-deploy.js";
import { lambdaRoleIds } from "../../scripts/test-deploy-check.js";
import type { ItemAction, KeyUse } from "./state-key-uses.js";

// The developer task notifier's role as CloudFormation synthesizes it, read the way IAM reads the State-table statements this repository writes (ForAllValues:StringLike on dynamodb:LeadingKeys, with
// Null and ReturnValues guards that only narrow), plus a document client that refuses what the role does not allow, so a delivery test runs under the role's real policy.

export type Statement = { Effect?: string; Action?: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, string | string[]>> };
type Resource = { Type: string; Properties?: Record<string, unknown> };


const ENTRY = CONTROL_PLANE_LAMBDAS["developer-task-notifier"];

export const ITEM_ACTIONS: readonly ItemAction[] = ["GetItem", "PutItem", "UpdateItem", "DeleteItem", "Query", "ConditionCheckItem"];
export const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
export const globToRegExp = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

export function notifierStatements(): Statement[] {
  const env = "agentxlivetest123";
  const stack = buildAgentXApp({ agentxEnv: env, "agentx:e2eQualificationTransport": "enabled" }).node.children
    .filter((child): child is Stack => Stack.isStack(child))
    .find((candidate) => candidate.stackName === `agentx-${env}-control-plane`);
  if (stack === undefined) throw new Error(`expected the real ${env} control-plane stack`);
  const template: CfnTemplate = Template.fromStack(stack).toJSON();
  const roleLogicalId = lambdaRoleIds(template)[ENTRY.logicalId];
  if (roleLogicalId === undefined) throw new Error("the notifier has no role in the template");
  const statements: Statement[] = [];
  const document = (value: unknown) => list((value as { Statement?: Statement | Statement[] } | undefined)?.Statement);
  for (const [logicalId, resource] of Object.entries((template.Resources ?? {}) as Record<string, Resource>)) {
    const properties = resource.Properties ?? {};
    if ((resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy")
      && list(properties.Roles as unknown[]).some((role) => (role as { Ref?: string } | undefined)?.Ref === roleLogicalId)) statements.push(...document(properties.PolicyDocument));
    if (resource.Type === "AWS::IAM::Role" && logicalId === roleLogicalId) {
      for (const inline of list(properties.Policies as Array<{ PolicyDocument?: unknown }> | undefined)) statements.push(...document(inline.PolicyDocument));
    }
  }
  return statements;
}

/** The item-level DynamoDB actions a statement allows (wildcards expanded; stream and control-plane actions are not item access and are left out). */
export const itemActionsOf = (statement: Statement): ItemAction[] => {
  const written = list(statement.Action).filter((action) => action.toLowerCase().startsWith("dynamodb:")).map((action) => globToRegExp(action.toLowerCase()));
  return ITEM_ACTIONS.filter((action) => written.some((pattern) => pattern.test(`dynamodb:${action}`.toLowerCase())));
};

/** The key patterns a statement allows, or "any" when it has no key condition, or "unreadable" for a condition this guard does not understand (which counts as no allowance). */
export function patternsOf(statement: Statement): string[] | "any" | "unreadable" {
  const condition = statement.Condition;
  if (condition === undefined) return "any";
  // `Null` only refuses an absent key, and `StringEqualsIfExists` on ReturnValues only narrows a put: neither widens the key patterns.
  const narrowing = (kind: string) => kind === "Null" || (kind === "StringEqualsIfExists" && Object.keys(condition[kind]!).join() === "dynamodb:ReturnValues");
  const kinds = Object.keys(condition).filter((kind) => !narrowing(kind));
  if (kinds.length !== 1 || kinds[0] !== "ForAllValues:StringLike") return "unreadable";
  return list(condition["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]);
}

/** The item actions the role may take on a State item with this partition key. */
export function grantedActions(statements: readonly Statement[], key: string): ItemAction[] {
  const granted = new Set<ItemAction>();
  for (const statement of statements) {
    if (statement.Effect !== "Allow") continue;
    const patterns = patternsOf(statement);
    if (patterns === "unreadable") continue;
    if (patterns !== "any" && !patterns.some((pattern) => globToRegExp(pattern).test(key))) continue;
    for (const action of itemActionsOf(statement)) granted.add(action);
  }
  return ITEM_ACTIONS.filter((action) => granted.has(action));
}

/** Every key pattern the role's item-level statements name. */
export const policyPatterns = (statements: readonly Statement[]): string[] => [...new Set(statements
  .filter((statement) => statement.Effect === "Allow" && itemActionsOf(statement).length > 0)
  .flatMap((statement) => { const patterns = patternsOf(statement); return patterns === "any" || patterns === "unreadable" ? [`<${patterns}>`] : patterns; }))];

export const actionsByPrefix = (uses: readonly KeyUse[]): Map<string, ItemAction[]> => {
  const byPrefix = new Map<string, Set<ItemAction>>();
  for (const use of uses) byPrefix.set(use.prefix, (byPrefix.get(use.prefix) ?? new Set()).add(use.action));
  return new Map([...byPrefix].map(([prefix, actions]) => [prefix, ITEM_ACTIONS.filter((action) => actions.has(action))]));
};


/** Wraps a DynamoDB document client so that every call the role's policy does not allow throws AccessDeniedException, as DynamoDB does; allowed calls pass through. */
export function enforceRolePolicy<T extends { send(command: never): Promise<unknown> }>(client: T, statements: readonly Statement[], denied: string[] = []): T {
  const real = client.send.bind(client);
  const check = (action: ItemAction, key: unknown) => {
    const pk = (key as { pk?: unknown } | undefined)?.pk;
    if (typeof pk !== "string" || !grantedActions(statements, pk).includes(action)) { denied.push(`${action} ${String(pk)}`); throw Object.assign(new Error(`not authorized to perform dynamodb:${action} on ${String(pk)}`), { name: "AccessDeniedException" }); }
  };
  (client as unknown as { send: unknown }).send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const input = command.input;
    switch (command.constructor.name) {
      case "GetCommand": check("GetItem", input.Key); break;
      case "UpdateCommand": check("UpdateItem", input.Key); break;
      case "DeleteCommand": check("DeleteItem", input.Key); break;
      case "PutCommand": check("PutItem", input.Item); break;
      case "QueryCommand": check("Query", { pk: (input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"] }); break;
      case "TransactWriteCommand":
        for (const item of input.TransactItems as Array<Record<string, { Key?: unknown; Item?: unknown }>>) {
          if (item.Put !== undefined) check("PutItem", item.Put.Item);
          if (item.Update !== undefined) check("UpdateItem", item.Update.Key);
          if (item.Delete !== undefined) check("DeleteItem", item.Delete.Key);
          if (item.ConditionCheck !== undefined) check("ConditionCheckItem", item.ConditionCheck.Key);
        }
        break;
      default: throw new Error(`enforceRolePolicy does not know ${command.constructor.name}`);
    }
    return real(command as never);
  };
  return client;
}
