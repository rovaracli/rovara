// SH22: the registry side of saved environment images, checked on the synthesised template and on the policies the broker puts on its sessions.
// What must hold: immutable tags, KMS, scan on push, the newest N kept, a repository policy that lets only the push and pull roles touch an image, a key policy that grants no use, a session that reaches
// ONE project's repository (never another project's or another org's), and no grant for the worker's instance role.
import { App, Stack, aws_iam as iam } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  SAVED_ENV_PULL_ACTIONS,
  SAVED_ENV_PUSH_ACTIONS,
  savedEnvManageSessionPolicy,
  savedEnvPullRoleName,
  savedEnvPullSessionPolicy,
  savedEnvPushRoleName,
  savedEnvPushSessionPolicy,
  savedEnvRepositoryName,
  savedEnvRepositoryPolicy,
  savedEnvManageRoleName,
  savedEnvCreateRoleName,
  savedEnvScanSessionPolicy,
  SAVED_ENV_PUSH_SESSION_SECONDS,
} from "@agentx/contracts";
import { SavedEnvImages } from "../../infra/lib/saved-env-images.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const ACCOUNT = "111122223333";
const REGION = "us-west-2";
const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";
const SCOPE = { partition: "aws", region: REGION, account: ACCOUNT };

function build(props: Partial<ConstructorParameters<typeof SavedEnvImages>[2]> = {}) {
  const stack = new Stack(new App(), "T", { env: { account: ACCOUNT, region: REGION } });
  const broker = new iam.Role(stack, "Broker", { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"), roleName: "agentx-test-broker-role" });
  const images = new SavedEnvImages(stack, "S", { env: "test", brokerRole: broker, cloudFormationRoleName: "agentx-test-cfn", ...props });
  return { stack, broker, images, template: Template.fromStack(stack) };
}

/** A CloudFormation value as text, with each reference or attribute shown as `<logical id>` and a join flattened, so a JSON string with tokens can be parsed. */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record["Fn::GetAtt"])) return `<${String(record["Fn::GetAtt"][0])}>`;
  if (typeof record["Ref"] === "string") return `<${record["Ref"]}>`;
  const join = record["Fn::Join"] as [string, unknown[]] | undefined;
  if (join !== undefined) return join[1].map(flatten).join(join[0]);
  throw new Error(`cannot flatten ${JSON.stringify(value)}`);
}

interface Statement { Sid?: string; Effect: string; Action?: string | string[]; Resource?: string | string[]; Principal?: unknown; Condition?: Record<string, Record<string, string | string[]>> }
/** The properties of the one resource of a type, as plain records (the template's own type is `any`). */
const propsOf = (template: Template, type: string): Record<string, unknown> => (Object.values(template.findResources(type))[0]!.Properties ?? {}) as Record<string, unknown>;
const list = (value: string | string[] | undefined): string[] => (value === undefined ? [] : [value].flat());

