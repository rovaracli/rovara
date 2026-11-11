import { Aws, CfnCondition, Duration, Fn, aws_iam as iam, aws_lambda as lambda, aws_lambda_nodejs as lambdaNodejs } from "aws-cdk-lib";
import type { CfnParameter, aws_dynamodb as dynamodb, aws_secretsmanager as secretsmanager } from "aws-cdk-lib";
import { resolve } from "node:path";
import { TASK_PERSON_DEVELOPER_RECORD_PROJECTION, TASK_PERSON_PROOF_ENV, taskPersonProofRoleName } from "@agentx/contracts";
import { Construct } from "constructs";
import type { AgentXNaming } from "./naming.js";

// The attributes the dispatcher may read from a developer sign-in row are exactly the ones the person runtime asks for
// (packages/broker/src/aws/task-person-runtime.ts reads TASK_PERSON_DEVELOPER_RECORD_PROJECTION); one list, so they cannot drift.
// (They had: `mergedInto` was asked for and not allowed, so every read of a sign-in row by the dispatcher was refused.)
const DEVELOPER_ATTRIBUTES = [...TASK_PERSON_DEVELOPER_RECORD_PROJECTION];

export interface TaskPersonProofProps {
  readonly naming: AgentXNaming;
  /** TaskPersonProofEnabled: installs the proof on its own (default false). */
  readonly enabled: CfnParameter;
  /** TaskPeopleChangesEnabled: the proof is the person guard's other half, so switching task people on installs it with no second switch. */
  readonly taskPeopleChangesEnabled: CfnParameter;
  readonly slackTeamId: CfnParameter;
  readonly slackSecret: secretsmanager.Secret;
  readonly developerSignInTable: dynamodb.Table;
  readonly dispatcher: lambdaNodejs.NodejsFunction;
}

/**
 * Isolated read-only proof workload, in every named environment. It exists only while TaskPeopleChangesEnabled or TaskPersonProofEnabled is "true"; with both
 * "false" (the default) nothing here is created and the dispatcher has no TASK_PERSON_PROOF_FUNCTION_ARN, which is the behaviour before task people. Every resource
 * is new: an existing stack gets them on the next deploy and no existing resource changes, except the dispatcher's three environment variables, which are empty
 * until a switch is on. The Slack secret is the environment's own (`agentx/<env>/slack`); the function refuses any other.
 */
export class TaskPersonProof extends Construct {
  constructor(scope: Construct, id: string, props: TaskPersonProofProps) {
    super(scope, id);
    const env = props.naming.env;
    if (env === undefined) throw new Error("Task Person proof is for named environments only");
    if (props.dispatcher.role === undefined) throw new Error("the dispatcher has no execution role");

    const install = new CfnCondition(this, "InstallTaskPersonProof", {
      expression: Fn.conditionOr(
        Fn.conditionEquals(props.enabled.valueAsString, "true"),
        Fn.conditionEquals(props.taskPeopleChangesEnabled.valueAsString, "true"),
      ),
    });

    const proofRole = new iam.Role(this, "Role", {
      // The one environment that had this role before it was in every environment keeps its fixed name (renaming would replace a live role); the rest get a
      // generated name under the environment's role path, which the deploy role already covers, so no access stack change is needed.
      ...(env === TASK_PERSON_PROOF_ENV ? { roleName: taskPersonProofRoleName(env) } : {}),
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Reads this environment's Slack secret for fresh task person proof",
    });
    const proofRoleResource = proofRole.node.defaultChild as iam.CfnRole;
    proofRoleResource.cfnOptions.condition = install;

    const proof = new lambdaNodejs.NodejsFunction(this, "Function", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: resolve(process.cwd(), "packages/broker/src/aws/task-person-proof-runtime.ts"),
      handler: "handler",
      role: proofRole,
      timeout: Duration.seconds(7),
      memorySize: 512,
      tracing: lambda.Tracing.DISABLED,
      environment: {
        AGENTX_ENV: env,
        // The account the function runs in: the runtime refuses a secret ARN of any other account or region.
        AGENTX_ACCOUNT_ID: Aws.ACCOUNT_ID,
        SLACK_TEAM_ID: props.slackTeamId.valueAsString,
        SLACK_SECRET_ARN: props.slackSecret.secretArn,
      },
      bundling: {
        externalModules: [],
        minify: true,
        sourceMap: true,
        target: "node22",
      },
    });
    const proofFunctionResource = proof.node.defaultChild as lambda.CfnFunction;
    proofFunctionResource.cfnOptions.condition = install;
    const version = proof.currentVersion;
    const versionResource = version.node.defaultChild as lambda.CfnVersion;
    versionResource.cfnOptions.condition = install;

    const proofSecretPolicy = new iam.CfnPolicy(this, "SecretReadPolicy", {
      policyName: `${env}-task-person-proof-secret-read`,
      roles: [proofRole.roleName],
      policyDocument: {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: ["secretsmanager:GetSecretValue"],
          Resource: [props.slackSecret.secretArn],
        }],
      },
    });
    proofSecretPolicy.cfnOptions.condition = install;

    const developerRead = {
      Effect: "Allow",
      Action: ["dynamodb:GetItem"],
      Resource: [props.developerSignInTable.tableArn],
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": DEVELOPER_ATTRIBUTES },
        Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" },
      },
    };
    const denyUnprojectedDeveloperRead = {
      Sid: "DenyGetItemUnlessSpecificAttributes",
      Effect: "Deny",
      Action: ["dynamodb:GetItem"],
      Resource: [props.developerSignInTable.tableArn],
      Condition: {
        StringNotEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    };
    const invokeProof = {
      Effect: "Allow",
      Action: ["lambda:InvokeFunction"],
      Resource: [version.functionArn],
    };
    const dispatcherPolicy = new iam.CfnPolicy(this, "DispatcherPolicy", {
      policyName: `${env}-task-person-proof-dispatcher`,
      roles: [props.dispatcher.role.roleName],
      policyDocument: { Version: "2012-10-17", Statement: [developerRead, denyUnprojectedDeveloperRead, invokeProof] },
    });
    dispatcherPolicy.cfnOptions.condition = install;

    const whenInstalled = (value: string): string => Fn.conditionIf(install.logicalId, value, "").toString();
    props.dispatcher.addEnvironment("TASK_PERSON_PROOF_FUNCTION_ARN", whenInstalled(version.functionArn));
    props.dispatcher.addEnvironment("SLACK_TEAM_ID", whenInstalled(props.slackTeamId.valueAsString));
    props.dispatcher.addEnvironment("DEVELOPER_SIGNIN_TABLE_NAME", whenInstalled(props.developerSignInTable.tableName));
  }
}
