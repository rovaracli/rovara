// TR-SWITCH-B1/B2 (0.5.11): the access stack's two policies must cover everything the Team record's switch-on creates and runs.
//
// Why this test exists: the 0.5.10 switch-on review (release-notes/0.5.10-team-record-switch-on.md) found that the control-plane deploy would fail at the first S3 Vectors / S3 Tables / Athena resource
// (the deploy role had no right to create them) and that, even if it had succeeded, the permissions boundary would have denied the broker's and the vector role's runtime calls. Every other test checks the
// record with the switch on OR the access stack alone; nothing connected the two. This one synthesizes the whole app with `agentxTeamRecord=enabled` and checks, from the real templates:
//  1. DEPLOY: every resource type the switch adds is covered by the deploy role: by a service wildcard (the old way), or, for the three types that have none, by the handler permissions CloudFormation publishes
//     for each (pinned in a fixture), each on this environment's own names and on no one else's.
//  2. RUN: every IAM statement the switch adds to any role (the broker, the vector data role, the dispatcher, the Slack ingress, ...) is inside the default boundary: each action AND each resource, with IAM's wildcard rules.
//  3. The deploy role's own record grants are inside the boundary it runs under.
//  4. The vector data role has the fixed name the boundary and the deploy role's lookup name, and the broker may assume it.
// A resource type or an action the record adds later fails here until the access stack covers it (the helpers below are tested with a made-up uncovered type, so the check itself cannot go quiet).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { Stack, type App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { teamRecordTableBucketName, teamRecordVectorBucketName, teamRecordWorkGroupName } from "@agentx/cloud-contracts";
import { SERVICE_ROLE_SERVICES, TEAM_RECORD_LIST_ACTIONS, teamRecordVectorsRoleName } from "../../infra/lib/access-policies.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { serviceRoleWithSids } from "../support/deployed-service-role.js";

skipLambdaBundling();
// The control plane stack reads the web app's asset directory when it builds; the contents do not matter here (the other infrastructure tests do the same).
if (!existsSync("packages/web/dist/app/assets")) mkdirSync("packages/web/dist/app/assets", { recursive: true });

type Json = Record<string, unknown>;
type Resource = { Type: string; Properties: Json };
type Statement = { Sid?: string; Effect: "Allow" | "Deny"; Action: string | string[]; Resource?: unknown; NotResource?: unknown; Condition?: unknown };
type Resources = Record<string, Resource>;

const ENV = "staging";
const REGION = "us-west-2";
const ACCOUNT = "111122223333";
const PATH = `/agentx/${ENV}/`;

// ---- reading a template as text
const asList = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const glob = (pattern: string, text: string, flags = "") => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, flags).test(text);

/** Resolves a template value to the string IAM would see, with the pseudo parameters filled in and the few attributes the record's statements use named from the resource they point at. */
function resolver(resources: Resources) {
  const arnOf = (id: string, attribute: string): string => {
    const resource = resources[id];
    const props = resource?.Properties ?? {};
    switch (resource?.Type) {
      case "AWS::S3Vectors::VectorBucket": return `arn:aws:s3vectors:${REGION}:${ACCOUNT}:bucket/${String(props.VectorBucketName)}`;
      case "AWS::S3Tables::TableBucket": return `arn:aws:s3tables:${REGION}:${ACCOUNT}:bucket/${String(props.TableBucketName)}`;
      case "AWS::IAM::Role": return attribute === "Arn" ? `arn:aws:iam::${ACCOUNT}:role${typeof props.Path === "string" ? props.Path : "/"}${flat(props.RoleName)}` : `<${id}.${attribute}>`;
      case "AWS::S3::Bucket": return `arn:aws:s3:::<${id}>`;
      default: return `arn:aws:service:${REGION}:${ACCOUNT}:<${id}.${attribute}>`;
    }
  };
  function flat(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value !== "object" || value === null) return String(value);
    const node = value as Json;
    if (node["Fn::Join"] !== undefined) { const [separator, parts] = node["Fn::Join"] as [string, unknown[]]; return parts.map(flat).join(separator); }
    if (node["Fn::Sub"] !== undefined) return (node["Fn::Sub"] as string).replace("${AWS::Partition}", "aws").replace("${AWS::Region}", REGION).replace("${AWS::AccountId}", ACCOUNT);
    if (node["Fn::GetAtt"] !== undefined) { const [id, attribute] = node["Fn::GetAtt"] as [string, string]; return arnOf(id, attribute); }
    if (node.Ref === "AWS::Partition") return "aws";
    if (node.Ref === "AWS::Region") return REGION;
    if (node.Ref === "AWS::AccountId") return ACCOUNT;
    if (typeof node.Ref === "string") { const target = resources[node.Ref]; return target?.Type === "AWS::IAM::Role" ? flat(target.Properties.RoleName) : `<ref:${node.Ref}>`; }
    return `<${Object.keys(node).join(",")}>`;
  }
  return flat;
}

