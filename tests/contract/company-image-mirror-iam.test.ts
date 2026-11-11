// Company images, 0.5.15 fix round: the mirror function may reach MIRROR repositories only, by IAM and not only by the session policy its own code passes. The mirror has a role of its own whose resource pattern matches
// `rovara-env/<env>/o<32>/c<32>` and no saved environment's `.../p<32>`; the function's role assumes that role and nothing else; the saved environment push, manage and pull roles are the broker's alone.
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  COMPANY_IMAGE_MIRROR_ACTIONS, SAVED_ENV_MANAGE_ACTIONS, SAVED_ENV_PUSH_ACTIONS, companyImageMirrorRoleName, companyImageMirrorSessionPolicy, companyImageRepositoriesArn, companyImageRepositoryName,
  isCompanyImageRepositoryName, isSavedEnvRepositoryName, savedEnvManageRoleName, savedEnvPullRoleName, savedEnvPushRoleName, savedEnvRepositoryArn, savedEnvRepositoryName, savedEnvRepositoryPolicy,
} from "@agentx/contracts";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { TEST_ORG } from "../support/orgs.js";

skipLambdaBundling();

const SCOPE = { partition: "aws", region: "us-west-2", account: "123456789012" };
/** IAM's own matching of a resource pattern: `*` is any run of characters (a `/` too), `?` is exactly one. */
const iamMatches = (pattern: string, value: string): boolean => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*").replace(/\?/gu, ".")}$`, "u").test(value);
const arn = (repository: string): string => `arn:aws:ecr:us-west-2:123456789012:repository/${repository}`;

