// The installer: the one stack the Launch in AWS button creates. It installs an AgentX environment
// with no terminal: a CodeBuild job runs `rovara init` in the customer's own account, and a setup
// page (a Lambda function behind an HTTP API) asks the questions that need a person, through a
// DynamoDB table both share (packages/cli/src/init/ui/setup-*.ts).
//
// It holds only the installer. Everything the install makes is in its own rovara-cloud-<name>-* stacks,
// so deleting this stack removes the installer and leaves the environment running; `agentx
// destroy` removes the environment.
import {
  CfnOutput, CfnParameter, CustomResource, Duration, Stack, type StackProps,
  aws_codebuild as codebuild,
  aws_iam as iam,
  aws_lambda as lambda,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { CLI_PACKAGE_NAME, ENVIRONMENT_NAME_PATTERN, RESOURCE_PREFIX } from "@agentx/contracts";
import { setupPage } from "./setup-page.js";

/** Starts the installer job on Create and answers CloudFormation; Update and Delete only answer.
 * CloudFormation's own response protocol, written out: a failure to start fails the stack. */
export const START_INSTALLER_CODE = `
const https = require("node:https");
const { CodeBuildClient, StartBuildCommand } = require("@aws-sdk/client-codebuild");
const answer = (event, status, reason) => new Promise((resolve) => {
  const body = JSON.stringify({ Status: status, Reason: reason, PhysicalResourceId: "start-installer", StackId: event.StackId, RequestId: event.RequestId, LogicalResourceId: event.LogicalResourceId });
  const request = https.request(event.ResponseURL, { method: "PUT", headers: { "content-type": "", "content-length": Buffer.byteLength(body) } }, (response) => { response.resume(); response.on("end", resolve); });
  request.on("error", resolve);
  request.end(body);
});
exports.handler = async (event) => {
  try {
    if (event.RequestType === "Create") await new CodeBuildClient({}).send(new StartBuildCommand({ projectName: process.env.PROJECT }));
    await answer(event, "SUCCESS", "ok");
  } catch (error) {
    await answer(event, "FAILED", String(error && error.message || error).slice(0, 200));
  }
};
`;

/** The installer stack's description, the same in the cdk app and the published template. */
export const INSTALLER_DESCRIPTION = "AgentX installer: installs an AgentX environment from its setup page, with no terminal";

/** How long the installer job may run. A step that waits on a person keeps it running. */
export const INSTALLER_TIMEOUT = Duration.hours(8);

export class InstallerStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const installName = new CfnParameter(this, "InstallName", {
      type: "String",
      default: "prod",
      allowedPattern: ENVIRONMENT_NAME_PATTERN.source,
      constraintDescription: "lowercase letters, digits and hyphens, starting with a letter, at most 14 characters",
      description: `A short name for this AgentX install; its stacks are named ${RESOURCE_PREFIX}-<name>-*`,
    });
    const adminEmail = new CfnParameter(this, "AdminEmail", {
      type: "String",
      allowedPattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
      constraintDescription: "an email address",
      description: "Your email: your AgentX admin sign-in, the setup link and alerts go here",
    });
    const githubOwner = new CfnParameter(this, "GitHubOwner", {
      type: "String",
      allowedPattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$",
      constraintDescription: "a GitHub organization or user name",
      description: "The GitHub organization or user that will own AgentX's GitHub App",
    });
    const cliPackage = new CfnParameter(this, "CliPackage", {
      type: "String",
      default: `${CLI_PACKAGE_NAME}@latest`,
      description: "The AgentX CLI the installer runs (an npm package spec); leave as is",
    });

    // The quick-create form: the three answers first, in plain words, the CLI's package last.
    this.templateOptions.metadata = {
      "AWS::CloudFormation::Interface": {
        ParameterGroups: [
          { Label: { default: "Your AgentX install" }, Parameters: [adminEmail.logicalId, githubOwner.logicalId, installName.logicalId] },
          { Label: { default: "Advanced" }, Parameters: [cliPackage.logicalId] },
        ],
        ParameterLabels: {
          [adminEmail.logicalId]: { default: "Your email" },
          [githubOwner.logicalId]: { default: "GitHub owner (organization or user)" },
          [installName.logicalId]: { default: "Install name" },
          [cliPackage.logicalId]: { default: "AgentX CLI package" },
        },
      },
    };

    // The setup page (its table, key, function and HTTP API).
    const { table, url: setupUrl } = setupPage(this, {
      installName: installName.valueAsString,
      apiName: `${RESOURCE_PREFIX}-installer-${installName.valueAsString}`,
      keyDescription: "AgentX installer: the setup table and the admin's sign-in hand-off",
    });

    // The installer job. `rovara init` creates IAM roles (the access stack) and deploys every other
    // stack, as an administrator running it on a computer does: the role is AdministratorAccess,
    // and is deleted with this stack.
    const role = new iam.Role(this, "InstallerRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess")],
      description: "AgentX installer: runs rovara init in this account; deleted with the installer stack",
    });
    const project = new codebuild.Project(this, "InstallerJob", {
      description: "AgentX installer: runs rovara init, asking its questions on the setup page",
      role,
      timeout: INSTALLER_TIMEOUT,
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, computeType: codebuild.ComputeType.SMALL },
      environmentVariables: {
        INSTALL_NAME: { value: installName.valueAsString },
        ADMIN_EMAIL: { value: adminEmail.valueAsString },
        GITHUB_OWNER: { value: githubOwner.valueAsString },
        CLI_PACKAGE: { value: cliPackage.valueAsString },
        SETUP_TABLE: { value: table.tableName },
        SETUP_URL: { value: setupUrl },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: { "runtime-versions": { nodejs: 22 } },
          build: {
            commands: [
              'npx --yes --package "$CLI_PACKAGE" rovara --env "$INSTALL_NAME" init --region "$AWS_REGION" --setup-table "$SETUP_TABLE" --setup-url "$SETUP_URL" --admin-email "$ADMIN_EMAIL" --github-account "$GITHUB_OWNER"',
            ],
          },
        },
      }),
    });
    table.grantReadWriteData(role);

    // The job starts as soon as the stack exists: Create stack is the only thing anyone presses.
    // Its code is inline, so the quick-create template needs no code package for it.
    const starter = new lambda.Function(this, "StartInstallerFunction", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      timeout: Duration.seconds(30),
      code: lambda.Code.fromInline(START_INSTALLER_CODE),
      environment: { PROJECT: project.projectName },
      description: "AgentX installer: starts the installer job when the stack is created",
    });
    starter.addToRolePolicy(new iam.PolicyStatement({ actions: ["codebuild:StartBuild"], resources: [project.projectArn] }));
    new CustomResource(this, "StartInstaller", { serviceToken: starter.functionArn, resourceType: "Custom::StartInstaller" });

    new CfnOutput(this, "SetupPageUrl", {
      value: setupUrl,
      description: "Open this once the email with your temporary password arrives (about five minutes)",
    });
    new CfnOutput(this, "InstallerJobName", { value: project.projectName });
  }
}
