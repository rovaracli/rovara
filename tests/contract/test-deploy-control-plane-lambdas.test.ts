import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { CONTROL_PLANE_LAMBDAS, CONTROL_PLANE_LAMBDAS_NOT_DEPLOYED, assertCheckAllowsApply, type CfnTemplate } from "../../scripts/test-deploy.js";
import { evaluateEnvironmentDrift, evaluateIamDrift, evaluateTestDeployCheck, findingLabel, lambdaRoleIds } from "../../scripts/test-deploy-check.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type Resource = { Type: string; Properties?: { Code?: { ZipFile?: unknown; S3Bucket?: unknown } } };

/** The real TEST installation's control-plane stack template, as head synthesizes it. */
function controlPlaneTemplate(context: Record<string, unknown> = { "agentx:e2eQualificationTransport": "enabled" }): CfnTemplate {
  const env = "agentxlivetest123";
  // By default as TEST runs it: the standing qualification transport is lifted into the live stack, so it is synthesized here too.
  const stack = buildAgentXApp({ agentxEnv: env, ...context }).node.children
    .filter((child): child is Stack => Stack.isStack(child))
    .find((candidate) => candidate.stackName === `agentx-${env}-control-plane`);
  if (stack === undefined) throw new Error(`expected the real ${env} control-plane stack`);
  return Template.fromStack(stack).toJSON();
}

/** Every Lambda of the real TEST installation's control-plane stack that runs code built from this repository. */
function repoBuiltLambdas(context?: Record<string, unknown>): string[] {
  const resources = controlPlaneTemplate(context).Resources as Record<string, Resource>;
  return Object.entries(resources)
    // Inline code (ZipFile) is CDK's own helper, not repo code; a repo-built function reads an asset from S3.
    .filter(([, resource]) => resource.Type === "AWS::Lambda::Function" && resource.Properties?.Code?.ZipFile === undefined)
    .map(([logicalId]) => logicalId)
    .sort();
}

describe("test-deploy's control-plane code units", () => {
  it("equal the repo-built Lambdas of the synthesized control-plane template, so a new Lambda is never left behind", () => {
    const deployable = Object.values(CONTROL_PLANE_LAMBDAS).map((lambda) => lambda.logicalId);
    const named = [...deployable, ...Object.keys(CONTROL_PLANE_LAMBDAS_NOT_DEPLOYED)].sort();
    expect(repoBuiltLambdas()).toEqual(named);
    expect(new Set(deployable).size).toBe(deployable.length);
  });

  it("also holds with the standing qualification transport on, as TEST runs it, and without it", () => {
    expect(repoBuiltLambdas({})).toEqual(repoBuiltLambdas({ "agentx:e2eQualificationTransport": "enabled" }));
  });

  it("leaves out only a function a code-only change set cannot move or that is not a TEST unit, with the reason", () => {
    // The proof function is invoked through a published version: new code in the function would not change what runs.
    // The others are Rovara Cloud's own functions (round 4 merge), shipped with a CDK deploy.
    const cloud = ["AuditLedgerAuditAnchorA02AF164", "AuditLedgerAuditAppender4120E8F4", "AuditLedgerAuditExportED90D71C", "ModelAccessFunction1B50ECC9", "RealtimeAuthorizer74F9F06D"];
    // The web app's page function and CDK's BucketDeployment handler (its asset upload): the page function serves a directory of hashed assets the upload puts in a bucket.
    const web = ["WebAppFunction611CC907", "CustomCDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C81C01536"];
    // The company image mirror (0.5.15, switch pj): invoked by the broker when an admin approves an image; shipped with a CDK deploy.
    const mirror = "CompanyImageMirrorFunctionA216CF6B";
    expect(Object.keys(CONTROL_PLANE_LAMBDAS_NOT_DEPLOYED)).toEqual(["TaskPersonProofFunction817A5A36", ...cloud, mirror, ...web]);
    expect(CONTROL_PLANE_LAMBDAS_NOT_DEPLOYED[mirror]).toMatch(/CDK deploy/);
    for (const logicalId of web) expect(CONTROL_PLANE_LAMBDAS_NOT_DEPLOYED[logicalId]).toMatch(/CDK deploy/);
    expect(CONTROL_PLANE_LAMBDAS_NOT_DEPLOYED["TaskPersonProofFunction817A5A36"]).toMatch(/version/i);
    for (const logicalId of cloud) expect(CONTROL_PLANE_LAMBDAS_NOT_DEPLOYED[logicalId]).toMatch(/Rovara Cloud function.*CDK deploy/);
  });
});