describe("the mirror's resource pattern", () => {
  const pattern = companyImageRepositoriesArn(SCOPE, "staging");
  const mirror = companyImageRepositoryName({ env: "staging", orgId: TEST_ORG, imageId: "img_" + "1".repeat(20) });
  const project = savedEnvRepositoryName({ env: "staging", orgId: TEST_ORG, projectId: "web" });

  it("matches every mirror repository of the environment and no saved environment's repository", () => {
    expect(isCompanyImageRepositoryName(mirror)).toBe(true);
    expect(isSavedEnvRepositoryName(mirror)).toBe(false);
    expect(isCompanyImageRepositoryName(project)).toBe(false);
    expect(iamMatches(pattern, arn(mirror))).toBe(true);
    expect(iamMatches(pattern, arn(project))).toBe(false);
    // Every project's repository, whatever the hashes, and names that only look like one: nothing the pattern lets through.
    for (let index = 0; index < 50; index += 1) {
      const other = savedEnvRepositoryName({ env: "staging", orgId: `org_${String(index).padStart(20, "a")}`, projectId: `project-${String(index)}` });
      expect(iamMatches(pattern, arn(other)), other).toBe(false);
    }
    const head = mirror.split("/").slice(0, 3).join("/");
    for (const sneaky of [`${mirror}/extra`, `${mirror}x`, mirror.replace("/c", "/p"), `${head}/c${"a".repeat(31)}`, `${head}/c${"a".repeat(33)}`, `${head}/p${"a".repeat(32)}/c${"a".repeat(32)}`, mirror.replace("staging", "prod"), `rovara-env/staging/o${"a".repeat(32)}/p${"a".repeat(31)}/c${"a".repeat(32)}`, `other/${mirror}`]) {
      expect(iamMatches(pattern, arn(sneaky)), sneaky).toBe(false);
    }
  });

  it("is the only resource of the mirror's session policy too, and the session policy reaches one repository", () => {
    const session = companyImageMirrorSessionPolicy(SCOPE, mirror);
    expect(session.Statement).toEqual([{ Sid: "MirrorThisRepository", Effect: "Allow", Action: [...COMPANY_IMAGE_MIRROR_ACTIONS], Resource: arn(mirror) }]);
    expect(() => companyImageMirrorSessionPolicy(SCOPE, project.replace("/p", "/c") + "/x")).toThrow();
    expect(() => companyImageMirrorSessionPolicy(SCOPE, "rovara-env/staging/*")).toThrow();
    expect(() => savedEnvRepositoryArn(SCOPE, "rovara-env/staging/o" + "a".repeat(32) + "/*")).toThrow();
    // The mirror's actions are not the saved environment push or manage actions' superset by accident: it has no registry token, no scan.
    expect(COMPANY_IMAGE_MIRROR_ACTIONS).not.toContain("ecr:GetAuthorizationToken");
    expect(COMPANY_IMAGE_MIRROR_ACTIONS).not.toContain("ecr:StartImageScan");
    expect(COMPANY_IMAGE_MIRROR_ACTIONS).not.toContain("ecr:SetRepositoryPolicy");
    expect(COMPANY_IMAGE_MIRROR_ACTIONS).not.toContain("ecr:PutLifecyclePolicy");
    expect(SAVED_ENV_PUSH_ACTIONS.length).toBeGreaterThan(0);
    expect(SAVED_ENV_MANAGE_ACTIONS).toContain("ecr:DeleteRepository");
  });

  it("is named by the template's repository policy so the mirror can read, write and delete there, and the saved environment roles' lists are unchanged", () => {
    const names = { pushRoleArn: "arn:aws:iam::1:role/push", pullRoleArn: "arn:aws:iam::1:role/pull", manageRoleArn: "arn:aws:iam::1:role/manage" };
    const without = JSON.stringify(savedEnvRepositoryPolicy(names));
    const withMirror = savedEnvRepositoryPolicy({ ...names, mirrorRoleArn: "arn:aws:iam::1:role/mirror" });
    expect(JSON.stringify(withMirror)).toContain("arn:aws:iam::1:role/mirror");
    expect(without).not.toContain("mirror");
    const byId = Object.fromEntries(withMirror.Statement.map((statement) => [statement["Sid"] as string, statement]));
    expect((byId["OnlyTheRolesMayRead"]!["Condition"] as { ArnNotEquals: { "aws:PrincipalArn": string[] } }).ArnNotEquals["aws:PrincipalArn"]).toEqual([names.pushRoleArn, names.pullRoleArn, "arn:aws:iam::1:role/mirror"]);
    expect((byId["OnlyThePushRoleMayWrite"]!["Condition"] as { ArnNotEquals: { "aws:PrincipalArn": string[] } }).ArnNotEquals["aws:PrincipalArn"]).toEqual([names.pushRoleArn, "arn:aws:iam::1:role/mirror"]);
    expect((byId["OnlyTheManageRoleMayDeleteImages"]!["Condition"] as { ArnNotEquals: { "aws:PrincipalArn": string[] } }).ArnNotEquals["aws:PrincipalArn"]).toEqual([names.manageRoleArn, "arn:aws:iam::1:role/mirror"]);
  });
});

type Doc = { Statement: Array<{ Sid?: string; Effect: string; Action?: string | string[]; Resource?: unknown; Principal?: { AWS?: unknown }; Condition?: unknown }> };
type Resource = { Type: string; Properties: Record<string, unknown> };

