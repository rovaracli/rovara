import { readFileSync } from "node:fs";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { adminChangeKey, sharedTaskKey } from "@rovara-code/contracts";
import { describe, expect, it } from "vitest";
import { designWaitNotifyKey, designWaitRowKey } from "../../packages/broker/src/design-review/wait-rows.js";
import { plannerRepliesKey, taskKey, taskPointerKey } from "../../packages/broker/src/developer/task-records.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CONTROL_PLANE_LAMBDAS, type CfnTemplate } from "../../scripts/test-deploy.js";
import { lambdaRoleIds } from "../../scripts/test-deploy-check.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { prefixOfPk, sampleOfPrefix, scanStateKeyUses, type ItemAction, type KeyUse } from "../support/state-key-uses.js";

// NOTIFY-DM-IAM (found live on staging, 0.5.14): the notifier read and updated the "NOTIFY_DM" rows that carry a person's attention DM, its role had no statement for that key, and every attention
// DM (and the 0.5.14 Slack-member warning, which uses the same rows) was refused by DynamoDB: the SlackDeliveryFailed alarm fired. The older guard (lambda-dynamodb-key-grants.test.ts) did not see it
// because a key whose action it cannot read passed on any DynamoDB statement, and the stream-read grant has no key condition.
//
// This guard reads every State-table call the notifier's entry file makes (tests/support/state-key-uses.ts), works out the partition prefix and the action of each, and compares them with the notifier
// role's synthesized policy in both directions: each prefix gets exactly the item actions the code uses on it, and each key pattern in the policy belongs to a prefix the code uses (or to one of the
// imported modules listed by hand below, whose key builders the scan cannot follow).

skipLambdaBundling();

type Statement = { Effect?: string; Action?: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, string | string[]>> };
type Resource = { Type: string; Properties?: Record<string, unknown> };

const ENTRY = CONTROL_PLANE_LAMBDAS["developer-task-notifier"];
const repoRoot = new URL("../../", import.meta.url);
const source = readFileSync(new URL(ENTRY.entry, repoRoot), "utf8");

const ITEM_ACTIONS: readonly ItemAction[] = ["GetItem", "PutItem", "UpdateItem", "DeleteItem", "Query", "ConditionCheckItem"];
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const globToRegExp = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

