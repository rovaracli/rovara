// Decision 147: the thread continuation record (CONTINUE#<team>#<channel>#<thread> on the Slack threads table) is written by
// the Slack service's role and read by the Slack ingress's role. No new grant was added for it; this checks, under the real
// synthesized control-plane policy, that both roles may do exactly that on that table for that key family.
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CONTROL_PLANE_LAMBDAS, type CfnTemplate } from "../../scripts/test-deploy.js";
import { lambdaRoleIds } from "../../scripts/test-deploy-check.js";
import { threadContinuationKey } from "../../packages/cloud-contracts/src/index.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Statement = { Effect?: string; Action?: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, string | string[]>> };
type Resource = { Type: string; Properties?: Record<string, unknown> };
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const globToRegExp = (glob: string): RegExp => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);

function controlPlaneTemplate(): CfnTemplate {
  const env = "agentxlivetest123";
  const stack = buildAgentXApp({ agentxEnv: env, "agentx:e2eQualificationTransport": "enabled" }).node.children
    .filter((child): child is Stack => Stack.isStack(child))
    .find((candidate) => candidate.stackName === `agentx-${env}-control-plane`);
  if (stack === undefined) throw new Error(`expected the real ${env} control-plane stack`);
  return Template.fromStack(stack).toJSON();
}

function statementsOfRole(template: CfnTemplate, roleLogicalId: string): Statement[] {
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

/** Whether `statements` allow `action` on an item of the table `tableLogicalId` whose partition key is `key` (a LeadingKeys condition must match it). */
function allows(statements: readonly Statement[], tableLogicalId: string, action: string, key: string): boolean {
  return statements.some((statement) => {
    if (statement.Effect !== "Allow") return false;
    if (!list(statement.Action).some((candidate) => globToRegExp(candidate.toLowerCase()).test(`dynamodb:${action}`.toLowerCase()))) return false;
    if (!JSON.stringify(list(statement.Resource)).includes(`"${tableLogicalId}"`)) return false;
    const condition = statement.Condition;
    if (condition === undefined) return true;
    const kinds = Object.keys(condition).filter((kind) => kind !== "Null");
    if (kinds.length !== 1 || kinds[0] !== "ForAllValues:StringLike") return false;
    return list(condition["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]).some((pattern) => globToRegExp(pattern).test(key));
  });
}

const template = controlPlaneTemplate();
const resources = (template.Resources ?? {}) as Record<string, Resource>;
const threadsTable = Object.entries(resources).find(([id, resource]) => resource.Type === "AWS::DynamoDB::Table" && id.startsWith("SlackThreads"))?.[0];
const orchestratorRole = Object.entries(resources).find(([, resource]) => resource.Type === "AWS::IAM::Role"
  && typeof resource.Properties?.Description === "string" && resource.Properties.Description.startsWith("Hosted AgentX Slack orchestrator"))?.[0];
const ingressRole = lambdaRoleIds(template)[CONTROL_PLANE_LAMBDAS["slack-ingress"].logicalId];
const key = threadContinuationKey({ teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1697000000.000001" }).pk;

describe("decision 147: the continuation record's grants under the synthesized policy", () => {
  it("finds the Slack threads table and both roles in the real template", () => {
    expect(threadsTable).toBeDefined();
    expect(orchestratorRole).toBeDefined();
    expect(ingressRole).toBeDefined();
  });

  it("lets the Slack service's role write the record, and the Slack ingress's role read it", () => {
    expect(allows(statementsOfRole(template, orchestratorRole!), threadsTable!, "PutItem", key)).toBe(true);
    expect(allows(statementsOfRole(template, ingressRole!), threadsTable!, "GetItem", key)).toBe(true);
  });
});
