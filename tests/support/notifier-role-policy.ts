import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CONTROL_PLANE_LAMBDAS, type CfnTemplate } from "../../scripts/test-deploy.js";
import { lambdaRoleIds } from "../../scripts/test-deploy-check.js";
import type { ItemAction, KeyUse } from "./state-key-uses.js";

// A control-plane Lambda's role as CloudFormation synthesizes it (the developer task notifier, and since 0.5.15.1 the Slack ingress that serves interactivity), read the way IAM reads the State-table
// statements this repository writes (ForAllValues:StringLike on dynamodb:LeadingKeys, with Null, ReturnValues, Select and Attributes guards that only narrow the key patterns), plus a document client
// that refuses what the role does not allow, so a delivery test runs under the role's real policy. The Attributes guard is enforced too: a read whose ProjectionExpression names an attribute the
// statement does not list is refused, as DynamoDB refuses it (the 0.5.15 Slack Stop failure: the task read asked for `currentOwner`, the grant listed five other attributes).

export type Statement = { Effect?: string; Action?: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, string | string[]>> };
type Resource = { Type: string; Properties?: Record<string, unknown> };


export const ITEM_ACTIONS: readonly ItemAction[] = ["GetItem", "PutItem", "UpdateItem", "DeleteItem", "Query", "ConditionCheckItem", "BatchGetItem"];
export const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
export const globToRegExp = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

let synthesized: CfnTemplate | undefined;
/** The real named control-plane stack, synthesized once per test file. */
export function controlPlaneTemplate(): CfnTemplate {
  if (synthesized !== undefined) return synthesized;
  const env = "agentxlivetest123";
  const stack = buildAgentXApp({ agentxEnv: env, "agentx:e2eQualificationTransport": "enabled" }).node.children
    .filter((child): child is Stack => Stack.isStack(child))
    .find((candidate) => candidate.stackName === `agentx-${env}-control-plane`);
  if (stack === undefined) throw new Error(`expected the real ${env} control-plane stack`);
  synthesized = Template.fromStack(stack).toJSON();
  return synthesized;
}

/** The statements of the synthesized role of one control-plane Lambda (a key of CONTROL_PLANE_LAMBDAS). */
export function roleStatements(unit: keyof typeof CONTROL_PLANE_LAMBDAS): Statement[] {
  return roleStatementsOf(CONTROL_PLANE_LAMBDAS[unit].logicalId);
}

