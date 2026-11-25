/**
 * Does the boundary break anything Cloud needs? For every role in a set of synthesized Cloud templates, every (action, resource) its own
 * policies allow must be allowed by the role's permissions boundary and denied by none of the boundary's Deny statements. No synth
 * and no AWS: it reads synthesized templates. The templates' intrinsics are resolved to the names CloudFormation would give (`<stack name>-<logical id>-<random>` for a
 * generated name), with sample values for the parameters a policy names. Anything it can't resolve is an error, never a guess.
 *
 * Used by tests/contract/cloud-role-boundary.test.ts, and by infra/bin/cloud-boundary-cases.ts, which writes the same cases for the
 * controller's read-only `aws iam simulate-custom-policy` run against the real IAM evaluator.
 */
import { BOUNDARY_LOGICAL_ID } from "./cloud-boundary.js";

export interface CfnTemplate {
  readonly Resources: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
  readonly Outputs?: Record<string, { Value: unknown; Export?: { Name: unknown } }>;
  readonly Parameters?: Record<string, unknown>;
}
export interface StackTemplate { readonly stackName: string; readonly template: CfnTemplate }
export interface CheckScope { readonly partition: string; readonly region: string; readonly account: string; readonly env: string }
interface Statement { Sid?: string; Effect: string; Action?: string | string[]; NotAction?: unknown; Resource?: unknown; NotResource?: unknown; Condition?: unknown }

/** One action a role's own policy allows on one resource (a pattern when the policy's resource has a wildcard). */
export interface RoleCase { readonly stackName: string; readonly role: string; readonly action: string; readonly resource: string; readonly condition?: ResolvedCondition }
/** A statement's Condition with every value resolved to a string list: operator -> key -> values. */
export type ResolvedCondition = Record<string, Record<string, string[]>>;
export interface Violation extends RoleCase { readonly reason: string }

/** The AWS managed policies a Cloud role may carry, with their statements (no other managed policy is allowed). */
const AWS_MANAGED: Record<string, Statement[]> = {
  "service-role/AWSLambdaBasicExecutionRole": [{ Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: "*" }],
};

/** Sample values for the parameters a Cloud policy names: shaped like what the controller passes. */
function parameterSamples(s: CheckScope): Record<string, string> {
  return {
    ProductKeysTableName: `rovara-cloud-${s.env}-gateway-ProductKeys518BAD1E-SAMPLE0000AA`,
    CompanyTableName: `rovara-cloud-${s.env}-web-CompaniesAF68172A-SAMPLE0000AA`,
    GatewayMeterTableName: `rovara-cloud-${s.env}-gateway-Meter-SAMPLE0000AA`,
    ProductKeysKeyArn: `arn:${s.partition}:kms:${s.region}:${s.account}:key/11111111-1111-4111-8111-111111111111`,
    ProductKeysMacKeyArn: `arn:${s.partition}:kms:${s.region}:${s.account}:key/22222222-2222-4222-8222-222222222222`,
    GitHubConnectionArn: `arn:${s.partition}:codeconnections:${s.region}:${s.account}:connection/33333333-3333-4333-8333-333333333333`,
    // The release actions stack (cloud-release-actions.ts): another account stands for beta; the price fetch roles are under the gateway's role path.
    CloudConnectionArn: `arn:${s.partition}:codeconnections:${s.region}:${s.account}:connection/55555555-5555-4555-8555-555555555555`,
    ArtifactBucketName: "sample-release-pipeline-artifacts-bucket",
    BetaAccountId: "210987654321",
    ProductionPriceFetchTaskRoleArn: `arn:${s.partition}:iam::${s.account}:role/rovara-cloud/${s.env}/gateway/SAMPLE-PriceFetchTaskRole9E75F49-SAMPLE0000AA`,
    ProductionPriceFetchExecutionRoleArn: `arn:${s.partition}:iam::${s.account}:role/rovara-cloud/${s.env}/gateway/SAMPLE-PriceFetchExecutionRole81-SAMPLE0000AA`,
  };
}

const RANDOM = "SAMPLE0000AAB";
/**
 * CloudFormation's generated name, `<stack name>-<logical id>-<random>`. Past the type's length limit CloudFormation shortens the stack
 * name part as well (staging: `rovara-cloud-staging-gate-PriceFetchExecutionRole81-…`), so a name that long is returned as one that
 * keeps nothing of the stack name: a boundary that relied on the prefix fails the check, as it would fail in AWS.
 */
