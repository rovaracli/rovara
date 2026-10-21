// A small IAM policy evaluator for infrastructure tests: given the statements that apply to a principal (an identity's
// policies, or a resource policy), say whether a request is allowed, with an explicit Deny beating any Allow and
// everything not allowed denied. It reads synthesized templates, so it is only as faithful as the operators it knows;
// an operator or a shape it does not know THROWS, because a silent "no match" would let a test pass for the wrong reason.
//
// Supported: Action/NotAction and Resource/NotResource with `*` and `?` wildcards (case-insensitive actions), Principal
// (`"*"` or `{ AWS }` compared as text), and the condition operators String(Not)Equals, String(Not)Like, Arn(Not)Equals,
// Arn(Not)Like, Bool and Null, each with an optional ForAllValues: / ForAnyValue: qualifier and an IfExists suffix.
// It is not a substitute for the IAM policy simulator against a real account; it checks the policies as written.

export interface IamStatement {
  Sid?: string;
  Effect?: string;
  Principal?: unknown;
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: unknown;
  NotResource?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}

export interface IamRequest {
  action: string;
  resource: string;
  /** Condition keys the request carries, e.g. { "dynamodb:LeadingKeys": ["AUDIT#org_x"] }. A key left out is absent. */
  context?: Record<string, string | string[]>;
  /** For resource policies: who is calling. */
  principal?: string;
}

export interface IamDecision {
  allowed: boolean;
  /** "explicit-deny" when a Deny matched, "allow" when an Allow matched and no Deny did, "implicit-deny" otherwise. */
  reason: "explicit-deny" | "allow" | "implicit-deny";
  /** The Sids (or indexes) of the statements that matched. */
  matched: string[];
}

const list = (value: unknown): string[] => (value === undefined ? [] : [value].flat().map(String));