/** The statements of the synthesized role of the control-plane Lambda with this logical ID (also one test-deploy does not move, such as the realtime authorizer). */
export function roleStatementsOf(logicalId: string): Statement[] {
  const template = controlPlaneTemplate();
  const roleLogicalId = lambdaRoleIds(template)[logicalId];
  if (roleLogicalId === undefined) throw new Error(`${logicalId} has no role in the template`);
  const statements: Statement[] = [];
  const document = (value: unknown) => list((value as { Statement?: Statement | Statement[] } | undefined)?.Statement);
  for (const [id, resource] of Object.entries((template.Resources ?? {}) as Record<string, Resource>)) {
    const properties = resource.Properties ?? {};
    if ((resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy")
      && list(properties.Roles as unknown[]).some((role) => (role as { Ref?: string } | undefined)?.Ref === roleLogicalId)) statements.push(...document(properties.PolicyDocument));
    if (resource.Type === "AWS::IAM::Role" && id === roleLogicalId) {
      for (const inline of list(properties.Policies as Array<{ PolicyDocument?: unknown }> | undefined)) statements.push(...document(inline.PolicyDocument));
    }
  }
  return statements;
}

/** The logical ID of the State table in the control-plane template. */
export const STATE_TABLE_LOGICAL_ID = "State1C20CC9A";

/**
 * The statements whose Resource names the table of this logical ID. IAM reads a statement per resource: the Slack ingress role's full read-write grant on its threads table, and its read of the
 * turn records table, say nothing about the State table, and a guard that lets them count as State-table grants would pass every key (and every attribute).
 */
export function statementsOnTable(statements: readonly Statement[], logicalId: string): Statement[] {
  const found = statements.filter((statement) => JSON.stringify(statement.Resource ?? null).includes(`"${logicalId}"`));
  if (found.length === 0) throw new Error(`no statement of the role names the table ${logicalId}`);
  return found;
}

export const notifierStatements = (): Statement[] => roleStatements("developer-task-notifier");

/** The item-level DynamoDB actions a statement allows (wildcards expanded; stream and control-plane actions are not item access and are left out). */
export const itemActionsOf = (statement: Statement): ItemAction[] => {
  const written = list(statement.Action).filter((action) => action.toLowerCase().startsWith("dynamodb:")).map((action) => globToRegExp(action.toLowerCase()));
  return ITEM_ACTIONS.filter((action) => written.some((pattern) => pattern.test(`dynamodb:${action}`.toLowerCase())));
};

/** The key patterns a statement allows, or "any" when it has no key condition, or "unreadable" for a condition this guard does not understand (which counts as no allowance). */
export function patternsOf(statement: Statement): string[] | "any" | "unreadable" {
  const condition = statement.Condition;
  if (condition === undefined) return "any";
  // `Null` only refuses an absent key, `StringEqualsIfExists` on ReturnValues or Select only narrows, and `ForAllValues:StringEquals` on dynamodb:Attributes only limits which attributes a read may name
  // (see attributeLimit): none of them widens the key patterns.
  const narrowing = (kind: string) => kind === "Null" || (kind === "StringEqualsIfExists" && Object.keys(condition[kind]!).every((key) => key === "dynamodb:ReturnValues" || key === "dynamodb:Select"))
    || (kind === "ForAllValues:StringEquals" && Object.keys(condition[kind]!).join() === "dynamodb:Attributes");
  const kinds = Object.keys(condition).filter((kind) => !narrowing(kind));
  if (kinds.length !== 1 || kinds[0] !== "ForAllValues:StringLike") return "unreadable";
  return list(condition["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]);
}

/**
 * What a statement's condition says about the attributes a read may name: the list in `ForAllValues:StringEquals` on dynamodb:Attributes, and whether the `Null` guard demands that a read name its
 * attributes at all (ForAllValues passes when the key is absent, so without the guard a read with no ProjectionExpression, which returns every attribute, would pass). Undefined when the statement has no limit.
 */
export function attributeLimit(statement: Statement): { allowed: string[]; mustName: boolean } | undefined {
  const allowed = statement.Condition?.["ForAllValues:StringEquals"]?.["dynamodb:Attributes"];
  if (allowed === undefined) return undefined;
  return { allowed: list(allowed), mustName: statement.Condition?.Null?.["dynamodb:Attributes"] === "false" };
}

/** The attribute names a Get names: its ProjectionExpression with the `#name` aliases resolved, or undefined when it names none (it reads every attribute). */
export function projectedAttributes(input: { ProjectionExpression?: unknown; ExpressionAttributeNames?: unknown }): string[] | undefined {
  if (typeof input.ProjectionExpression !== "string" || input.ProjectionExpression.trim() === "") return undefined;
  const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
  return input.ProjectionExpression.split(",").map((part) => part.trim()).filter((part) => part !== "").map((part) => names[part] ?? part);
}

/** Whether some statement lets the role GetItem a State item with this partition key naming these attributes (undefined: it names none). A statement without an attribute limit allows any. */
export function allowsGetWithAttributes(statements: readonly Statement[], key: string, attributes: readonly string[] | undefined): boolean {
  return statements.some((statement) => {
    if (statement.Effect !== "Allow" || !grantedActions([statement], key).includes("GetItem")) return false;
    const limit = attributeLimit(statement);
    if (limit === undefined) return true;
    if (attributes === undefined) return !limit.mustName;
    return attributes.every((name) => limit.allowed.includes(name));
  });
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
      case "GetCommand": {
        check("GetItem", input.Key);
        const pk = (input.Key as { pk: string }).pk;
        const attributes = projectedAttributes(input);
        if (!allowsGetWithAttributes(statements, pk, attributes)) {
          denied.push(`GetItem ${pk} attributes ${attributes === undefined ? "(all)" : attributes.join(",")}`);
          throw Object.assign(new Error(`not authorized to perform dynamodb:GetItem on ${pk} with these attributes`), { name: "AccessDeniedException" });
        }
        break;
      }
      case "UpdateCommand": check("UpdateItem", input.Key); break;
      case "BatchGetCommand":
        // BatchGetItem is its own IAM action, and a LeadingKeys condition applies to every key of the request.
        for (const request of Object.values(input.RequestItems as Record<string, { Keys?: unknown[] }>)) for (const key of request.Keys ?? []) check("BatchGetItem", key);
        break;
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