describe("the creation template", () => {
  const { template } = build();
  const props = () => Object.values(template.findResources("AWS::ECR::RepositoryCreationTemplate"))[0]!.Properties as Record<string, unknown>;

  it("creates repositories with immutable tags, KMS encryption, and only on push, under this environment's prefix", () => {
    template.resourceCountIs("AWS::ECR::RepositoryCreationTemplate", 1);
    expect(props()).toMatchObject({ Prefix: "rovara-env/test", AppliedFor: ["CREATE_ON_PUSH"], ImageTagMutability: "IMMUTABLE", EncryptionConfiguration: { EncryptionType: "KMS" } });
    expect(props()["CustomRoleArn"]).toBeDefined();
  });

  it("names a creation role at the root path: ECR's CustomRoleArn pattern has no room for an IAM path (staging, 2026-11-03)", () => {
    // ^arn:aws[-a-z0-9]*:iam::[0-9]{12}:role/[A-Za-z0-9+=,-.@_]*$ : the name part cannot hold a "/", so a role under /agentx/<env>/ is refused at validation.
    const arn = props()["CustomRoleArn"] as { "Fn::GetAtt": [string, string] };
    expect(arn["Fn::GetAtt"][1]).toBe("Arn");
    const resources = template.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>;
    const role = resources[arn["Fn::GetAtt"][0]]!;
    expect(role.Type).toBe("AWS::IAM::Role");
    expect(role.Properties["RoleName"]).toBe("agentx-test-img-create");
    expect(role.Properties["Path"]).toBe("/");
    const resolved = `arn:aws:iam::${ACCOUNT}:role${String(role.Properties["Path"])}${String(role.Properties["RoleName"])}`;
    expect(resolved).toMatch(/^arn:aws[-a-z0-9]*:iam::[0-9]{12}:role\/[A-Za-z0-9+=,\-.@_]*$/u);
  });

  it("expires untagged images after a day and has a count backstop of the largest keep plus 3 (13), whatever keep is; there is NO age rule (a tagged-image age rule never matches behind a count rule: the broker's manage walk holds the 30 day ceiling)", () => {
    const rules = (JSON.parse(props()["LifecyclePolicy"] as string) as { rules: Array<{ rulePriority: number; selection: Record<string, unknown> }> }).rules;
    expect(rules.map((rule) => rule.rulePriority)).toEqual([1, 2]);
    expect(rules[0]!.selection).toMatchObject({ tagStatus: "untagged", countNumber: 1 });
    expect(rules[1]!.selection).toMatchObject({ tagStatus: "tagged", countType: "imageCountMoreThan", countNumber: 13 });
    expect(JSON.stringify(rules)).not.toContain("sinceImagePushed\",\"countUnit\":\"days\",\"countNumber\":30");
    expect(rules.some((rule) => rule.selection["tagStatus"] === "any")).toBe(false);
  });

  it("the company's keep setting (1 to 10) changes the count, and 0 or 11 are refused", () => {
    expect((JSON.parse(propsOf(build({ keep: 6 }).template, "AWS::ECR::RepositoryCreationTemplate")["LifecyclePolicy"] as string) as { rules: Array<{ selection: { countNumber: number } }> }).rules[1]!.selection.countNumber).toBe(13);
    expect(() => build({ keep: 0 })).toThrow();
    expect(() => build({ keep: 11 })).toThrow();
  });

  it("does not touch the registry-wide scan setting by default, and turns basic scan-on-push on only when asked", () => {
    template.resourceCountIs("AWS::ECR::RegistryScanningConfiguration", 0);
    build({ registryScanning: "none" }).template.resourceCountIs("AWS::ECR::RegistryScanningConfiguration", 0);
    build({ registryScanning: "basic" }).template.hasResourceProperties("AWS::ECR::RegistryScanningConfiguration", { ScanType: "BASIC", Rules: [{ ScanFrequency: "SCAN_ON_PUSH" }] });
  });

  it("carries no em dash in any name or description", () => {
    expect(JSON.stringify(template.toJSON())).not.toContain("—");
  });
});

describe("the repository policy", () => {
  const { template } = build();
  const policy = JSON.parse(flatten(propsOf(template, "AWS::ECR::RepositoryCreationTemplate")["RepositoryPolicy"])) as { Statement: Statement[] };
  const roleIds = Object.entries(template.findResources("AWS::IAM::Role")).map(([id, role]) => [id, (role.Properties as { RoleName?: string }).RoleName] as const);
  const idOf = (name: string) => `<${roleIds.find(([, roleName]) => roleName === name)![0]}>`;

  /** Whether the repository policy DENIES `action` for `principalArn` (a Deny with ArnNotEquals on aws:PrincipalArn applies when the principal is not in the list). */
  const denied = (action: string, principalArn: string): boolean =>
    policy.Statement.some((statement) => statement.Effect === "Deny" && list(statement.Action).includes(action)
      && !list(statement.Condition?.["ArnNotEquals"]?.["aws:PrincipalArn"]).includes(principalArn));

  it("lets the pull role read and the push role read and write, and denies everyone else (the worker's instance role, an administrator, the broker)", () => {
    for (const action of ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]) {
      expect(denied(action, idOf(savedEnvPullRoleName("test")))).toBe(false);
      expect(denied(action, idOf(savedEnvPushRoleName("test")))).toBe(false);
      for (const other of ["<WorkerInstanceRole>", "<Admin>", "<Broker>", idOf(savedEnvManageRoleName("test"))]) expect(denied(action, other)).toBe(true);
    }
    for (const action of ["ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"]) {
      expect(denied(action, idOf(savedEnvPushRoleName("test")))).toBe(false);
      for (const other of [idOf(savedEnvPullRoleName("test")), "<WorkerInstanceRole>", "<Admin>"]) expect(denied(action, other)).toBe(true);
    }
  });

  it("lets only the manage role delete images", () => {
    expect(denied("ecr:BatchDeleteImage", idOf(savedEnvManageRoleName("test")))).toBe(false);
    for (const other of [idOf(savedEnvPushRoleName("test")), idOf(savedEnvPullRoleName("test")), "<Admin>"]) expect(denied("ecr:BatchDeleteImage", other)).toBe(true);
  });

  it("is the same policy the contracts function makes", () => {
    expect(policy).toEqual(JSON.parse(JSON.stringify(savedEnvRepositoryPolicy({ pushRoleArn: idOf(savedEnvPushRoleName("test")), pullRoleArn: idOf(savedEnvPullRoleName("test")), manageRoleArn: idOf(savedEnvManageRoleName("test")) }))));
  });
});

