import { Aspects, type IAspect } from "aws-cdk-lib";
import { aws_iam as iam } from "aws-cdk-lib";
import type { IConstruct } from "constructs";

/**
 * Lowest-priority-number Aspects run first. The role's own Aspect, which splits an oversize
 * default policy into a managed policy, runs at the default priority (500); this one runs before it.
 */
const BEFORE_POLICY_SPLIT = 100;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((item) => right.has(item));
}

/** Two statements that differ in at most their action list or their resource list, nothing else. */
function mergeable(a: iam.PolicyStatement, b: iam.PolicyStatement): "resources" | "actions" | undefined {
  if (a.sid !== undefined || b.sid !== undefined) return undefined;
  if (a.effect !== b.effect || a.hasPrincipal || b.hasPrincipal) return undefined;
  if (a.notActions.length > 0 || b.notActions.length > 0 || a.notResources.length > 0 || b.notResources.length > 0) return undefined;
  if (a.actions.length === 0 || b.actions.length === 0 || a.resources.length === 0 || b.resources.length === 0) return undefined;
  if (canonical(a.conditions) !== canonical(b.conditions)) return undefined;
  if (sameSet(a.actions, b.actions)) return "resources";
  if (sameSet(a.resources, b.resources)) return "actions";
  return undefined;
}

/**
 * Merges the statements of a role's default policy that differ only in their resources (same actions,
 * same conditions) or only in their actions (same resources, same conditions). The result grants exactly
 * the same (action, resource, condition) combinations: A x R1 plus A x R2 is A x (R1 + R2), and the
 * same holds for actions. A statement with a Sid, a principal or a NotAction/NotResource is never
 * touched, and nothing is merged across different conditions, so no grant widens.
 *
 * It exists because CloudFormation's service role in a deployment (R53) cannot create managed policies,
 * and CDK moves statements that overflow a role's 10,000-character estimate into one.
 */
export function mergeRoleStatements(role: iam.IRole): void {
  const policy = role.node.tryFindChild("DefaultPolicy");
  if (!(policy instanceof iam.Policy)) return;
  const statements = (policy.document as unknown as { statements: iam.PolicyStatement[] }).statements;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < statements.length && !changed; i++) {
      for (let j = i + 1; j < statements.length && !changed; j++) {
        const kind = mergeable(statements[i]!, statements[j]!);
        if (kind === undefined) continue;
        if (kind === "resources") statements[i]!.addResources(...statements[j]!.resources.filter((resource) => !statements[i]!.resources.includes(resource)));
        else statements[i]!.addActions(...statements[j]!.actions.filter((action) => !statements[i]!.actions.includes(action)));
        statements.splice(j, 1);
        changed = true;
      }
    }
  }
}

/**
 * The named managed policies the broker's grants move into (ruling M2, owner-approved 2026-10-21): IAM caps a role's inline
 * policies at 10,240 characters in total, and the deploy's CloudFormation role may create managed policies named agentx-<env>-broker-* under /agentx/<env>/ only.
 * A statement moves whole into the group its first action's service belongs to, so each role keeps exactly the same grants.
 */
export const BROKER_POLICY_GROUPS = ["state", "orchestration", "integrations"] as const;
export type BrokerPolicyGroup = (typeof BROKER_POLICY_GROUPS)[number];

const STATE_SERVICES = new Set(["dynamodb", "s3", "kms"]);
// `scheduler` and `iam` are not here (Plan 4 Task 26): the broker's schedule statements (manage the group's schedules, pass the one invoke role) fall in the integrations group,
// which has room, because the orchestration group was past the 5,500-character guard with them. No grant of either service existed before, so no other statement moved.
const ORCHESTRATION_SERVICES = new Set(["lambda", "sqs", "states", "events", "ecs", "ec2", "ssm", "sts", "logs", "cloudwatch"]);

/** The group a statement belongs to, by the service of its first action (a stable choice, so a new grant never reshuffles the others). */
export function brokerPolicyGroup(statement: iam.PolicyStatement): BrokerPolicyGroup {
  const service = (statement.actions[0] ?? "").split(":")[0] ?? "";
  if (STATE_SERVICES.has(service)) return "state";
  if (ORCHESTRATION_SERVICES.has(service)) return "orchestration";
  return "integrations";
}

/**
 * Moves every statement of the role's default policy into the named managed policies `<prefix>-<group>`, attached to the role.
 * Statements move unchanged, so the role's effective grants are identical; the permissions boundary still caps the role.
 */
export function moveRoleStatementsToManagedPolicies(role: iam.IRole, prefix: string, path?: string): void {
  const policy = role.node.tryFindChild("DefaultPolicy");
  if (!(policy instanceof iam.Policy)) return;
  const statements = (policy.document as unknown as { statements: iam.PolicyStatement[] }).statements;
  const groups = new Map<BrokerPolicyGroup, iam.PolicyStatement[]>();
  for (const statement of statements) {
    const group = brokerPolicyGroup(statement);
    groups.set(group, [...(groups.get(group) ?? []), statement]);
  }
  for (const group of BROKER_POLICY_GROUPS) {
    const moved = groups.get(group);
    if (moved === undefined || moved.length === 0) continue;
    new iam.ManagedPolicy(policy.node.scope!, `${role.node.id}${group[0]!.toUpperCase()}${group.slice(1)}Policy`, {
      managedPolicyName: `${prefix}-${group}`,
      ...(path === undefined ? {} : { path }),
      description: `AgentX broker grants (${group}), moved out of the role's inline policy for size`,
      statements: moved,
      roles: [role],
    });
  }
  statements.splice(0, statements.length);
  policy.node.scope!.node.tryRemoveChild(policy.node.id);
}

/**
 * Merges the role's statements when synthesis visits it, after every grant was made and before CDK sizes the policy; with a
 * `managedPolicyPrefix`, then moves them into the named managed policies.
 */
export function mergeRoleStatementsOnSynth(role: iam.IRole, options: { managedPolicyPrefix?: string; managedPolicyPath?: string } = {}): void {
  const aspect: IAspect = {
    visit: (node: IConstruct) => {
      if (node !== role) return;
      mergeRoleStatements(role);
      if (options.managedPolicyPrefix !== undefined) moveRoleStatementsToManagedPolicies(role, options.managedPolicyPrefix, options.managedPolicyPath);
    },
  };
  Aspects.of(role).add(aspect, { priority: BEFORE_POLICY_SPLIT });
}