/** Every Allow/Deny statement any role holds in a template: a role's inline policies, AWS::IAM::Policy and AWS::IAM::ManagedPolicy, with the resources resolved to text. */
function roleStatements(resources: Resources): Array<{ owner: string; statement: Statement; resources: string[] }> {
  const flat = resolver(resources);
  const unwrap = (statement: Statement | { "Fn::If": [string, Statement, unknown] }): Statement => ("Fn::If" in statement ? statement["Fn::If"][1] : statement);
  const out: Array<{ owner: string; statement: Statement; resources: string[] }> = [];
  for (const [id, resource] of Object.entries(resources)) {
    const documents: Array<{ Statement: Statement[] }> = [];
    if (resource.Type === "AWS::IAM::Role") for (const policy of (resource.Properties.Policies ?? []) as Array<{ PolicyDocument: { Statement: Statement[] } }>) documents.push(policy.PolicyDocument);
    if (resource.Type === "AWS::IAM::Policy" || resource.Type === "AWS::IAM::ManagedPolicy") documents.push(resource.Properties.PolicyDocument as { Statement: Statement[] });
    for (const document of documents) {
      for (const raw of document.Statement) {
        const statement = unwrap(raw);
        out.push({ owner: id, statement, resources: asList(statement.Resource).map((value) => flat(value)) });
      }
    }
  }
  return out;
}

/** Whether the statements allow the action on the resource: some unconditional Allow matches and no unconditional Deny does. */
function allowedBy(statements: Statement[], action: string, resource: string, flat: (value: unknown) => string): boolean {
  const matches = (statement: Statement) => asList(statement.Action).some((pattern) => glob(pattern, action, "i"))
    && (statement.NotResource !== undefined ? !asList(statement.NotResource).some((pattern) => glob(flat(pattern), resource)) : asList(statement.Resource).some((pattern) => glob(flat(pattern), resource)));
  // A conditional Allow (the boundary's cross-account AssumeOrgRoles) is not evaluated, as a Deny with a condition is not: the checks here are about the unconditional grants.
  return statements.some((statement) => statement.Effect === "Allow" && statement.Condition === undefined && matches(statement)) && !statements.some((statement) => statement.Effect === "Deny" && statement.Condition === undefined && matches(statement));
}

// ---- the pieces under test, as pure functions so they can be shown to fail
/** The CloudFormation registry's handler permissions for the types the record creates (read 2026-11-08), by type. */
const HANDLER_PERMISSIONS = (JSON.parse(readFileSync(new URL("../fixtures/cfn-handler-permissions-team-record-2026-11-08.json", import.meta.url), "utf8")) as { types: Record<string, string[]> }).types;
/**
 * Handler permissions the deploy role does not hold on purpose (s3tables:DeleteTableBucketReplication is NOT one: IAM review F1 granted it, removing a replication copies nothing and the update and rollback may call it), with the reason: the record sets none of these properties, so CloudFormation does not call them. iam:* and the kms:/s3: entries are not in the access
 * stack's record statements: the service role has kms:* and s3:* by service, and IAM by name.
 */
const EXCLUDED_ON_PURPOSE: Readonly<Record<string, string>> = {
  "iam:PassRole": "the table bucket's replication role and the workgroup's execution role: the record passes none",
  "iam:CreateServiceLinkedRole": "Athena Spark workgroups only; the record's workgroup is SQL (engine version 3)",
  "s3tables:PutTableBucketReplication": "would let a deploy copy the lake to another bucket; the record sets no replication",
};
/** Every action of the three services, by service (AWS's service authorization reference, pinned). */
const SERVICE_ACTIONS = (JSON.parse(readFileSync(new URL("../fixtures/team-record-service-actions-2026-11-08.json", import.meta.url), "utf8")) as { actions: Record<string, string[]> }).actions;
const COVERED_ELSEWHERE = (permission: string): boolean => permission.startsWith("kms:") || permission.startsWith("s3:");

/** The service a resource type is created through, as the service role's wildcard list names it (the same mapping access-stack.test.ts uses). */
const serviceOfType = (type: string): string => type.split("::")[1]!.toLowerCase().replace("apigatewayv2", "apigateway").replace("cognito", "cognito-idp").replace("elasticloadbalancingv2", "elasticloadbalancing");

