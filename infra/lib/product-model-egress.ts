// TE-F1e (te-f1e.md item 5; forks F1, F6, F9): the ProductModelEgress function's infrastructure, in the control plane of a NAMED environment. What it creates:
//   - the capability key: ECC_NIST_P256, SIGN_VERIFY; its key policy DENIES kms:Sign to every principal but the dispatcher (the InvokeSigningKey pattern); the function reads only its public key (kms:GetPublicKey);
//   - the function's role, with a FIXED name under the environment path (`agentx-<env>-connector-secrets-product-egress`: the shared prefix keeps it under the boundary's existing `connector-secrets*` entries,
//     since the boundary is at its 6,144-character limit). It may: write its own log group; read and write the State table ONLY on keys starting `product-ai` (the meter, F1-d's sources); READ (GetItem only) the
//     operation, workspace and task records of the liveness check (`WORKSPACE#`, `DEVTASK#`); sts:AssumeRole and sts:TagSession on ProductAiSecretsRole only (F1-d's role; F1-d's trust names this role for the
//     `proxy` purpose). It has NO Secrets Manager permission: the tagged session is the only way to a key;
//   - the function: Node.js 22, NOT in the VPC, no Function URL, no resource policy (only the worker role's identity policy and the account's own principals can invoke it), 512 MB (under
//     ASSUMED_LAMBDA_MEMORY_LIMIT_MB), 10 minutes, reserved concurrency PRODUCT_MODEL_EGRESS_RESERVED_CONCURRENCY unless the account cannot take a reservation (the agentxReservedConcurrency context), its own log group.
// The worker role's one statement (lambda:InvokeFunction on this one function ARN) is in infra/lib/ec2-workers.ts; the ARN is built from the fixed function name, so no stack refers to another.
// The function is DARK: until F1-d is merged and bound (packages/broker/src/product-ai/egress-lambda.ts), every call is `not_found`.
import type { aws_dynamodb as dynamodb} from "aws-cdk-lib";
import { Aws, CfnParameter, Duration, RemovalPolicy, type Stack, aws_iam as iam, aws_kms as kms, aws_lambda as lambda, aws_lambda_nodejs as lambdaNodejs, aws_logs as logs } from "aws-cdk-lib";
import { resolve } from "node:path";
import { PRODUCT_MODEL_FUNCTION_TIMEOUT_SECONDS, connectorSecretsRoleName, productModelEgressFunctionName, productModelEgressRoleName } from "@agentx/cloud-contracts";
import { environmentRolePath } from "@rovara-code/contracts";
import { markCodeContractsPureCommand } from "./code-contracts-bundling.js";

/** Well under the account's assumed 3,008 MB (account-limits.ts): the function holds one call's request and streams its answer. */
export const PRODUCT_MODEL_EGRESS_MEMORY_MB = 512;
/** The function's timeout; one call's own deadline (PRODUCT_MODEL_CALL_DEADLINE_MS) is 30 s shorter, so its settle always runs. */
export const PRODUCT_MODEL_EGRESS_TIMEOUT_SECONDS = PRODUCT_MODEL_FUNCTION_TIMEOUT_SECONDS;
/** Fork F9: 4 concurrent calls per task (F1-c's bridge pre-cap) x 5 tasks, against a 1,000 default account quota. 7a confirms the staging quota read-only before the slot (TE-F1E-CONCURRENCY-QUOTA). */
export const PRODUCT_MODEL_EGRESS_RESERVED_CONCURRENCY = 20;

/** F1-d's ProductAiSecretsRole (te-f1d.md fork F2), as agreed: the ARN is built from its fixed name and path. */
export const productAiSecretsRoleNameForEgress = (env: string): string => `${connectorSecretsRoleName(env)}-product-ai`;

/** The State table keys the function may write: its meter only. */
export const PRODUCT_MODEL_EGRESS_WRITE_KEYS = ["product-ai-meter#*"] as const;
/** F1-d's source items (`product-ai#...`): READ only (REVIEW-1 L-5). F1-d's 401/403 warning write needs a key of its own the role may update (TE-F1E-F1D-BIND). */
export const PRODUCT_MODEL_EGRESS_SOURCE_KEYS = ["product-ai#*"] as const;
/** The keys it may only read: the operation, workspace and task pointer (`WORKSPACE#...`) and the task (`DEVTASK#...`). */
export const PRODUCT_MODEL_EGRESS_READ_KEYS = ["WORKSPACE#*", "DEVTASK#*"] as const;
export const PRODUCT_MODEL_EGRESS_WRITE_ACTIONS = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:ConditionCheckItem"] as const;

export interface ProductModelEgressProps {
  readonly env: string;
  readonly state: dynamodb.Table;
  /** The only principal that may sign a capability. */
  readonly dispatcher: lambda.Function;
  /** False where the account's Lambda concurrency quota cannot take a reservation. */
  readonly reservedConcurrency?: boolean;
}

export interface ProductModelEgressResources {
  readonly signingKey: kms.Key;
  readonly role: iam.Role;
  readonly logGroup: logs.LogGroup;
  readonly function: lambdaNodejs.NodejsFunction;
}