function glob(pattern: string, caseInsensitive = false): RegExp {
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${source}$`, caseInsensitive ? "i" : "");
}

const matchesAny = (patterns: string[], value: string, caseInsensitive = false) => patterns.some((pattern) => glob(pattern, caseInsensitive).test(value));

const BASE_OPERATORS = ["StringEquals", "StringNotEquals", "StringLike", "StringNotLike", "ArnEquals", "ArnNotEquals", "ArnLike", "ArnNotLike", "Bool", "Null"] as const;

function parseOperator(operator: string): { qualifier: "ForAllValues" | "ForAnyValue" | undefined; base: (typeof BASE_OPERATORS)[number]; ifExists: boolean } {
  const [, qualifier, rest] = /^(?:(ForAllValues|ForAnyValue):)?(.+)$/.exec(operator) ?? [];
  const ifExists = rest!.endsWith("IfExists");
  const base = ifExists ? rest!.slice(0, -"IfExists".length) : rest!;
  if (!(BASE_OPERATORS as readonly string[]).includes(base)) throw new Error(`iam-simulate: unsupported condition operator ${operator}`);
  return { qualifier: qualifier as "ForAllValues" | "ForAnyValue" | undefined, base: base as (typeof BASE_OPERATORS)[number], ifExists };
}

function conditionHolds(condition: Record<string, Record<string, unknown>> | undefined, context: Record<string, string | string[]>): boolean {
  for (const [operator, keys] of Object.entries(condition ?? {})) {
    const { qualifier, base, ifExists } = parseOperator(operator);
    for (const [key, expected] of Object.entries(keys)) {
      const policyValues = list(expected);
      const supplied = context[key];
      const present = supplied !== undefined && [supplied].flat().length > 0;
      if (base === "Null") {
        if ((policyValues[0] === "true") !== !present) return false;
        continue;
      }
      const negated = base.includes("Not");
      const like = base.endsWith("Like");
      const same = (value: string, pattern: string) => (base === "Bool" ? value.toLowerCase() === pattern.toLowerCase() : like ? glob(pattern).test(value) : value === pattern);
      const hit = (value: string) => policyValues.some((pattern) => same(value, pattern));
      const values = present ? [supplied].flat() : [];
      let holds: boolean;
      if (qualifier === "ForAllValues") {
        // Every value the request carries satisfies the condition; a request with none passes.
        holds = values.every((value) => (negated ? !hit(value) : hit(value)));
      } else if (qualifier === "ForAnyValue") {
        holds = present && values.some((value) => (negated ? !hit(value) : hit(value)));
      } else {
        if (values.length > 1) throw new Error(`iam-simulate: ${operator} on ${key} given several values; the policy needs ForAllValues or ForAnyValue`);
        // A missing key fails a positive operator and satisfies a negated one, unless IfExists.
        holds = present ? (negated ? !hit(values[0]!) : hit(values[0]!)) : ifExists || negated;
      }
      if (!holds) return false;
    }
  }
  return true;
}

function principalMatches(statement: IamStatement, principal: string | undefined): boolean {
  if (statement.Principal === undefined) return true;
  if (principal === undefined) throw new Error("iam-simulate: a resource policy statement needs the request's principal");
  const text = JSON.stringify(statement.Principal);
  if (statement.Principal === "*" || text === '{"AWS":"*"}') return true;
  const aws = (statement.Principal as { AWS?: unknown }).AWS;
  return list(aws).some((entry) => entry === "*" || entry === principal || entry === principal.replace(/:assumed-role.*$/, ""));
}

function statementApplies(statement: IamStatement, request: IamRequest): boolean {
  if (!principalMatches(statement, request.principal)) return false;
  const actions = list(statement.Action);
  const notActions = list(statement.NotAction);
  const actionMatches = statement.NotAction !== undefined ? !matchesAny(notActions, request.action, true) : matchesAny(actions, request.action, true);
  if (!actionMatches) return false;
  const resources = list(statement.Resource);
  const notResources = list(statement.NotResource);
  const resourceMatches = statement.NotResource !== undefined ? !matchesAny(notResources, request.resource) : statement.Resource === undefined || matchesAny(resources, request.resource);
  if (!resourceMatches) return false;
  return conditionHolds(statement.Condition, request.context ?? {});
}

/** Evaluates `request` against `statements`: an explicit Deny wins, then any Allow, else denied. */
export function simulateIam(statements: readonly IamStatement[], request: IamRequest): IamDecision {
  const matched = statements
    .map((statement, index) => ({ statement, name: statement.Sid ?? `#${String(index)}` }))
    .filter(({ statement }) => statementApplies(statement, request));
  const denies = matched.filter(({ statement }) => statement.Effect === "Deny");
  if (denies.length > 0) return { allowed: false, reason: "explicit-deny", matched: denies.map(({ name }) => name) };
  const allows = matched.filter(({ statement }) => statement.Effect === "Allow");
  return allows.length > 0 ? { allowed: true, reason: "allow", matched: allows.map(({ name }) => name) } : { allowed: false, reason: "implicit-deny", matched: [] };
}

type Resource = { Type: string; Properties?: Record<string, unknown> };

/**
 * Every identity statement that applies to the role with logical id `roleId`: the role's inline policies and each
 * AWS::IAM::Policy that lists the role. Managed policies are not readable here, so a role with any is refused.
 * `readable` turns a template value into text (references and attributes spelled out), so a statement's Resource can be
 * compared with a request's.
 */
export function roleStatements(template: { Resources: Record<string, Resource> }, roleId: string, readable: (value: unknown) => unknown): IamStatement[] {
  const role = template.Resources[roleId];
  if (role === undefined) throw new Error(`iam-simulate: no role ${roleId}`);
  if (Array.isArray(role.Properties?.ManagedPolicyArns) && role.Properties.ManagedPolicyArns.length > 0) throw new Error(`iam-simulate: role ${roleId} has managed policies, which the simulation cannot read`);
  const documents: unknown[] = [];
  for (const inline of (role.Properties?.Policies ?? []) as Array<{ PolicyDocument: unknown }>) documents.push(inline.PolicyDocument);
  for (const resource of Object.values(template.Resources)) {
    if (resource.Type !== "AWS::IAM::Policy") continue;
    const roles = (resource.Properties?.Roles ?? []) as Array<{ Ref?: string }>;
    if (roles.some((entry) => entry.Ref === roleId)) documents.push(resource.Properties?.PolicyDocument);
  }
  return documents.flatMap((document) => [(document as { Statement: unknown }).Statement].flat().map((statement) => readable(statement) as IamStatement));
}