/**
 * The types the deploy role does NOT cover: neither a service wildcard of the service role, nor IAM / the stack's own helpers, nor a type with handler permissions pinned in the fixture. A new record resource type
 * (a new store, a new queue kind, a new key) shows up here until the access stack is taught about it.
 */
export function uncoveredTypes(addedTypes: readonly string[], wildcardServices: readonly string[], pinned: Readonly<Record<string, readonly string[]>>): string[] {
  const byName = new Set(["AWS::IAM::Role", "AWS::IAM::Policy", "AWS::IAM::ManagedPolicy", "AWS::CDK::Metadata"]);
  return [...new Set(addedTypes)].filter((type) => !byName.has(type) && !wildcardServices.includes(serviceOfType(type)) && !(type in pinned)).sort();
}

const synthOf = (app: App) => {
  const stacks = app.node.children.filter((child): child is Stack => Stack.isStack(child));
  const get = (id: string) => Template.fromStack(stacks.find((stack) => stack.node.id === id)!).toJSON().Resources as Resources;
  return { access: get("AgentXAccess"), controlPlane: get("AgentXControlPlane") };
};

let on: ReturnType<typeof synthOf>;
let off: ReturnType<typeof synthOf>;
beforeAll(() => {
  on = synthOf(buildAgentXApp({ agentxEnv: ENV, agentxCloud: true, agentxTeamRecord: "enabled" }));
  off = synthOf(buildAgentXApp({ agentxEnv: ENV, agentxCloud: true }));
}, 600_000);

const deployRole = (access: Resources, env = ENV) => {
  const role = Object.values(access).find((resource) => resource.Type === "AWS::IAM::Role" && resource.Properties.RoleName === `agentx-${env}-cloudformation`)!;
  const policy = (role.Properties.Policies as Array<{ PolicyName: string; PolicyDocument: { Statement: Statement[] } }>).find((candidate) => candidate.PolicyName === "deploy")!;
  const flat = resolver(access);
  // The deployed deploy policy carries no Sids (infra/lib/access.ts); they are put back by position.
  const withSids = serviceRoleWithSids(policy.PolicyDocument.Statement as unknown as Array<Record<string, unknown>>) as unknown as Statement[];
  return { statements: withSids.map((raw) => ("Fn::If" in (raw as object) ? (raw as unknown as { "Fn::If": [string, Statement, unknown] })["Fn::If"][1] : raw)), flat };
};
const boundary = (access: Resources, env = ENV) => {
  const policy = Object.values(access).find((resource) => resource.Type === "AWS::IAM::ManagedPolicy" && resource.Properties.ManagedPolicyName === `agentx-${env}-boundary`)!;
  return { statements: (policy.Properties.PolicyDocument as { Statement: Statement[] }).Statement, flat: resolver(access) };
};
/** The record's own statements: those in the switch-on control plane that the switch-off one does not have. */
const addedStatements = (withSwitch = on, without = off) => {
  const before = new Set(roleStatements(without.controlPlane).map(({ statement }) => JSON.stringify(statement)));
  return roleStatements(withSwitch.controlPlane).filter(({ statement }) => statement.Effect === "Allow" && !before.has(JSON.stringify(statement)));
};
const addedTypes = (withSwitch = on, without = off) => {
  const before = new Set(Object.keys(without.controlPlane));
  return Object.entries(withSwitch.controlPlane).filter(([id]) => !before.has(id)).map(([, resource]) => resource.Type);
};

describe("the switch adds what this test expects (positive controls)", () => {
  it("adds the three storage types, the vector data role and statements in the five services", () => {
    expect(addedTypes()).toEqual(expect.arrayContaining(["AWS::S3Vectors::VectorBucket", "AWS::S3Tables::TableBucket", "AWS::S3Tables::Namespace", "AWS::S3Tables::Table", "AWS::Athena::WorkGroup", "AWS::IAM::Role"]));
    const services = new Set(addedStatements().flatMap(({ statement }) => asList(statement.Action).map((action) => action.split(":")[0])));
    for (const service of ["s3vectors", "s3tables", "athena", "glue", "lakeformation", "sts", "dynamodb", "sqs"]) expect(services.has(service), service).toBe(true);
    // The self-hosted embedder replaced Bedrock Titan: the switch adds no Bedrock statement to any role (the embedder function's own role has no AWS service grant, and the broker may invoke only that function).
    expect(services.has("bedrock"), "bedrock").toBe(false);
    expect(addedStatements().length).toBeGreaterThan(10);
  });

  it("names each storage resource as derived-names.ts does, which the access stack's record ARNs repeat", () => {
    const names = (type: string, key: string) => Object.values(on.controlPlane).filter((resource) => resource.Type === type).map((resource) => String(resource.Properties[key]));
    expect(names("AWS::S3Vectors::VectorBucket", "VectorBucketName")).toEqual([teamRecordVectorBucketName(ENV)]);
    expect(names("AWS::S3Tables::TableBucket", "TableBucketName")).toEqual([teamRecordTableBucketName(ENV)]);
    expect(names("AWS::Athena::WorkGroup", "Name")).toEqual([teamRecordWorkGroupName(ENV)]);
  });
});