export function attachProductModelEgress(stack: Stack, props: ProductModelEgressProps): ProductModelEgressResources {
  const functionName = productModelEgressFunctionName(props.env);
  const signingKey = new kms.Key(stack, "ProductModelEgressSigningKey", {
    description: `Signs Rovara ${props.env} product model egress capabilities`,
    keySpec: kms.KeySpec.ECC_NIST_P256,
    keyUsage: kms.KeyUsage.SIGN_VERIFY,
    pendingWindow: Duration.days(7),
    // A capability lives at most one day and the function reads the public key at each cold start: nothing outlives the key.
    removalPolicy: RemovalPolicy.DESTROY,
  });
  signingKey.grant(props.dispatcher, "kms:Sign");
  signingKey.addToResourcePolicy(new iam.PolicyStatement({
    sid: "SignOnlyAsDispatcher",
    effect: iam.Effect.DENY,
    principals: [new iam.AnyPrincipal()],
    actions: ["kms:Sign"],
    resources: ["*"],
    conditions: { ArnNotEquals: { "aws:PrincipalArn": props.dispatcher.role!.roleArn } },
  }));

  const logGroup = new logs.LogGroup(stack, "ProductModelEgressLogs", { logGroupName: `/aws/lambda/${functionName}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
  const role = new iam.Role(stack, "ProductModelEgressRole", {
    roleName: productModelEgressRoleName(props.env),
    assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } } }),
    description: "Rovara product model egress function: its meter and source keys in State, read-only operation records, the tagged product key session, its own logs",
  });
  logGroup.grantWrite(role);
  role.addToPolicy(new iam.PolicyStatement({
    sid: "ProductAiMeterInState",
    actions: [...PRODUCT_MODEL_EGRESS_WRITE_ACTIONS],
    resources: [props.state.tableArn],
    // ForAllValues passes when the key is absent; the Null check makes an absent LeadingKeys fail closed.
    conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [...PRODUCT_MODEL_EGRESS_WRITE_KEYS] }, Null: { "dynamodb:LeadingKeys": "false" } },
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: "ReadProductAiSources",
    actions: ["dynamodb:GetItem", "dynamodb:Query"],
    resources: [props.state.tableArn],
    conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [...PRODUCT_MODEL_EGRESS_SOURCE_KEYS] }, Null: { "dynamodb:LeadingKeys": "false" } },
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: "ReadOperationRecords",
    actions: ["dynamodb:GetItem"],
    resources: [props.state.tableArn],
    conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [...PRODUCT_MODEL_EGRESS_READ_KEYS] }, Null: { "dynamodb:LeadingKeys": "false" } },
  }));
  role.addToPolicy(new iam.PolicyStatement({
    sid: "AssumeProductAiSecretsRole",
    actions: ["sts:AssumeRole", "sts:TagSession"],
    resources: [`arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role${environmentRolePath(props.env)}${productAiSecretsRoleNameForEgress(props.env)}`],
  }));
  role.addToPolicy(new iam.PolicyStatement({ sid: "ReadCapabilityPublicKey", actions: ["kms:GetPublicKey"], resources: [signingKey.keyArn] }));

  const fn = new lambdaNodejs.NodejsFunction(stack, "ProductModelEgress", {
    functionName,
    description: "Rovara product model egress: holds a customer's product AI key for one test call, outside the VPC",
    runtime: lambda.Runtime.NODEJS_22_X,
    entry: resolve(process.cwd(), "packages/broker/src/product-ai/egress-lambda.ts"),
    handler: "handler",
    timeout: Duration.seconds(PRODUCT_MODEL_EGRESS_TIMEOUT_SECONDS),
    memorySize: PRODUCT_MODEL_EGRESS_MEMORY_MB,
    ...(props.reservedConcurrency === false ? {} : {
      // A parameter (default 20), so an account that cannot take 20 lowers it at deploy without a code change; the install preflight (packages/cli/src/deploy/product-model-concurrency-preflight.ts)
      // refuses a reservation that would leave under Lambda's unreserved floor of 100.
      reservedConcurrentExecutions: new CfnParameter(stack, "ProductModelEgressReservedConcurrency", {
        type: "Number", default: PRODUCT_MODEL_EGRESS_RESERVED_CONCURRENCY, minValue: 1, maxValue: 1000,
        description: "Reserved concurrency of the product model egress function (default 20: 4 calls per task x 5 tasks). Lower it on an account whose Lambda concurrency quota is small",
      }).valueAsNumber,
    }),
    role,
    logGroup,
    environment: {
      STATE_TABLE_NAME: props.state.tableName,
      PRODUCT_MODEL_EGRESS_KEY_ARN: signingKey.keyArn,
      AGENTX_ENV: props.env,
      AGENTX_ACCOUNT_ID: Aws.ACCOUNT_ID,
    },
    bundling: { externalModules: [], minify: true, sourceMap: true, target: "node22", commandHooks: { beforeBundling: (inputDir: string) => [markCodeContractsPureCommand(inputDir)], afterBundling: () => [], beforeInstall: () => [] } },
  });
  // The dispatcher signs capabilities and names this function in a task's model plan (the broker send, its own commit; not read while unwired).
  props.dispatcher.addEnvironment("PRODUCT_MODEL_EGRESS_SIGNING_KEY_ARN", signingKey.keyArn);
  return { signingKey, role, logGroup, function: fn };
}
