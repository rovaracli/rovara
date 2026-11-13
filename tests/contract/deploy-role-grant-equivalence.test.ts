// IAM-SIZE-HEADROOM (0.5.18): moving the custom domain's grants out of the deploy role's inline policy into CustomDomainDeployPolicy changed where they live, never what the role may do.
// The fixture is the deploy role's effective grant set, recorded from integ/0518 (cc2966810) before the move with tests/support/deploy-role-grants.ts: every inline policy plus every attached managed policy, as
// IAM receives them for the parameter values below, one (Effect, action, resource, condition) entry per line. The same set must come out of today's template, for both custom-domain cases and with none.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { customDomainDeployPolicyArn, customDomainDeployPolicyName, customDomainStatements, serviceRoleStatements } from "../../infra/lib/access-policies.js";
import { GRANT_ACCOUNT, GRANT_CASES, deployRoleGrants, deployRolePolicies, grantContext, hostedAccessTemplate } from "../support/deploy-role-grants.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const BEFORE = JSON.parse(readFileSync(new URL("../fixtures/deploy-role-grants-integ-0518-cc2966810.json", import.meta.url), "utf8")) as Record<string, string[]>;

describe("the deploy role's effective grants are identical before and after the custom domain's move to CustomDomainDeployPolicy", () => {
  for (const { name, env, parameters } of GRANT_CASES) {
    it(`${name}: the same (Effect, action, resource, condition) set as integ/0518`, () => {
      const before = BEFORE[name]!;
      // Positive control: the fixture holds the grants it is about (the custom domain's when set, none when not).
      expect(before.length).toBeGreaterThan(300);
      expect(before.some((line) => line.includes(" acm:RequestCertificate "))).toBe(parameters.CustomDomainName !== "");
      const json = hostedAccessTemplate(env);
      const after = deployRoleGrants(json, env, parameters);
      expect(after.filter((line) => !before.includes(line)), "granted now, not before").toEqual([]);
      expect(before.filter((line) => !after.includes(line)), "granted before, not now").toEqual([]);
      expect(after).toEqual(before);
      // Where they live now: the custom domain's grants are all in CustomDomainDeployPolicy, none inline.
      const policies = deployRolePolicies(json, grantContext(json, env, parameters));
      const inline = JSON.stringify(policies.filter((policy) => policy.name.startsWith("inline")));
      expect(inline).not.toMatch(/"(acm|route53):/u);
      const domain = policies.find((policy) => policy.name === "CustomDomainDeployPolicy");
      if (parameters.CustomDomainName === "") {
        expect(domain, "no CustomDomainDeployPolicy without a custom domain").toBeUndefined();
        expect(policies.map((policy) => policy.name)).toEqual(["inline deploy"]);
      } else {
        expect(domain!.statements.length).toBe(6);
        expect(JSON.stringify(domain!.statements)).toContain(parameters.CustomDomainHostedZoneId);
      }
    }, 300_000);
  }

  it("the policy exists only under CustomDomainEnabled (both parameters set), is attached to the deploy role alone, and has the exact name and path the export bundle's deployer policy names", () => {
    const json = hostedAccessTemplate("staging");
    const policy = json.Resources.CustomDomainDeployPolicy!;
    expect(policy.Type).toBe("AWS::IAM::ManagedPolicy");
    expect(policy.Condition).toBe("CustomDomainEnabled");
    expect(policy.Properties.Roles).toEqual([{ Ref: "CloudFormationServiceRole" }]);
    expect(policy.Properties.ManagedPolicyName).toBe(customDomainDeployPolicyName("staging"));
    expect(policy.Properties.Path).toBe("/agentx/staging/");
    expect(customDomainDeployPolicyArn({ env: "staging", partition: "aws", account: GRANT_ACCOUNT })).toBe(`arn:aws:iam::${GRANT_ACCOUNT}:policy/agentx/staging/agentx-staging--custom-domain-deploy`);
    // CustomDomainEnabled: both parameters non-empty, as before.
    for (const [domainName, zone, exists] of [["x.example.com", "Z1", true], ["", "", false], ["x.example.com", "", false], ["", "Z1", false]] as const) {
      const context = grantContext(json, "staging", { CustomDomainName: domainName, CustomDomainHostedZoneId: zone });
      expect(deployRolePolicies(json, context).some((entry) => entry.name === "CustomDomainDeployPolicy"), `${domainName}/${zone}`).toBe(exists);
    }
    // The two boundaries and this one: no other managed policy came with it.
    expect(Object.entries(json.Resources).filter(([, resource]) => resource.Type === "AWS::IAM::ManagedPolicy").map(([id]) => id).sort()).toEqual(["CustomDomainDeployPolicy", "DefaultPermissionsBoundary", "DeployRolePermissionsBoundary"]);
  }, 300_000);

  it("customDomainStatements are the statements the inline policy had, Sids included, and serviceRoleStatements no longer adds them", () => {
    const scope = { env: "staging", partition: "aws", region: "us-west-2", account: GRANT_ACCOUNT, artifactBucketArn: "x", pullThroughPrefix: "x", cloudFormationRoleName: "x" };
    const customDomain = { domainName: "staging.rovara.dev", hostedZoneId: "Z08286002FKUL2VBSO3MO" };
    expect(serviceRoleStatements({ ...scope, customDomain })).toEqual(serviceRoleStatements(scope));
    expect(customDomainStatements({ ...scope, customDomain }).map((statement) => statement.Sid)).toEqual(["CustomDomainCertificateRequest", "CustomDomainCertificateTag", "CustomDomainCertificates", "CustomDomainRecords", "CustomDomainZoneReads", "CustomDomainZoneList"]);
    expect(customDomainStatements(scope)).toEqual([]);
    // 0.5.17 review L-2 is kept: never an exportable certificate.
    expect(customDomainStatements({ ...scope, customDomain })[0]!.Condition!.StringEqualsIfExists).toEqual({ "acm:Export": "DISABLED" });
  });
});