describe("1. the deploy role covers every resource type the switch adds", () => {
  it("covers each added type by a service wildcard or by pinned handler permissions", () => {
    expect(uncoveredTypes(addedTypes(), SERVICE_ROLE_SERVICES, HANDLER_PERMISSIONS)).toEqual([]);
  });

  it("the check fails on a type nobody covered (a made-up future record resource)", () => {
    expect(uncoveredTypes([...addedTypes(), "AWS::OpenSearchServerless::Collection", "AWS::S3Tables::TablePolicy"], SERVICE_ROLE_SERVICES, HANDLER_PERMISSIONS)).toEqual(["AWS::OpenSearchServerless::Collection", "AWS::S3Tables::TablePolicy"]);
  });

  it("the pinned handler permissions are exactly the six types the record creates in these services", () => {
    const needsPins = [...new Set(addedTypes())].filter((type) => !SERVICE_ROLE_SERVICES.includes(serviceOfType(type)) && !type.startsWith("AWS::IAM::") && type !== "AWS::CDK::Metadata").sort();
    expect(needsPins).toEqual(Object.keys(HANDLER_PERMISSIONS).filter((type) => needsPins.includes(type) || type === "AWS::S3Vectors::Index").filter((type) => type !== "AWS::S3Vectors::Index").sort());
    expect(Object.keys(HANDLER_PERMISSIONS).sort()).toEqual(["AWS::Athena::WorkGroup", "AWS::S3Tables::Namespace", "AWS::S3Tables::Table", "AWS::S3Tables::TableBucket", "AWS::S3Vectors::Index", "AWS::S3Vectors::VectorBucket"]);
  });

  it("allows every handler permission of those types on the environment's own resources, apart from the ones left out on purpose", () => {
    const { statements, flat } = deployRole(on.access);
    const vector = `arn:aws:s3vectors:${REGION}:${ACCOUNT}:bucket/${teamRecordVectorBucketName(ENV)}`;
    const lake = `arn:aws:s3tables:${REGION}:${ACCOUNT}:bucket/${teamRecordTableBucketName(ENV)}`;
    const candidates: Record<string, string[]> = {
      s3vectors: [vector, `${vector}/index/ws-abc`, "*"],
      s3tables: [lake, `${lake}/table/00000000-0000-0000-0000-000000000000`, "*"],
      athena: [`arn:aws:athena:${REGION}:${ACCOUNT}:workgroup/${teamRecordWorkGroupName(ENV)}`, "*"],
    };
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const [type, permissions] of Object.entries(HANDLER_PERMISSIONS)) {
      for (const permission of permissions) {
        if (permission in EXCLUDED_ON_PURPOSE || COVERED_ELSEWHERE(permission) || permission.startsWith("iam:")) continue;
        seen.add(permission);
        const resources = candidates[permission.split(":")[0]!]!;
        if (!resources.some((resource) => allowedBy(statements, permission, resource, flat))) missing.push(`${type}: ${permission}`);
      }
    }
    expect(missing).toEqual([]);
    // Positive control: the loop really covered the three services, many actions each.
    expect(seen.size).toBeGreaterThan(40);
    for (const prefix of ["s3vectors:", "s3tables:", "athena:"]) expect([...seen].filter((permission) => permission.startsWith(prefix)).length, prefix).toBeGreaterThan(5);
    // The excluded ones are denied, and every exclusion is still a real handler permission (a stale entry fails).
    for (const [permission] of Object.entries(EXCLUDED_ON_PURPOSE)) {
      expect(Object.values(HANDLER_PERMISSIONS).flat(), permission).toContain(permission);
      for (const resource of [vector, lake, "*"]) expect(allowedBy(statements, permission, resource, flat), `${permission} on ${resource}`).toBe(false);
    }
  });

  it("allows exactly the handler permissions and no other action of the three services: the name patterns over-match nothing", () => {
    const { statements, flat } = deployRole(on.access);
    const own: Record<string, string[]> = {
      s3vectors: [`arn:aws:s3vectors:${REGION}:${ACCOUNT}:bucket/${teamRecordVectorBucketName(ENV)}`, `arn:aws:s3vectors:${REGION}:${ACCOUNT}:bucket/${teamRecordVectorBucketName(ENV)}/index/ws-abc`],
      s3tables: [`arn:aws:s3tables:${REGION}:${ACCOUNT}:bucket/${teamRecordTableBucketName(ENV)}`, `arn:aws:s3tables:${REGION}:${ACCOUNT}:bucket/${teamRecordTableBucketName(ENV)}/table/00000000-0000-0000-0000-000000000000`],
      athena: [`arn:aws:athena:${REGION}:${ACCOUNT}:workgroup/${teamRecordWorkGroupName(ENV)}`],
    };
    const handlerActions = new Set(Object.values(HANDLER_PERMISSIONS).flat().filter((permission) => /^(s3vectors|s3tables|athena):/.test(permission) && !(permission in EXCLUDED_ON_PURPOSE)));
    const lists = new Set<string>(TEAM_RECORD_LIST_ACTIONS);
    const extra: string[] = [];
    const missing: string[] = [];
    for (const [service, actions] of Object.entries(SERVICE_ACTIONS)) {
      expect(actions.length, service).toBeGreaterThan(15);
      for (const action of actions) {
        const onOwn = own[service]!.some((resource) => allowedBy(statements, action, resource, flat));
        const onStar = allowedBy(statements, action, "*", flat);
        const expectedOwn = handlerActions.has(action) && !lists.has(action);
        // The List calls are on "*", which includes the record's own ARNs; they are checked on "*" below.
        if (onOwn && !expectedOwn && !lists.has(action)) extra.push(`${action} (own resources)`);
        if (!onOwn && expectedOwn) missing.push(action);
        if (onStar !== lists.has(action)) extra.push(`${action} on "*": ${String(onStar)}`);
      }
    }
    expect({ extra, missing }).toEqual({ extra: [], missing: [] });
    // Every handler action named by the fixtures exists in AWS's list (a typo in the pinned permissions would pass silently otherwise).
    for (const action of handlerActions) expect(SERVICE_ACTIONS[action.split(":")[0]!], action).toContain(action);
  });

  it("allows none of that on another environment's names, another bucket or another workgroup, and the List calls only on \"*\"", () => {
    const { statements, flat } = deployRole(on.access);
    const refused: Array<[string, string]> = [
      ["s3vectors:CreateVectorBucket", `arn:aws:s3vectors:${REGION}:${ACCOUNT}:bucket/agentx-other-record-vectors`],
      ["s3vectors:DeleteVectorBucket", `arn:aws:s3vectors:${REGION}:${ACCOUNT}:bucket/some-other-bucket`],
      ["s3vectors:CreateIndex", `arn:aws:s3vectors:${REGION}:${ACCOUNT}:bucket/some-other-bucket/index/x`],
      ["s3tables:CreateTableBucket", `arn:aws:s3tables:${REGION}:${ACCOUNT}:bucket/agentx-other-record-lake`],
      ["s3tables:DeleteTable", `arn:aws:s3tables:${REGION}:${ACCOUNT}:bucket/some-other-bucket/table/x`],
      ["athena:CreateWorkGroup", `arn:aws:athena:${REGION}:${ACCOUNT}:workgroup/primary`],
      ["athena:DeleteWorkGroup", `arn:aws:athena:${REGION}:${ACCOUNT}:workgroup/agentx-other-record`],
      // The deploy role makes the storage; it neither queries it nor changes who may read it.
      ["athena:StartQueryExecution", `arn:aws:athena:${REGION}:${ACCOUNT}:workgroup/${teamRecordWorkGroupName(ENV)}`],
      ["s3tables:PutTableBucketPolicy", `arn:aws:s3tables:${REGION}:${ACCOUNT}:bucket/${teamRecordTableBucketName(ENV)}`],
      ["s3tables:GetTableData", `arn:aws:s3tables:${REGION}:${ACCOUNT}:bucket/${teamRecordTableBucketName(ENV)}/table/x`],
      ["s3vectors:PutVectorBucketPolicy", `arn:aws:s3vectors:${REGION}:${ACCOUNT}:bucket/${teamRecordVectorBucketName(ENV)}`],
      ["s3vectors:PutVectors", `arn:aws:s3vectors:${REGION}:${ACCOUNT}:bucket/${teamRecordVectorBucketName(ENV)}/index/x`],
      ["glue:GetTable", `arn:aws:glue:${REGION}:${ACCOUNT}:catalog`],
      ["lakeformation:GetDataAccess", "*"],
    ];
    for (const [action, resource] of refused) expect(allowedBy(statements, action, resource, flat), `${action} on ${resource}`).toBe(false);
    for (const action of TEAM_RECORD_LIST_ACTIONS) expect(allowedBy(statements, action, "*", flat), action).toBe(true);
    // "*" is only for the List calls in these services: no other s3vectors/s3tables/athena action is on "*".
    const onStar = statements.filter((statement) => asList(statement.Resource).includes("*") && asList(statement.Action).some((action) => /^(s3vectors|s3tables|athena):/.test(action)));
    expect(onStar.flatMap((statement) => asList(statement.Action)).sort()).toEqual([...TEAM_RECORD_LIST_ACTIONS].sort());
  });
});