describe("the synthesised control plane", () => {
  const template = Template.fromStack(new ControlPlaneStack(new App(), "CompanyImageMirrorIam", { naming: environmentNaming("staging") }));
  const all = template.toJSON().Resources as Record<string, Resource>;
  const rolesNamed = (name: string) => Object.entries(all).filter(([, resource]) => resource.Type === "AWS::IAM::Role" && resource.Properties["RoleName"] === name);
  const roleId = (name: string): string => rolesNamed(name)[0]![0];
  const policiesOf = (id: string): Doc[] => Object.values(all).filter((resource) => resource.Type === "AWS::IAM::Policy" && (resource.Properties["Roles"] as Array<{ Ref?: string }>).some((role) => role.Ref === id)).map((resource) => resource.Properties["PolicyDocument"] as Doc);
  const functionRoleId = (prefix: string): string => {
    const found = Object.entries(all).find(([id, resource]) => resource.Type === "AWS::Lambda::Function" && id.startsWith(prefix))!;
    return ((found[1].Properties["Role"] as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
  };
  const trustedBy = (id: string): unknown[] => ((all[id]!.Properties["AssumeRolePolicyDocument"] as Doc).Statement).map((statement) => (statement.Principal?.AWS as { "Fn::GetAtt"?: [string, string] } | undefined)?.["Fn::GetAtt"]?.[0] ?? statement.Principal);

  it("has a mirror role that only the mirror function's role can assume, whose policy reaches mirror repositories only", () => {
    const mirrorId = roleId(companyImageMirrorRoleName("staging"));
    expect(trustedBy(mirrorId)).toEqual([functionRoleId("CompanyImageMirror")]);
    const statements = policiesOf(mirrorId).flatMap((doc) => doc.Statement);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ Sid: "MirrorRepositoriesOnly", Effect: "Allow", Action: [...COMPANY_IMAGE_MIRROR_ACTIONS] });
    const resource = JSON.stringify(statements[0]!.Resource);
    expect(resource).toContain(`repository/rovara-env/staging/o${"?".repeat(32)}/c${"?".repeat(32)}`);
    // Not a single wildcard that could reach a project's repository, and nothing beside ECR.
    expect(resource).not.toMatch(/\/\*|"\*"|p\?\?/u);
    expect(statements.flatMap((statement) => [statement.Action].flat()).every((action) => String(action).startsWith("ecr:"))).toBe(true);
  });

  it("lets the mirror function assume that role and no other role, and write only the mirror's own state partitions", () => {
    const mirrorId = roleId(companyImageMirrorRoleName("staging"));
    const statements = policiesOf(functionRoleId("CompanyImageMirror")).flatMap((doc) => doc.Statement);
    const assume = statements.filter((statement) => [statement.Action].flat().some((action) => String(action).startsWith("sts:")));
    expect(assume).toHaveLength(1);
    expect([assume[0]!.Resource].flat()).toEqual([{ "Fn::GetAtt": [mirrorId, "Arn"] }]);
    expect(statements.some((statement) => [statement.Action].flat().some((action) => String(action).startsWith("ecr:")))).toBe(false);
    const dynamo = statements.filter((statement) => [statement.Action].flat().some((action) => String(action).startsWith("dynamodb:")));
    expect(dynamo).toHaveLength(1);
    expect(JSON.stringify(dynamo[0]!.Condition)).toContain("COMPANY_IMAGE_MIRROR#*");
    for (const name of [savedEnvPushRoleName("staging"), savedEnvManageRoleName("staging")]) expect(JSON.stringify(assume[0]!.Resource)).not.toContain(roleId(name));
  });

  it("keeps the saved environment push, manage and pull roles the broker's alone", () => {
    const brokerId = functionRoleId("Broker");
    for (const name of [savedEnvPushRoleName("staging"), savedEnvManageRoleName("staging"), savedEnvPullRoleName("staging")]) expect(trustedBy(roleId(name)), name).toEqual([brokerId]);
  });

  it("keeps the broker and the mirror function out of any VPC in every edition, which is what lets the DNS check stand without pinning the connection (a Lambda outside a VPC has no route to a private address of the install)", () => {
    const functions = Object.entries(all).filter(([id, resource]) => resource.Type === "AWS::Lambda::Function" && (id.startsWith("Broker") || id.startsWith("CompanyImageMirrorFunction")));
    expect(functions.map(([id]) => id.replace(/[A-F0-9]{8}$/u, "")).sort()).toEqual(["Broker", "CompanyImageMirrorFunction"]);
    for (const [id, resource] of functions) expect(resource.Properties["VpcConfig"], id).toBeUndefined();
  });

  it("names the mirror role in the creation template's repository policy, and the repository policy still lets no other principal in", () => {
    const creation = Object.values(all).find((resource) => resource.Type === "AWS::ECR::RepositoryCreationTemplate")!;
    const text = JSON.stringify(creation.Properties["RepositoryPolicy"]);
    expect(text).toContain(roleId(companyImageMirrorRoleName("staging")));
    expect(text).toContain(roleId(savedEnvPushRoleName("staging")));
    expect(text).toContain("Deny");
  });
});