describe("the key", () => {
  const { template } = build();
  const key = Object.values(template.findResources("AWS::KMS::Key"))[0]!;
  const statements = (key.Properties as { KeyPolicy: { Statement: Statement[] } }).KeyPolicy.Statement;

  it("rotates, and no statement grants use (decrypt, encrypt, generate data key) to anyone", () => {
    expect((key.Properties as { EnableKeyRotation: boolean }).EnableKeyRotation).toBe(true);
    const allowed = statements.filter((statement) => statement.Effect === "Allow").flatMap((statement) => list(statement.Action));
    expect(allowed.filter((action) => /Decrypt|Encrypt|GenerateDataKey|ReEncrypt|kms:\*/u.test(action))).toEqual([]);
    expect(allowed).not.toContain("kms:Create*");
  });

  it("lets only ECR's creation role create a grant, only through ECR, and denies every other principal", () => {
    const allow = statements.find((statement) => statement.Sid === "CreationRoleGrantForEcr")!;
    expect(flatten((allow.Condition as Record<string, Record<string, unknown>>)["StringEquals"]!["kms:ViaService"])).toBe("ecr.<AWS::Region>.amazonaws.com");
    expect(allow.Condition).toMatchObject({ Bool: { "kms:GrantIsForAWSResource": "true" } });
    expect(list(allow.Action).sort()).toEqual(["kms:CreateGrant", "kms:DescribeKey"]);
    const deny = statements.find((statement) => statement.Sid === "DenyOtherGrants")!;
    expect(deny).toMatchObject({ Effect: "Deny", Action: "kms:CreateGrant" });
    expect(statements.some((statement) => statement.Effect === "Allow" && list(statement.Action).includes("kms:CreateGrant") && statement.Sid !== "CreationRoleGrantForEcr")).toBe(false);
  });

  it("only the deploy role may schedule the key's deletion", () => {
    const destroy = statements.find((statement) => statement.Sid === "DenyDestroy")!;
    expect(list(destroy.Action)).toContain("kms:ScheduleKeyDeletion");
    expect(JSON.stringify(destroy.Condition)).toContain("role/agentx-test-cfn");
  });

  it("Enterprise's own key: no key is made, the template uses it, and the install prints the statements its policy needs", () => {
    const b = build({ kmsKeyArn: KMS });
    b.template.resourceCountIs("AWS::KMS::Key", 0);
    expect((propsOf(b.template, "AWS::ECR::RepositoryCreationTemplate")["EncryptionConfiguration"] as { KmsKey: string }).KmsKey).toBe(KMS);
    expect(Object.keys(b.template.findOutputs("*")).some((id) => id.includes("KmsKeyPolicyStatements"))).toBe(true);
    expect(() => build({ kmsKeyArn: "arn:aws:kms:us-west-2:111122223333:alias/x" })).toThrow(/not an alias/);
    // in this account and region when those are concrete
    expect(() => build({ kmsKeyArn: "arn:aws:kms:us-east-1:111122223333:key/11111111-2222-3333-4444-555555555555" })).toThrow(/own account and region/);
    expect(() => build({ kmsKeyArn: "arn:aws:kms:us-west-2:999999999999:key/11111111-2222-3333-4444-555555555555" })).toThrow(/own account and region/);
  });

  it("Enterprise's own key: the printed statements work BEFORE the role exists (root principal plus an aws:PrincipalArn condition on the fixed-name role), say the key is dedicated, and the role carries the identity right", () => {
    const b = build({ kmsKeyArn: KMS });
    const output = Object.entries(b.template.findOutputs("*")).find(([id]) => id.includes("KmsKeyPolicyStatements"))!;
    const text = flatten((output[1] as { Value: unknown }).Value);
    const statements = JSON.parse(text.replace(/<AWS::(Partition|AccountId|Region)>/gu, (_m, name: string) => ({ Partition: "aws", AccountId: ACCOUNT, Region: REGION })[name]!)) as Statement[];
    const allow = statements.find((statement) => statement.Sid === "CreationRoleGrantForEcr")!;
    expect(JSON.stringify(allow.Principal)).toContain(":root");
    expect(allow.Condition?.["ArnEquals"]?.["aws:PrincipalArn"]).toBe(`arn:aws:iam::${ACCOUNT}:role/agentx-test-img-create`);
    expect((output[1] as { Description: string }).Description).toContain("DEDICATED");
    const policies = Object.values(b.template.findResources("AWS::IAM::Policy")).map((policy) => JSON.stringify(policy.Properties));
    expect(policies.some((policy) => policy.includes("CustomerKeyGrantForEcr") && policy.includes(KMS))).toBe(true);
  });
});