describe("2. the boundary covers every statement the switch adds to a role", () => {
  it("allows each action and each resource of each added Allow statement", () => {
    const { statements, flat } = boundary(on.access);
    const outside: string[] = [];
    let checked = 0;
    for (const { owner, statement, resources } of addedStatements()) {
      const targets = resources.length === 0 ? ["*"] : resources;
      for (const action of asList(statement.Action)) {
        for (const resource of targets) {
          checked += 1;
          if (!allowedBy(statements, action, resource, flat)) outside.push(`${owner}: ${action} on ${resource}`);
        }
      }
    }
    expect(outside).toEqual([]);
    expect(checked).toBeGreaterThan(40);
  });

  it("covers the exact actions the record grants in the five new services, and reads them from the template rather than from a list here", () => {
    const wanted = addedStatements().flatMap(({ statement }) => asList(statement.Action)).filter((action) => /^(s3vectors|s3tables|athena|glue|lakeformation):/.test(action));
    expect(new Set(wanted)).toEqual(new Set([
      "s3vectors:PutVectors", "s3vectors:QueryVectors", "s3vectors:GetVectors", "s3vectors:DeleteVectors", "s3vectors:GetIndex", "s3vectors:CreateIndex",
      // retires the workspace's index of the embedding generation before (team-record-vectors.ts: DeleteIndex on that one index name only)
      "s3vectors:DeleteIndex",
      "athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution",
      "s3tables:GetTableBucket", "s3tables:GetNamespace", "s3tables:GetTable", "s3tables:GetTableMetadataLocation", "s3tables:UpdateTableMetadataLocation", "s3tables:GetTableData", "s3tables:PutTableData",
      "glue:GetCatalog", "glue:GetDatabase", "glue:GetDatabases", "glue:GetTable", "glue:GetTables",
      "lakeformation:GetDataAccess",
    ]));
  });

  it("the check fails on an action outside the boundary (made-up additions)", () => {
    const { statements, flat } = boundary(on.access);
    expect(allowedBy(statements, "s3tables:GetTable", `arn:aws:s3tables:${REGION}:${ACCOUNT}:bucket/${teamRecordTableBucketName(ENV)}/table/x`, flat)).toBe(true);
    expect(allowedBy(statements, "opensearch:ESHttpGet", "*", flat)).toBe(false);
    expect(allowedBy(statements, "glue:DeleteTable", `arn:aws:glue:${REGION}:${ACCOUNT}:table/s3tablescatalog/${teamRecordTableBucketName(ENV)}/record/events`, flat)).toBe(false);
    expect(allowedBy(statements, "glue:CreateDatabase", "*", flat)).toBe(false);
    expect(allowedBy(statements, "lakeformation:GrantPermissions", "*", flat)).toBe(false);
    expect(allowedBy(statements, "lakeformation:GetDataAccess", "*", flat)).toBe(true);
    // No iam, sts or organizations by the back door: the new services are wildcards, those are not.
    expect(allowedBy(statements, "sts:AssumeRole", `arn:aws:iam::${ACCOUNT}:role/anything`, flat)).toBe(false);
  });
});