function generatedName(stackName: string, logicalId: string, max = 64, lower = false): string {
  const full = `${stackName}-${logicalId}-${RANDOM}`;
  const name = full.length <= max ? full : `SHORTENED-${logicalId.slice(0, max - RANDOM.length - 12)}-${RANDOM}`;
  return lower ? name.toLowerCase() : name;
}

class Resolver {
  private readonly exports = new Map<string, () => string>();
  constructor(readonly scope: CheckScope, stacks: readonly StackTemplate[]) {
    for (const stack of stacks) {
      for (const output of Object.values(stack.template.Outputs ?? {})) {
        if (output.Export === undefined) continue;
        const name = this.resolve(stack, output.Export.Name);
        this.exports.set(name, () => this.resolve(stack, output.Value));
      }
    }
  }

  private resource(stack: StackTemplate, id: string) {
    const resource = stack.template.Resources[id];
    if (resource === undefined) throw new Error(`${stack.stackName}: no resource ${id}`);
    return resource;
  }

  /** What `Ref` returns for a resource. */
  ref(stack: StackTemplate, id: string): string {
    const { partition: p, region: r, account: a } = this.scope;
    if (id === "AWS::Partition") return p;
    if (id === "AWS::Region") return r;
    if (id === "AWS::AccountId") return a;
    if (id === "AWS::URLSuffix") return "amazonaws.com";
    if (id === "AWS::StackName") return stack.stackName;
    if (stack.template.Parameters?.[id] !== undefined) {
      const sample = parameterSamples(this.scope)[id];
      if (sample === undefined) throw new Error(`${stack.stackName}: a policy names the parameter ${id}, which has no sample value`);
      return sample;
    }
    const resource = this.resource(stack, id);
    const props = resource.Properties ?? {};
    switch (resource.Type) {
      case "AWS::IAM::Role": return typeof props.RoleName === "string" ? props.RoleName : generatedName(stack.stackName, id);
      case "AWS::IAM::ManagedPolicy": return `arn:${p}:iam::${a}:policy${typeof props.Path === "string" ? props.Path : "/"}${typeof props.ManagedPolicyName === "string" ? props.ManagedPolicyName : generatedName(stack.stackName, id, 128)}`;
      // A generated secret name is `<logical id>-<random>`, without the stack name (the AWS Secrets Manager user guide's
      // CloudFormation example: CloudFormationCreatedSecret-a1b2c3d4e5f6); Secrets Manager adds `-<6 characters>` to the ARN.
      case "AWS::SecretsManager::Secret": return `arn:${p}:secretsmanager:${r}:${a}:secret:${typeof props.Name === "string" ? props.Name : `${id}-a1b2c3d4e5f6`}-AbCdEf`;
      case "AWS::ECS::TaskDefinition": return `arn:${p}:ecs:${r}:${a}:task-definition/${typeof props.Family === "string" ? props.Family : generatedName(stack.stackName, id)}:1`;
      case "AWS::CodeBuild::Project": return typeof props.Name === "string" ? props.Name : generatedName(stack.stackName, id, 255);
      case "AWS::ECR::Repository": return generatedName(stack.stackName, id, 256, true);
      case "AWS::S3::Bucket": return generatedName(stack.stackName, id, 63, true);
      case "AWS::Logs::LogGroup": return typeof props.LogGroupName === "string" ? props.LogGroupName : generatedName(stack.stackName, id, 512);
      case "AWS::DynamoDB::Table": case "AWS::DynamoDB::GlobalTable": return generatedName(stack.stackName, id, 255);
      case "AWS::ECS::Cluster": return generatedName(stack.stackName, id, 255);
      case "AWS::Lambda::Function": return typeof props.FunctionName === "string" ? props.FunctionName : generatedName(stack.stackName, id);
      default: throw new Error(`${stack.stackName}: no Ref rule for ${resource.Type} (${id})`);
    }
  }