describe("the roles", () => {
  const { template } = build();
  const roles = Object.values(template.findResources("AWS::IAM::Role")).map((role) => role.Properties as { RoleName?: string; AssumeRolePolicyDocument: { Statement: Array<{ Principal: Record<string, unknown> }> } });
  const named = (name: string) => roles.find((role) => role.RoleName === name)!;

  it("push, pull and manage trust only the broker role", () => {
    for (const name of [savedEnvPushRoleName("test"), savedEnvPullRoleName("test"), savedEnvManageRoleName("test")]) {
      const trust = named(name).AssumeRolePolicyDocument.Statement;
      expect(trust).toHaveLength(1);
      expect(JSON.stringify(trust[0]!.Principal)).toContain("Fn::GetAtt");
      expect(JSON.stringify(trust[0]!.Principal)).toContain("Broker");
    }
  });

  it("push, pull and manage may be assumed for up to the push session length (3,600 seconds), no longer", () => {
    for (const name of [savedEnvPushRoleName("test"), savedEnvPullRoleName("test"), savedEnvManageRoleName("test")]) {
      const role = Object.values(template.findResources("AWS::IAM::Role")).find((candidate) => (candidate.Properties as { RoleName?: string }).RoleName === name)!;
      expect((role.Properties as { MaxSessionDuration: number }).MaxSessionDuration).toBe(SAVED_ENV_PUSH_SESSION_SECONDS);
    }
    expect(SAVED_ENV_PUSH_SESSION_SECONDS).toBe(3_600);
  });

  it("ECR's creation role has a fixed name, so an Enterprise key policy can name it", () => {
    expect(named(savedEnvCreateRoleName("test"))).toBeDefined();
    expect(savedEnvCreateRoleName("test")).toBe("agentx-test-img-create");
  });

  it("ECR's creation role is assumable by ECR in this account only", () => {
    const create = roles.find((role) => JSON.stringify(role.AssumeRolePolicyDocument).includes("ecr.amazonaws.com"))!;
    expect(create.AssumeRolePolicyDocument.Statement).toHaveLength(1);
    expect(JSON.stringify(create.AssumeRolePolicyDocument.Statement[0])).toContain("aws:SourceAccount");
  });

  it("each role's own policy reaches this environment's repositories and nothing else but the registry token", () => {
    const policies = Object.values(template.findResources("AWS::IAM::Policy")).map((policy) => policy.Properties as { PolicyDocument: { Statement: Statement[] }; Roles: unknown[] });
    for (const policy of policies) {
      const mine = policy.PolicyDocument.Statement.filter((statement) => list(statement.Action).some((action) => action.startsWith("ecr:")));
      for (const statement of mine) {
        const actions = list(statement.Action);
        if (actions.includes("ecr:GetAuthorizationToken")) { expect(actions).toEqual(["ecr:GetAuthorizationToken"]); continue; }
        expect(JSON.stringify(statement.Resource)).toContain("repository/rovara-env/test/*");
        expect(actions.every((action) => action !== "ecr:*")).toBe(true);
      }
    }
    const pushActions = policies.flatMap((policy) => policy.PolicyDocument.Statement).filter((statement) => statement.Sid === "ThisEnvironmentsImages").map((statement) => list(statement.Action).sort().join(","));
    expect(pushActions).toContain([...SAVED_ENV_PUSH_ACTIONS].sort().join(","));
    expect(pushActions).toContain([...SAVED_ENV_PULL_ACTIONS].sort().join(","));
  });

  it("the broker may assume the three roles and has no ECR right of its own", () => {
    const { broker, images } = build();
    const statements = ((broker.node.findAll().find((node) => node instanceof iam.Policy) as iam.Policy).document.toJSON() as { Statement: Statement[] }).Statement;
    const assume = statements.find((statement) => statement.Sid === "AssumeSavedEnvImageRoles")!;
    expect(list(assume.Action)).toEqual(["sts:AssumeRole"]);
    expect(list(assume.Resource as string[])).toHaveLength(3);
    expect(statements.some((statement) => list(statement.Action).some((action) => action.startsWith("ecr:") || action.startsWith("kms:")))).toBe(false);
    expect(images.pushRole).toBeDefined();
  });
});