describe("3. the deploy role's own record grants fit under the boundary it runs under", () => {
  it("allows each action and resource of the deploy role's TeamRecord statements", () => {
    const deploy = deployRole(on.access);
    const ceiling = boundary(on.access);
    const outside: string[] = [];
    const record = deploy.statements.filter((statement) => statement.Sid?.startsWith("TeamRecord"));
    expect(record.map((statement) => statement.Sid)).toEqual(["TeamRecordStorage", "TeamRecordLists"]);
    for (const statement of record) {
      for (const action of asList(statement.Action)) {
        for (const resource of asList(statement.Resource).map((value) => deploy.flat(value))) {
          if (!allowedBy(ceiling.statements, action, resource, ceiling.flat)) outside.push(`${statement.Sid}: ${action} on ${resource}`);
        }
      }
    }
    expect(outside).toEqual([]);
  });
});

describe("4. the vector data role has a fixed name the boundary and the deploy role name, and the broker may assume it", () => {
  const roleArn = `arn:aws:iam::${ACCOUNT}:role${PATH}${teamRecordVectorsRoleName(ENV)}`;

  it("is created with the fixed name under the environment's path, with the boundary", () => {
    const roles = Object.values(on.controlPlane).filter((resource) => resource.Type === "AWS::IAM::Role" && resource.Properties.RoleName === teamRecordVectorsRoleName(ENV));
    expect(roles).toHaveLength(1);
    expect(roles[0]!.Properties.Path).toBe(PATH);
    expect(roles[0]!.Properties.PermissionsBoundary).toBeDefined();
    expect(teamRecordVectorsRoleName(ENV)).toBe("agentx-staging-record-vectors-data");
    // And the switch-off control plane has no such role, so the name is reserved by the access stack only.
    expect(Object.values(off.controlPlane).filter((resource) => resource.Type === "AWS::IAM::Role" && String(JSON.stringify(resource.Properties.RoleName)).includes("record-vectors"))).toEqual([]);
  });

  it("is what the broker is told to assume (packed name) and holds sts:AssumeRole and sts:TagSession on, and the boundary allows that and no other role", () => {
    const assume = addedStatements().find(({ statement }) => asList(statement.Action).includes("sts:AssumeRole"))!;
    expect(asList(assume.statement.Action).sort()).toEqual(["sts:AssumeRole", "sts:TagSession"]);
    expect(assume.resources).toEqual([roleArn]);
    const { statements, flat } = boundary(on.access);
    for (const action of ["sts:AssumeRole", "sts:TagSession"]) {
      expect(allowedBy(statements, action, roleArn, flat), action).toBe(true);
      expect(allowedBy(statements, action, `${roleArn}-other`, flat), `${action} on a lookalike`).toBe(false);
      expect(allowedBy(statements, action, `arn:aws:iam::${ACCOUNT}:role${PATH}agentx-${ENV}-broker-role`, flat), `${action} on the broker role`).toBe(false);
      expect(allowedBy(statements, action, `arn:aws:iam::${ACCOUNT}:role${PATH}agentx-${ENV}-record-vectors`, flat), `${action} on a shorter name`).toBe(false);
    }
  });

  it("can be looked up and cleaned up by name before it exists, by the deploy role and the boundary", () => {
    const pathless = `arn:aws:iam::${ACCOUNT}:role/${teamRecordVectorsRoleName(ENV)}`;
    for (const [label, set] of [["deploy role", deployRole(on.access)], ["boundary", boundary(on.access)]] as const) {
      for (const action of ["iam:GetRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:DeleteRole"]) {
        expect(allowedBy(set.statements, action, pathless, set.flat), `${label} allows ${action}`).toBe(true);
      }
      for (const action of ["iam:CreateRole", "iam:PutRolePolicy", "iam:PassRole"]) expect(allowedBy(set.statements, action, pathless, set.flat), `${label} refuses ${action} at the root`).toBe(false);
      expect(allowedBy(set.statements, "iam:CreateRole", roleArn, set.flat), `${label} creates it under the path`).toBe(true);
    }
  });
});