  /** What `Fn::GetAtt [id, Arn]` returns. */
  arn(stack: StackTemplate, id: string): string {
    const { partition: p, region: r, account: a } = this.scope;
    const resource = this.resource(stack, id);
    const props = resource.Properties ?? {};
    switch (resource.Type) {
      case "AWS::IAM::Role": return `arn:${p}:iam::${a}:role${typeof props.Path === "string" ? props.Path : "/"}${this.ref(stack, id)}`;
      case "AWS::DynamoDB::Table": case "AWS::DynamoDB::GlobalTable": return `arn:${p}:dynamodb:${r}:${a}:table/${this.ref(stack, id)}`;
      case "AWS::S3::Bucket": return `arn:${p}:s3:::${this.ref(stack, id)}`;
      case "AWS::Logs::LogGroup": return `arn:${p}:logs:${r}:${a}:log-group:${this.ref(stack, id)}:*`;
      case "AWS::KMS::Key": return `arn:${p}:kms:${r}:${a}:key/44444444-4444-4444-8444-${id.length.toString().padStart(12, "0")}`;
      case "AWS::ECR::Repository": return `arn:${p}:ecr:${r}:${a}:repository/${this.ref(stack, id)}`;
      case "AWS::CodeBuild::Project": return `arn:${p}:codebuild:${r}:${a}:project/${this.ref(stack, id)}`;
      case "AWS::Lambda::Function": return `arn:${p}:lambda:${r}:${a}:function:${this.ref(stack, id)}`;
      default: throw new Error(`${stack.stackName}: no Arn rule for ${resource.Type} (${id})`);
    }
  }

  resolve(stack: StackTemplate, value: unknown): string {
    if (typeof value === "string") return value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${stack.stackName}: can't resolve ${JSON.stringify(value)}`);
    const entries: Array<[string, unknown]> = Object.entries(value as Record<string, unknown>);
    if (entries.length !== 1) throw new Error(`${stack.stackName}: can't resolve ${JSON.stringify(value)}`);
    const [fn, arg] = entries[0]!;
    switch (fn) {
      case "Ref": return this.ref(stack, String(arg));
      case "Fn::GetAtt": {
        const [id, attribute] = arg as [string, string];
        if (attribute !== "Arn") throw new Error(`${stack.stackName}: no rule for GetAtt ${id}.${attribute}`);
        return this.arn(stack, id);
      }
      case "Fn::Join": {
        const [separator, parts] = arg as [string, unknown[]];
        return parts.map((part) => this.resolve(stack, part)).join(separator);
      }
      case "Fn::Sub": {
        if (typeof arg !== "string") throw new Error(`${stack.stackName}: Fn::Sub with variables is not supported`);
        return arg.replace(/\$\{([^}]+)\}/gu, (_, name: string) => this.ref(stack, name));
      }
      case "Fn::ImportValue": {
        const name = this.resolve(stack, arg);
        const exported = this.exports.get(name);
        if (exported === undefined) throw new Error(`${stack.stackName}: imports ${name}, which none of the templates exports`);
        return exported();
      }
      default: throw new Error(`${stack.stackName}: no rule for ${fn}`);
    }
  }
}

/** IAM's wildcard match (`*` any run, `?` one character); a `*` or `?` in `text` is matched as a literal character. */
export function globMatch(pattern: string, text: string): boolean {
  const re = new RegExp(`^${pattern.split("").map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/gu, "\\$&"))).join("")}$`, "su");
  return re.test(text);
}

/**
 * True when every action and resource `inner` can stand for is covered by `outer` (both IAM patterns). The inner pattern's wildcards
 * are literal characters to the outer's match, which only an outer wildcard can absorb: sound, if sometimes stricter than IAM.
 */
const covers = (outer: string, inner: string) => globMatch(outer.toLowerCase(), inner.toLowerCase());
const coversResource = (outer: string, inner: string) => globMatch(outer, inner);
/**
 * Could the two IAM patterns name a common action or resource: is there a string both match? (A Deny counts on any overlap.) Two ARNs
 * are compared part by part (partition, service, Region, account, resource), since a real ARN's parts never hold a colon.
 */
export function overlaps(x: string, y: string, lower: boolean): boolean {
  if (!lower && x.startsWith("arn:") && y.startsWith("arn:")) {
    const parts = (arn: string) => { const p = arn.split(":"); return [...p.slice(0, 5), p.slice(5).join(":")]; };
    const [px, py] = [parts(x), parts(y)];
    // Only when no wildcard sits before the resource part (a `*` there could span a colon in IAM's match).
    if (px.length === 6 && py.length === 6 && ![...px.slice(0, 5), ...py.slice(0, 5)].some((part) => part.includes("*") && part !== "*")) return px.every((part, i) => globOverlap(part, py[i]!));
  }
  return globOverlap(lower ? x.toLowerCase() : x, lower ? y.toLowerCase() : y);
}