describe("test-deploy --check on the synthesized control-plane template", () => {
  const head = controlPlaneTemplate();
  const clone = (): CfnTemplate => JSON.parse(JSON.stringify(head)) as CfnTemplate;

  it("finds a role and an IAM policy for every control-plane Lambda test-deploy moves, so no drift can hide", () => {
    const roles = lambdaRoleIds(head);
    for (const { logicalId } of Object.values(CONTROL_PLANE_LAMBDAS)) {
      const role = roles[logicalId];
      expect(role, logicalId).toBeDefined();
      const policies = Object.values(head.Resources ?? {}).filter((resource) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties?.Roles).includes(`"${role}"`));
      expect(policies.length, `${logicalId} runs as ${role}`).toBeGreaterThan(0);
    }
  });

  it("agrees with itself: head against head has no finding, whatever order its statements come in", () => {
    const reordered = clone();
    for (const resource of Object.values(reordered.Resources ?? {})) {
      const document = resource.Type === "AWS::IAM::Policy" ? (resource.Properties?.PolicyDocument as { Statement: unknown[] }) : undefined;
      document?.Statement.reverse();
    }
    expect(evaluateIamDrift(head, reordered)).toEqual([]);
    const codes = Object.fromEntries(Object.values(CONTROL_PLANE_LAMBDAS).map(({ logicalId }) => [logicalId, "sha"]));
    const result = evaluateTestDeployCheck({
      headTemplate: head, deployedTemplate: reordered, lambdaCodeShas: codes, builtZipShas: codes,
      catalogRows: ["web", "api"].map((kind) => ({ sk: `PROFILE#linux-arm64-web-api-v1#${kind}`, state: "READY", expiresAt: "2030-01-01T00:00:00.000Z" })),
      runnerFacts: undefined, now: new Date("2026-10-20T00:00:00.000Z"),
    });
    // Only the runner is unknown; IAM and code are clean.
    expect(result.findings.map((finding) => finding.kind)).toEqual(["runner-image-mismatch", "worker-feature-missing"]);
  });

  it("refuses an apply of a unit whose role the deployed stack gave one grant fewer than head", () => {
    const deployed = clone();
    const sessionsPolicy = deployed.Resources?.SessionsStepsServiceRoleDefaultPolicy9F4B87C9;
    expect(sessionsPolicy?.Type).toBe("AWS::IAM::Policy");
    const statements = (sessionsPolicy?.Properties?.PolicyDocument as { Statement: Array<{ Action: unknown; Resource: unknown }> }).Statement;
    const parameters = statements.find((statement) => statement.Action === "ssm:GetParameters" && Array.isArray(statement.Resource));
    expect(parameters, "SessionsSteps reads the worker settings with ssm:GetParameters").toBeDefined();
    (parameters?.Resource as unknown[]).pop();
    const findings = evaluateIamDrift(head, deployed);
    expect(findings.map((finding) => [finding.kind, finding.policyLogicalId, findingLabel(finding.roleLogicalId ?? "")])).toEqual([["iam-missing-grant", "SessionsStepsServiceRoleDefaultPolicy9F4B87C9", "SessionsSteps"]]);
    expect(() => assertCheckAllowsApply(findings, ["control-plane-code"], head)).toThrow("deploy check failed: iam-missing-grant SessionsSteps (needs Tier 3 approval)");
    expect(() => assertCheckAllowsApply(findings, ["broker"], head)).not.toThrow();
  });

  it("sees the notifier's WORKFLOW_DISPATCH read grant (LIVEFIX-1) as an IAM gap: control-plane-code (the only unit that moves the notifier) refuses until the stack is updated", () => {
    const deployed = clone();
    const holders = Object.entries(deployed.Resources ?? {}).filter(([, resource]) => resource.Type === "AWS::IAM::Policy" && JSON.stringify(resource.Properties).includes("WORKFLOW_DISPATCH"));
    // Only the notifier's own policy names the key: no other Lambda was given it.
    expect(holders.map(([logicalId]) => logicalId)).toEqual([expect.stringContaining("DeveloperTaskNotifier")]);
    const document = holders[0]![1].Properties?.PolicyDocument as { Statement: Array<Record<string, unknown>> };
    document.Statement = document.Statement.filter((statement) => !JSON.stringify(statement).includes("WORKFLOW_DISPATCH"));
    const findings = evaluateIamDrift(head, deployed);
    expect(findings.map((finding) => [finding.kind, findingLabel(finding.roleLogicalId ?? "")])).toEqual([["iam-missing-grant", expect.stringContaining("DeveloperTaskNotifier")]]);
    expect(JSON.stringify(findings[0]?.statements)).toContain("WORKFLOW_DISPATCH");
    expect(() => assertCheckAllowsApply(findings, ["control-plane-code"], head)).toThrow(/iam-missing-grant .*needs Tier 3 approval/);
    expect(() => assertCheckAllowsApply(findings, ["broker"], head)).not.toThrow();
  });

  it("refuses a code-only apply of the Dispatcher when the deployed function lacks one of head's environment variables", () => {
    const deployed = clone();
    const variables = (deployed.Resources?.DispatcherD4A12972?.Properties?.Environment as { Variables: Record<string, unknown> }).Variables;
    const [name] = Object.keys(variables);
    expect(name, "the Dispatcher has environment variables").toBeDefined();
    delete variables[name ?? ""];
    expect(evaluateEnvironmentDrift(head, head)).toEqual([]);
    const findings = evaluateEnvironmentDrift(head, deployed);
    expect(findings.map((finding) => [finding.kind, finding.subject, finding.missing])).toEqual([["lambda-env-missing", "DispatcherD4A12972", [name]]]);
    expect(() => assertCheckAllowsApply(findings, ["dispatcher"], head)).toThrow(/lambda-env-missing Dispatcher \(needs a control-plane stack update/);
    expect(() => assertCheckAllowsApply(findings, ["broker"], head)).not.toThrow();
  });
});