describe("review F1: the deploy role may remove a table bucket's replication, never set one", () => {
  it("allows s3tables:DeleteTableBucketReplication on the lake table bucket only, and refuses the Put and iam:PassRole", () => {
    const { statements, flat } = deployRole(on.access);
    const lake = `arn:aws:s3tables:${REGION}:${ACCOUNT}:bucket/${teamRecordTableBucketName(ENV)}`;
    expect(allowedBy(statements, "s3tables:DeleteTableBucketReplication", lake, flat)).toBe(true);
    expect(allowedBy(statements, "s3tables:DeleteTableBucketReplication", `arn:aws:s3tables:${REGION}:${ACCOUNT}:bucket/another-lake`, flat)).toBe(false);
    expect(allowedBy(statements, "s3tables:PutTableBucketReplication", lake, flat)).toBe(false);
    expect(allowedBy(statements, "iam:PassRole", `arn:aws:iam::${ACCOUNT}:role/anything`, flat)).toBe(false);
    expect(Object.keys(EXCLUDED_ON_PURPOSE)).not.toContain("s3tables:DeleteTableBucketReplication");
  });
});

describe("review F3: the boundary denies sharing the record's stores", () => {
  it("denies exactly the policy and replication writes of S3 Tables and S3 Vectors, on every resource, and no record role needs one", () => {
    const { statements, flat } = boundary(on.access);
    const universe = [...SERVICE_ACTIONS.s3tables!, ...SERVICE_ACTIONS.s3vectors!];
    const denied = universe.filter((action) => allowedBy([{ Effect: "Allow", Action: "*", Resource: "*" }, ...statements.filter((statement) => statement.Effect === "Deny")], action, "*", flat) === false);
    expect(denied.sort()).toEqual(["s3tables:PutTableBucketPolicy", "s3tables:PutTableBucketReplication", "s3tables:PutTablePolicy", "s3tables:PutTableReplication", "s3vectors:PutVectorBucketPolicy"]);
    // Positive control for the grid: an ordinary action of each service is not denied.
    for (const action of ["s3tables:GetTable", "s3tables:DeleteTableBucketReplication", "s3vectors:QueryVectors"]) expect(denied).not.toContain(action);
    // Section 2 (every added statement allowed by the boundary, Denies included) already proves no record role holds one; say it directly too.
    const held = addedStatements().flatMap(({ statement }) => asList(statement.Action)).filter((action) => denied.includes(action));
    expect(held).toEqual([]);
    const deploy = deployRole(on.access).statements.flatMap((statement) => asList(statement.Action));
    expect(deploy.some((pattern) => denied.some((action) => glob(pattern, action, "i")))).toBe(false);
  });
});