describe("tenancy: a session reaches one project's repository", () => {
  const a = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "proj-1" });
  const sameOrgOtherProject = savedEnvRepositoryName({ env: "test", orgId: "org-1", projectId: "proj-2" });
  const otherOrgSameProject = savedEnvRepositoryName({ env: "test", orgId: "org-2", projectId: "proj-1" });
  const arn = (name: string) => `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/${name}`;

  /** What a session may do on `resource`: allowed only if an Allow statement lists the action and its Resource is exactly that ARN or `*` (the registry token). No wildcard match: an ARN with `*` never equals another repository. */
  const allows = (policy: { Statement: Array<Record<string, unknown>> }, action: string, resource: string): boolean =>
    policy.Statement.some((statement) => list(statement["Action"] as string | string[]).includes(action) && list(statement["Resource"] as string | string[]).some((candidate) => candidate === resource || (candidate === "*" && resource === "*")));

  it("names differ for another project and for another org with the same project id, and hold no id in the clear", () => {
    expect(new Set([a, sameOrgOtherProject, otherOrgSameProject]).size).toBe(3);
    expect(a).not.toContain("org-1");
    expect(a).not.toContain("proj-1");
    expect(a).toMatch(/^rovara-env\/test\/o[a-f0-9]{32}\/p[a-f0-9]{32}$/u);
  });

  it("a push session reaches its own repository and not another project's or another org's, for every action", () => {
    const policy = savedEnvPushSessionPolicy(SCOPE, a);
    for (const action of SAVED_ENV_PUSH_ACTIONS) {
      expect(allows(policy, action, arn(a))).toBe(true);
      expect(allows(policy, action, arn(sameOrgOtherProject))).toBe(false);
      expect(allows(policy, action, arn(otherOrgSameProject))).toBe(false);
    }
  });

  it("a pull session reaches its own repository to read, cannot push or delete, and not another project's or org's", () => {
    const policy = savedEnvPullSessionPolicy(SCOPE, a);
    for (const action of SAVED_ENV_PULL_ACTIONS) {
      expect(allows(policy, action, arn(a))).toBe(true);
      expect(allows(policy, action, arn(sameOrgOtherProject))).toBe(false);
      expect(allows(policy, action, arn(otherOrgSameProject))).toBe(false);
    }
    for (const action of ["ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:BatchDeleteImage", "ecr:DeleteRepository", "ecr:SetRepositoryPolicy"]) expect(allows(policy, action, arn(a))).toBe(false);
  });

  it("a push session may also start a scan of its own repository (a basic scan after each push) and nothing else new", () => {
    const policy = savedEnvPushSessionPolicy(SCOPE, a);
    expect(allows(policy, "ecr:StartImageScan", arn(a))).toBe(true);
    expect(allows(policy, "ecr:StartImageScan", arn(sameOrgOtherProject))).toBe(false);
    const scan = savedEnvScanSessionPolicy(SCOPE, a);
    for (const action of ["ecr:StartImageScan", "ecr:DescribeImageScanFindings"]) { expect(allows(scan, action, arn(a))).toBe(true); expect(allows(scan, action, arn(otherOrgSameProject))).toBe(false); }
    for (const action of ["ecr:GetAuthorizationToken", "ecr:PutImage", "ecr:BatchGetImage", "ecr:BatchDeleteImage"]) expect(allows(scan, action, arn(a))).toBe(false);
  });

  it("a manage session can read the repository's policy and description (the broker's squatting check) and delete its own images only, and has no token, push or pull", () => {
    const policy = savedEnvManageSessionPolicy(SCOPE, a);
    expect(allows(policy, "ecr:BatchDeleteImage", arn(a))).toBe(true);
    expect(allows(policy, "ecr:BatchDeleteImage", arn(sameOrgOtherProject))).toBe(false);
    for (const action of ["ecr:GetAuthorizationToken", "ecr:PutImage", "ecr:BatchGetImage"]) expect(allows(policy, action, arn(a))).toBe(false);
  });

  it("a session policy fits the 2,048 character limit and no resource has a wildcard but the registry token", () => {
    for (const policy of [savedEnvPushSessionPolicy(SCOPE, a), savedEnvPullSessionPolicy(SCOPE, a), savedEnvManageSessionPolicy(SCOPE, a)]) {
      expect(JSON.stringify(policy).length).toBeLessThan(2_048);
      const resources = policy.Statement.flatMap((statement) => list(statement["Resource"] as string | string[]));
      expect(resources.filter((resource) => resource.includes("*") && resource !== "*")).toEqual([]);
      expect(policy.Statement.filter((statement) => statement["Resource"] === "*").map((statement) => statement["Action"])).toSatisfy((actions: unknown[]) => actions.every((action) => action === "ecr:GetAuthorizationToken"));
    }
  });

  it("a name that is not one of ours (wildcard, policy variable, another environment's shape) never becomes an ARN", () => {
    for (const bad of ["rovara-env/test/*", "rovara-env/test/o${aws:username}/p1", `${a}/extra`, "other/test/o" + "a".repeat(32) + "/p" + "a".repeat(32), `${a.slice(0, -1)}?`]) {
      expect(() => savedEnvPushSessionPolicy(SCOPE, bad)).toThrow();
      expect(() => savedEnvPullSessionPolicy(SCOPE, bad)).toThrow();
    }
  });
});