function globOverlap(a: string, b: string): boolean {
  const memo = new Map<number, boolean>();
  const at = (i: number, j: number): boolean => {
    const key = i * (b.length + 1) + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (i === a.length && j === b.length) result = true;
    else if (i < a.length && a[i] === "*") result = at(i + 1, j) || (j < b.length && at(i, j + 1));
    else if (j < b.length && b[j] === "*") result = at(i, j + 1) || (i < a.length && at(i + 1, j));
    else result = i < a.length && j < b.length && (a[i] === b[j] || a[i] === "?" || b[j] === "?") && at(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return at(0, 0);
}

const list = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/**
 * A policy's statements. NotAction and NotResource are not understood by this check and refuse, with one exception: a role's own Deny may use NotResource (the release actions'
 * "nothing but my own artifact prefix" Deny). Only a role's Allow statements are enumerated as cases and a role's own Deny is never counted, so reading such a Deny cannot hide
 * a grant; a boundary's statements (`boundary: true`) are all evaluated, so any NotAction/NotResource there still refuses.
 */
function statementsOf(doc: unknown, where: string, boundary = false): Statement[] {
  const statements = list((doc as { Statement?: unknown } | undefined)?.Statement) as Statement[];
  for (const s of statements) {
    if (s.NotAction !== undefined || (s.NotResource !== undefined && (boundary || s.Effect !== "Deny"))) throw new Error(`${where}: NotAction/NotResource is not supported`);
  }
  return statements;
}

function resolveCondition(stack: StackTemplate, resolver: Resolver, condition: unknown): ResolvedCondition | undefined {
  if (condition === undefined) return undefined;
  const out: ResolvedCondition = {};
  for (const [operator, keys] of Object.entries(condition as Record<string, Record<string, unknown>>)) {
    // A value that is not a string or a resolvable intrinsic (a boolean, an unknown function) stays as its JSON text: it can only fail to satisfy a boundary's condition, never satisfy one.
    const text = (value: unknown): string => {
      if (typeof value !== "object" || value === null) return String(value);
      try { return resolver.resolve(stack, value); } catch { return JSON.stringify(value); }
    };
    out[operator] = Object.fromEntries(Object.entries(keys).map(([key, values]) => [key, list(values).map(text)]));
  }
  return out;
}

/** The resolved condition in the shape the policy wrote it (a single value stays a string, a list stays a list). */
function keepShape(original: unknown, resolved: ResolvedCondition): Record<string, Record<string, string | string[]>> {
  const out: Record<string, Record<string, string | string[]>> = {};
  for (const [operator, keys] of Object.entries(resolved)) {
    out[operator] = Object.fromEntries(Object.entries(keys).map(([key, values]) => [key, Array.isArray((original as Record<string, Record<string, unknown>>)[operator]![key]) ? values : values[0]!]));
  }
  return out;
}

/**
 * Does a role statement's own condition keep the request inside what a boundary Allow's condition requires? (A boundary only caps: an Allow with a condition
 * covers a grant only when the grant is at least as narrow.) Only the operators Cloud's boundary uses are understood; any other in a boundary is an error,
 * never a guess. StringLike / StringEquals (and ArnLike / ArnEquals, the operators of ARN-typed keys such as ecs:cluster, read the same way): every value the grant allows must match one the boundary allows. StringNotEquals: the grant must exclude every
 * value the boundary excludes. The meter's ForAllValues:StringLike and Null conditions must match exactly (no inferred containment).
 * A key the grant does not constrain does not satisfy a boundary that does.
 */
export function conditionWithin(own: ResolvedCondition | undefined, required: ResolvedCondition | undefined): boolean {
  if (required === undefined) return true;
  for (const [operator, keys] of Object.entries(required)) {
    if (operator === "ForAllValues:StringLike" || operator === "Null") {
      if (JSON.stringify(own?.[operator]) !== JSON.stringify(keys)) return false;
      continue;
    }
    if (operator !== "StringLike" && operator !== "StringEquals" && operator !== "StringNotEquals" && operator !== "ArnLike" && operator !== "ArnEquals") throw new Error(`the boundary condition operator ${operator} is not supported by this check`);
    for (const [key, wanted] of Object.entries(keys)) {
      // Glob containment below is sound for `*`-only boundary patterns; a `?` in a boundary value is not handled yet (review L4-HARD 4): an error, never a guess.
      if ((operator === "StringLike" || operator === "ArnLike") && wanted.some((w) => w.includes("?"))) throw new Error(`the boundary condition ${key} uses ? in a ${operator} value, which this check does not support`);
      const given = own?.[operator]?.[key];
      if (given === undefined) return false;
      if (operator === "StringNotEquals") { if (!wanted.every((w) => given.includes(w))) return false; }
      else if (operator === "StringEquals" || operator === "ArnEquals") { if (!given.every((g) => wanted.includes(g))) return false; }
      else if (!given.every((g) => wanted.some((w) => globMatch(w, g)))) return false;
    }
  }
  return true;
}

interface RoleView { stack: StackTemplate; id: string; statements: Statement[]; boundary: Statement[] }

function rolesOf(stack: StackTemplate, resolver: Resolver): RoleView[] {
  const resources = stack.template.Resources;
  const boundaries = new Map<string, Statement[]>();
  for (const [id, r] of Object.entries(resources)) {
    if (id === BOUNDARY_LOGICAL_ID && r.Type === "AWS::IAM::ManagedPolicy" && r.Properties?.Roles === undefined) boundaries.set(id, statementsOf(r.Properties?.PolicyDocument, `${stack.stackName}/${id}`, true));
  }
  const roles: RoleView[] = [];
  for (const [id, r] of Object.entries(resources)) {
    if (r.Type !== "AWS::IAM::Role") continue;
    const props = r.Properties ?? {};
    const where = `${stack.stackName}/${id}`;
    const boundaryRef = props.PermissionsBoundary as { Ref?: string } | undefined;
    if (boundaryRef?.Ref === undefined || !boundaries.has(boundaryRef.Ref)) throw new Error(`${where} has no permissions boundary from this stack's boundary policy`);
    const statements: Statement[] = [];
    for (const inline of list(props.Policies) as Array<{ PolicyDocument: unknown }>) statements.push(...statementsOf(inline.PolicyDocument, where));
    for (const arn of list(props.ManagedPolicyArns)) {
      const resolved = resolver.resolve(stack, arn);
      const name = resolved.replace(/^arn:[^:]+:iam::aws:policy\//u, "");
      const known = AWS_MANAGED[name];
      if (known === undefined || name === resolved) throw new Error(`${where} carries the managed policy ${resolved}, which this check doesn't know`);
      statements.push(...known.map((s) => ({ ...s, Resource: managedResource(stack, id, s, resolver) })));
    }
    for (const [pid, p] of Object.entries(resources)) {
      if (p.Type !== "AWS::IAM::Policy" && p.Type !== "AWS::IAM::ManagedPolicy") continue;
      if ((list(p.Properties?.Roles) as Array<{ Ref?: string }>).some((ref) => ref.Ref === id)) statements.push(...statementsOf(p.Properties?.PolicyDocument, `${stack.stackName}/${pid}`));
    }
    roles.push({ stack, id, statements, boundary: boundaries.get(boundaryRef.Ref)! });
  }
  return roles;
}

/**
 * AWSLambdaBasicExecutionRole grants its log actions on "*": what the role really writes to is its functions' log groups (the one the
 * function names, else /aws/lambda/<function name>).
 */
function managedResource(stack: StackTemplate, roleId: string, s: Statement, resolver: Resolver): unknown {
  if (s.Resource !== "*") return s.Resource;
  const groups: string[] = [];
  for (const [id, r] of Object.entries(stack.template.Resources)) {
    if (r.Type !== "AWS::Lambda::Function") continue;
    const role = (r.Properties?.Role as { "Fn::GetAtt"?: [string, string] } | undefined)?.["Fn::GetAtt"]?.[0];
    if (role !== roleId) continue;
    const named = (r.Properties?.LoggingConfig as { LogGroup?: unknown } | undefined)?.LogGroup;
    const group = named === undefined ? `/aws/lambda/${resolver.ref(stack, id)}` : resolver.resolve(stack, named);
    const { partition: p, region: rg, account: a } = resolver.scope;
    groups.push(`arn:${p}:logs:${rg}:${a}:log-group:${group}:*`);
  }
  if (groups.length === 0) throw new Error(`${stack.stackName}/${roleId}: a Lambda managed policy on a role no function uses`);
  return groups;
}

/** Every (action, resource) the roles' own Allow statements grant, resolved. */
export function roleCases(stacks: readonly StackTemplate[], scope: CheckScope): Array<RoleCase & { boundary: Statement[] }> {
  const resolver = new Resolver(scope, stacks);
  const cases: Array<RoleCase & { boundary: Statement[] }> = [];
  for (const stack of stacks) {
    for (const role of rolesOf(stack, resolver)) {
      const boundary = role.boundary.map((b) => ({ ...b, Action: list(b.Action).map(String), Resource: list(b.Resource).map((x) => resolver.resolve(stack, x)), Condition: resolveCondition(stack, resolver, b.Condition) }));
      for (const s of role.statements) {
        if (s.Effect !== "Allow") continue;
        const condition = resolveCondition(stack, resolver, s.Condition);
        for (const action of list(s.Action).map(String)) {
          for (const resource of list(s.Resource).map((x) => resolver.resolve(stack, x))) {
            cases.push({ stackName: stack.stackName, role: role.id, action, resource, ...(condition === undefined ? {} : { condition }), boundary });
          }
        }
      }
    }
  }
  return cases;
}

/** The cases the boundary would cut: not allowed by any boundary Allow, or touched by a boundary Deny. Empty means nothing breaks. */
export function boundaryViolations(stacks: readonly StackTemplate[], scope: CheckScope): Violation[] {
  const violations: Violation[] = [];
  for (const c of roleCases(stacks, scope)) {
    const { boundary, ...rest } = c;
    const allows = boundary.filter((b) => b.Effect === "Allow");
    const denies = boundary.filter((b) => b.Effect === "Deny");
    const allowed = allows.some((b) => (b.Action as string[]).some((a) => covers(a, c.action)) && (b.Resource as string[]).some((r) => coversResource(r, c.resource)) && conditionWithin(c.condition, b.Condition as ResolvedCondition | undefined));
    // A Deny with a condition applies to a request only when the condition holds, which a static check cannot always know. The exec Deny (StringEquals on the String key
    // ecs:enable-execute-command: a grant never sets that request key, the build passes none) is left out here (its text is pinned by a test). Any other conditional Deny is evaluated as if it applied: a case it could touch is reported, never passed; a Deny
    // that touches no case at all (the KMS deny outside S3: no role is granted any KMS action) costs nothing.
    const execDeny = (b: Statement): boolean => {
      const condition = b.Condition as Record<string, Record<string, unknown>> | undefined;
      return condition !== undefined && Object.entries(condition).every(([operator, keys]) => operator === "StringEquals" && Object.keys(keys).every((key) => key === "ecs:enable-execute-command"));
    };
    const denied = denies.filter((b) => !execDeny(b)).find((b) => (b.Action as string[]).some((a) => overlaps(a, c.action, true)) && (b.Resource as string[]).some((r) => overlaps(r, c.resource, false)));
    if (!allowed) violations.push({ ...rest, reason: "not allowed by the boundary" });
    else if (denied !== undefined) violations.push({ ...rest, reason: `denied by the boundary's ${denied.Sid ?? "Deny"}${denied.Condition === undefined ? "" : " (conditional: counted as applying)"}` });
  }
  return violations;
}

/** The boundary policy document of each stack, resolved (for the controller's simulation). */
export function resolvedBoundaries(stacks: readonly StackTemplate[], scope: CheckScope): Record<string, { Version: string; Statement: Statement[] }> {
  const resolver = new Resolver(scope, stacks);
  const out: Record<string, { Version: string; Statement: Statement[] }> = {};
  for (const stack of stacks) {
    for (const [id, r] of Object.entries(stack.template.Resources)) {
      // The boundary: a managed policy attached to nothing (CDK's overflow policies for a large role are attached to their role).
      if (id !== BOUNDARY_LOGICAL_ID || r.Type !== "AWS::IAM::ManagedPolicy" || r.Properties?.Roles !== undefined) continue;
      if (out[stack.stackName] !== undefined) throw new Error(`${stack.stackName} has two boundary policies`);
      const statements = statementsOf(r.Properties?.PolicyDocument, `${stack.stackName}/${id}`, true);
      out[stack.stackName] = { Version: "2012-10-17", Statement: statements.map((s) => ({ ...s, Resource: list(s.Resource).map((x) => resolver.resolve(stack, x)), ...(s.Condition === undefined ? {} : { Condition: keepShape(s.Condition, resolveCondition(stack, resolver, s.Condition)!) }) })) };
    }
  }
  return out;
}