// Review F7: the Enterprise shape (customer key, pinned workspace index) adds an S3Vectors::Index and key statements the Public synth does not.
describe("Enterprise: customer key and a pinned workspace index", () => {
  const EENV = "ent";
  const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";
  const base = { agentxEnv: EENV, rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.99.0.0/16", agentxAuditTsa: "off" } as const;
  let eon: ReturnType<typeof synthOf>;
  let eoff: ReturnType<typeof synthOf>;
  beforeAll(() => {
    eon = synthOf(buildAgentXApp({ ...base, agentxTeamRecord: "enabled", agentxTeamRecordKmsKeyArn: KMS, agentxTeamRecordEnterpriseWorkspaceId: "org_aaaaaaaaaaaaaaaaaaaa" }));
    eoff = synthOf(buildAgentXApp({ ...base }));
  }, 600_000);

  it("adds the Index type, covered by the deploy role through the pinned handler permissions", () => {
    const types = addedTypes(eon, eoff);
    expect(types).toContain("AWS::S3Vectors::Index");
    expect(uncoveredTypes(types, SERVICE_ROLE_SERVICES, HANDLER_PERMISSIONS)).toEqual([]);
    const { statements, flat } = deployRole(eon.access, EENV);
    const index = `arn:aws:s3vectors:${REGION}:${ACCOUNT}:bucket/${teamRecordVectorBucketName(EENV)}/index/ws-x`;
    for (const permission of HANDLER_PERMISSIONS["AWS::S3Vectors::Index"]!.filter((candidate) => candidate.startsWith("s3vectors:"))) {
      expect(allowedBy(statements, permission, permission === "s3vectors:ListIndexes" ? `arn:aws:s3vectors:${REGION}:${ACCOUNT}:bucket/${teamRecordVectorBucketName(EENV)}` : index, flat), permission).toBe(true);
    }
  });

  it("every statement it adds, the key statements included, is inside the boundary, and the vector role is named", () => {
    const { statements, flat } = boundary(eon.access, EENV);
    const outside: string[] = [];
    const added = addedStatements(eon, eoff);
    expect(added.flatMap(({ statement }) => asList(statement.Action)).some((action) => action.startsWith("kms:"))).toBe(true);
    for (const { owner, statement, resources } of added) {
      for (const action of asList(statement.Action)) for (const resource of resources.length === 0 ? ["*"] : resources) if (!allowedBy(statements, action, resource, flat)) outside.push(`${owner}: ${action} on ${resource}`);
    }
    expect(outside).toEqual([]);
    expect(Object.values(eon.controlPlane).some((resource) => resource.Type === "AWS::IAM::Role" && resource.Properties.RoleName === teamRecordVectorsRoleName(EENV))).toBe(true);
  });
});