function notifierStatements(): Statement[] {
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
const itemActionsOf = (statement: Statement): ItemAction[] => {
  const written = list(statement.Action).filter((action) => action.toLowerCase().startsWith("dynamodb:")).map((action) => globToRegExp(action.toLowerCase()));
  return ITEM_ACTIONS.filter((action) => written.some((pattern) => pattern.test(`dynamodb:${action}`.toLowerCase())));
};

/** The key patterns a statement allows, or "any" when it has no key condition, or "unreadable" for a condition this guard does not understand (which counts as no allowance). */
function patternsOf(statement: Statement): string[] | "any" | "unreadable" {
  const condition = statement.Condition;
  if (condition === undefined) return "any";
  // `Null` only refuses an absent key, and `StringEqualsIfExists` on ReturnValues only narrows a put: neither widens the key patterns.
  const narrowing = (kind: string) => kind === "Null" || (kind === "StringEqualsIfExists" && Object.keys(condition[kind]!).join() === "dynamodb:ReturnValues");
  const kinds = Object.keys(condition).filter((kind) => !narrowing(kind));
  if (kinds.length !== 1 || kinds[0] !== "ForAllValues:StringLike") return "unreadable";
  return list(condition["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]);
}

/** The item actions the role may take on a State item with this partition key. */
function grantedActions(statements: readonly Statement[], key: string): ItemAction[] {
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
const policyPatterns = (statements: readonly Statement[]): string[] => [...new Set(statements
  .filter((statement) => statement.Effect === "Allow" && itemActionsOf(statement).length > 0)
  .flatMap((statement) => { const patterns = patternsOf(statement); return patterns === "any" || patterns === "unreadable" ? [`<${patterns}>`] : patterns; }))];

const actionsByPrefix = (uses: readonly KeyUse[]): Map<string, ItemAction[]> => {
  const byPrefix = new Map<string, Set<ItemAction>>();
  for (const use of uses) byPrefix.set(use.prefix, (byPrefix.get(use.prefix) ?? new Set()).add(use.action));
  return new Map([...byPrefix].map(([prefix, actions]) => [prefix, ITEM_ACTIONS.filter((action) => actions.has(action))]));
};

// --- the key builders the notifier calls, run for real, so a changed builder changes this list -----------------------------------------------------------------------------------------------
const thread = { teamId: "T0000001", channelId: "C0000001", threadTs: "1700000000.000100" };
const BUILDERS = {
  taskKey: [prefixOfPk(taskKey("t1").pk)],
  taskPointerKey: [prefixOfPk(taskPointerKey("w1").pk)],
  plannerRepliesKey: [prefixOfPk(plannerRepliesKey("t1", "a1").pk)],
  adminChangeKey: [prefixOfPk(adminChangeKey("c1").pk)],
  sharedTaskKey: [prefixOfPk(sharedTaskKey(thread).pk)],
  designWaitNotifyKey: [prefixOfPk(designWaitNotifyKey("t1", 1, "parked").pk)],
  // designWaitArmOf returns a whole UpdateItem input whose Key is the design wait row's key.
  designWaitArmOf: [prefixOfPk(designWaitRowKey("t1").pk)],
};

// Two variables hold NOTICE rows read back by a Query on `DEVTASK#<task>` (begins_with sk NOTICE#), so their updates are on DEVTASK# items.
const MEMBERS = { "updateWorkflowApprovalCard:marker": ["DEVTASK#"], "retireButtonCards:marker": ["DEVTASK#"] };

/**
 * Item actions the role holds on a prefix beyond what the entry file uses. Both come from the notifier's first read statement, which gives Get and Query to four prefixes together. They
 * are read-only on rows the notifier owns; splitting that statement would move the digests for no gain, so they are listed here and a new extra grant elsewhere still fails.
 */
const EXTRA_ALLOWED: Record<string, readonly ItemAction[]> = { "OPERATION#": ["GetItem"], "CHATGPT_NOTICE#": ["Query"] };

/** Key patterns the role holds for the imported modules the scan cannot follow: pattern to the module that uses it and a word that module must still contain. */
const IMPORTED_MODULE_GRANTS: Record<string, { file: string; mention: string; actions: ItemAction[] }> = {
  "ORG#org_????????????????????#WORK_EVENTS#*": { file: "packages/broker/src/work-events/store.ts", mention: "WORK_EVENTS#", actions: ["PutItem"] },
  "ORG#org_????????????????????#SESSION_BINDING#*": { file: "packages/broker/src/agent-sessions/bindings.ts", mention: "sessionBindingKey", actions: ["PutItem"] },
  "ORG#org_????????????????????#SESSION_SURFACE": { file: "packages/broker/src/agent-sessions/bindings.ts", mention: "sessionSurfaceKey", actions: ["PutItem"] },
  "ORG#org_????????????????????#AGENT_SESSION#*": { file: "packages/broker/src/agent-sessions/bindings.ts", mention: "ConditionCheck", actions: ["ConditionCheckItem"] },
  "ORG#org_????????????????????#SETTINGS": { file: "packages/broker/src/spend/estimate.ts", mention: "planRunLimit", actions: ["GetItem"] },
  "ORG#org_????????????????????#RUN_COST#*": { file: "packages/broker/src/spend/estimate.ts", mention: "RUN_COST", actions: ["Query"] },
};

const statements = notifierStatements();
const scan = scanStateKeyUses(source, { builders: BUILDERS, members: MEMBERS });
const used = actionsByPrefix(scan.uses);

describe("the notifier role's State-table grants match the keys and actions its code uses", () => {
  it("the scan resolves every State-table call the entry file makes (a key shape it cannot read fails here, it is never skipped)", () => {
    expect(scan.unresolved).toEqual([]);
    // Positive controls: the scan really sees the calls this guard exists for.
    expect(used.get("NOTIFY_DM")).toEqual(["GetItem", "UpdateItem"]);
    expect(used.get("WORKFLOW_DISPATCH")).toEqual(["GetItem"]);
    expect(used.get("CHATGPT_NOTICE#")).toEqual(["GetItem", "PutItem"]);
    expect(used.get("DEVTASK#")).toEqual(expect.arrayContaining(["GetItem", "PutItem", "UpdateItem", "Query"]));
    expect(used.get("SHARED_TASK#")).toEqual(["PutItem"]);
    expect(used.get("ADMIN_CHANGE#")).toEqual(["GetItem", "UpdateItem"]);
    // The settings-proof DM reads and writes only its own marker, never the project's partition (ORG#<org>#PROJECT#<name>).
    expect(used.get("NOTIFY_SETTINGS_PROOF#")).toEqual(["GetItem", "PutItem"]);
    expect([...used.keys()].filter((prefix) => prefix.startsWith("ORG#"))).toEqual([]);
    expect(grantedActions(statements, "ORG#org_aaaaaaaaaaaaaaaaaaaa#PROJECT#web")).toEqual([]);
  });

  it("each partition prefix the code touches is granted every item action the code uses on it, and no other (bar the listed extras)", () => {
    const wrong: string[] = [];
    for (const [prefix, actions] of [...used].sort()) {
      const granted = grantedActions(statements, sampleOfPrefix(prefix));
      const wanted = actions;
      const missing = wanted.filter((action) => !granted.includes(action));
      const extra = granted.filter((action) => !wanted.includes(action));
      if (missing.length > 0) wrong.push(`${prefix}: the code uses ${missing.join("+")} and the role does not grant it`);
      if (JSON.stringify(extra) !== JSON.stringify(EXTRA_ALLOWED[prefix] ?? [])) wrong.push(`${prefix}: the role grants ${extra.join("+") || "nothing"} beyond the code's use (expected ${(EXTRA_ALLOWED[prefix] ?? []).join("+") || "nothing"})`);
    }
    expect(wrong).toEqual([]);
  });

  it("every key pattern in the role's item grants belongs to a prefix the code uses, or to a listed imported module", () => {
    const code = new Set([...used.keys()].map((prefix) => (prefix.endsWith("#") ? `${prefix}*` : prefix)));
    const stray = policyPatterns(statements).filter((pattern) => !code.has(pattern) && IMPORTED_MODULE_GRANTS[pattern] === undefined);
    expect(stray).toEqual([]);
    for (const [pattern, { file, mention, actions }] of Object.entries(IMPORTED_MODULE_GRANTS)) {
      expect(readFileSync(new URL(file, repoRoot), "utf8"), `${file} still mentions ${mention}`).toContain(mention);
      const sample = pattern.replace(/\?/g, "a").replace(/\*/g, "x");
      expect(grantedActions(statements, sample), pattern).toEqual(actions);
    }
  });

  it("is not vacuous: without a NOTIFY_DM statement the guard names NOTIFY_DM, and a read grant is no write grant", () => {
    const without = statements.filter((statement) => !JSON.stringify(statement.Condition ?? {}).includes("NOTIFY_DM"));
    expect(grantedActions(without, "NOTIFY_DM")).toEqual([]);
    expect(grantedActions(statements, "NOTIFY_DM")).toEqual(["GetItem", "UpdateItem"]);
    for (const action of ["PutItem", "DeleteItem", "Query"] as const) expect(grantedActions(statements, "NOTIFY_DM")).not.toContain(action);
    expect(grantedActions(statements, "NOTIFY_DM2")).toEqual([]);
    expect(grantedActions(statements, "NOTIFY_DM#x")).toEqual([]);
    // A statement with no key condition allows every key; any condition this guard cannot read allows none; a stream grant is no item grant.
    expect(grantedActions([{ Effect: "Allow", Action: "dynamodb:*" }], "ANY#x")).toEqual(ITEM_ACTIONS);
    expect(grantedActions([{ Effect: "Allow", Action: "dynamodb:GetItem", Condition: { StringEquals: { "dynamodb:LeadingKeys": ["X"] } } }], "X")).toEqual([]);
    expect(grantedActions([{ Effect: "Allow", Action: ["dynamodb:GetRecords", "dynamodb:DescribeStream"] }], "NOTIFY_DM")).toEqual([]);
  });

  it("the scanner reads the shapes it claims to (literal key, local const, parameter, builder, transaction)", () => {
    const sample = [
      "async function a(deps) {",
      "  const key = { pk: \"ONE\", sk }; await getItem<T>(deps, key);",
      "  await deps.documentClient.send(new UpdateCommand({ TableName: t, Key: key }));",
      "}",
      "async function b(deps, marker) { await deps.documentClient.send(new PutCommand({ TableName: t, Item: { ...marker, x: 1 } })); }",
      "async function c(deps) { await b(deps, { pk: `TWO#${id}`, sk: \"s\" }); await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Update: { Key: taskKey(id) } }, { Put: { Item: { ...sharedTaskKey(x) } } }] })); }",
    ].join("\n");
    const result = scanStateKeyUses(sample, { builders: BUILDERS });
    expect(result.unresolved).toEqual([]);
    expect(actionsByPrefix(result.uses)).toEqual(new Map([["ONE", ["GetItem", "UpdateItem"]], ["TWO#", ["PutItem"]], ["DEVTASK#", ["UpdateItem"]], ["SHARED_TASK#", ["PutItem"]]]));
    expect(scanStateKeyUses("async function d(deps, k) { await getItem(deps, k); }", { builders: {} }).unresolved).toHaveLength(1);
  });
});