describe("the whole named install", () => {
  type Statement2 = { Resource?: unknown; Action?: unknown };
  type Resource = { Type: string; Properties: { PolicyDocument?: { Statement: Statement2[] }; Roles?: Array<{ Ref?: string }> } };
  const stacks = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child));
  const templates = stacks.map((stack) => ({ name: stack.stackName, json: Template.fromStack(stack).toJSON() as { Resources: Record<string, Resource> } }));

  it("only the three saved environment roles hold a right on the saved environment repositories: the worker's instance role, the broker, and every other role hold none", () => {
    const holders: Array<{ stack: string; role: string }> = [];
    for (const { name, json } of templates) {
      for (const resource of Object.values(json.Resources)) {
        if (resource.Type !== "AWS::IAM::Policy") continue;
        for (const statement of resource.Properties.PolicyDocument!.Statement) {
          if (!JSON.stringify(statement.Resource ?? "").includes("rovara-env")) continue;
          for (const role of resource.Properties.Roles ?? []) holders.push({ stack: name, role: role.Ref ?? "" });
        }
      }
    }
    expect(holders).toHaveLength(4);
    for (const holder of holders) expect(holder.role).toMatch(/^SavedEnvImages(Push|Pull|Manage|Create)Role/u);
  });

  it("no inline or managed policy gives anyone ecr rights on every repository of the account for a named install (the worker's pull stays limited to its one worker image)", () => {
    for (const { json } of templates) {
      for (const resource of Object.values(json.Resources)) {
        if (resource.Type !== "AWS::IAM::Policy" && resource.Type !== "AWS::IAM::ManagedPolicy") continue;
        for (const statement of resource.Properties.PolicyDocument?.Statement ?? []) {
          const actions = [statement.Action].flat().map(String);
          const text = JSON.stringify(statement.Resource ?? "");
          if (actions.some((action) => action === "ecr:BatchGetImage" || action === "ecr:GetDownloadUrlForLayer") && text.includes("repository/*")) throw new Error(`an ecr pull right on every repository: ${text}`);
        }
      }
    }
  });
});
