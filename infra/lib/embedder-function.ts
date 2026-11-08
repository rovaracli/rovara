// The self-hosted embedder (lane self-hosted-embeddings; DECISIONS 23 and 27): the Team record's embedding model (Qwen3-Embedding-0.6B, 1,024-d) and the lessons' (bge-small,
// 384-d) in ONE container-image Lambda, on our own compute, in both editions. Part of the Team record switch (`agentxTeamRecord=enabled`): with the switch off, nothing here exists
// and the synthesised templates are what they were (tests/contract/team-record-wiring-infrastructure.test.ts pins that).
//
// The image is built by environments/embedder (weights baked in at build time from pinned Hugging Face revisions, every file checked by sha256; no network at run time) and is named to the
// stack as a private-ECR image PINNED BY DIGEST: the stack parameter `EmbedderImageUri`, default `none`. With `none` the function is not created and the broker's embedding calls fail closed
// (rows are stored without a vector and found by keyword; search falls back to keyword). Public gets the digest from the release job; an Enterprise install loads the image from its signed
// bundle into its own ECR and names that digest (nothing is pulled from a public registry at run time). Neither release path is wired yet: see the lane report.
//
// The function takes {model, kind, texts[]} and returns normalized vectors or a fixed error code (environments/embedder/app/embedder_core.py). Only the broker may invoke it (its role gets
// `lambda:InvokeFunction` on this one function); the function itself can reach no AWS service: its role holds log writes only, and it has no environment variable.
import { ArnFormat, CfnCondition, CfnParameter, Duration, Fn, RemovalPolicy, type Stack, aws_iam as iam, aws_lambda as lambda, aws_logs as logs } from "aws-cdk-lib";
import { embedderFunctionName } from "@agentx/contracts";

/** 6 GB gives about 3.5 vCPUs; the int8 Qwen model measured about 0.14 to 0.26 s per text on a laptop CPU, and the model is 1.1 GB on disk. */
export const EMBEDDER_MEMORY_MB = 6144;
/** A cold start loads the model (seconds); a batch is at most 16 texts. The broker waits far less (EMBEDDER_WAIT_MS), and the function carries on and warms. */
export const EMBEDDER_TIMEOUT_SECONDS = 90;
/** Modest on purpose: a burst of ingest cannot take the account's concurrency. The broker retries the rows it could not embed. */
export const EMBEDDER_RESERVED_CONCURRENCY = 4;

/** A private ECR image reference pinned by digest, or `none`. */
export const EMBEDDER_IMAGE_PATTERN = "^(none|[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com(\\.cn)?/[a-z0-9][a-z0-9._/-]{1,255}@sha256:[a-f0-9]{64})$";

export interface EmbedderProps {
  readonly env: string;
  /** The only principal allowed to invoke the function. */
  readonly broker: lambda.Function;
  /** False where the account's Lambda concurrency quota cannot take a reservation (the agentxReservedConcurrency context). */
  readonly reservedConcurrency?: boolean;
}

export interface EmbedderResources {
  readonly imageUri: CfnParameter;
  readonly hasImage: CfnCondition;
  readonly role: iam.Role;
  readonly logGroup: logs.LogGroup;
  readonly function: lambda.CfnFunction;
}

export function attachEmbedder(stack: Stack, props: EmbedderProps): EmbedderResources {
  const functionName = embedderFunctionName(props.env);
  const imageUri = new CfnParameter(stack, "EmbedderImageUri", {
    type: "String",
    default: "none",
    allowedPattern: EMBEDDER_IMAGE_PATTERN,
    description: "Immutable private ECR linux/arm64 image of the self-hosted embedder (environments/embedder) pinned by digest, or none (no embedder: the Team record stores rows without vectors and searches by keyword)",
  });
  const hasImage = new CfnCondition(stack, "HasEmbedderImage", { expression: Fn.conditionNot(Fn.conditionEquals(imageUri.valueAsString, "none")) });

  const logGroup = new logs.LogGroup(stack, "EmbedderLogs", { logGroupName: `/aws/lambda/${functionName}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
  const role = new iam.Role(stack, "EmbedderRole", {
    assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    description: "The Rovara embedder function: writes its own logs and nothing else",
  });
  logGroup.grantWrite(role);

  const fn = new lambda.CfnFunction(stack, "Embedder", {
    functionName,
    description: "Rovara self-hosted embedder: Qwen3-Embedding-0.6B for the Team record and bge-small for lessons, on CPU, no network",
    packageType: "Image",
    code: { imageUri: imageUri.valueAsString },
    architectures: ["arm64"],
    memorySize: EMBEDDER_MEMORY_MB,
    timeout: Duration.seconds(EMBEDDER_TIMEOUT_SECONDS).toSeconds(),
    role: role.roleArn,
    ...(props.reservedConcurrency === false ? {} : { reservedConcurrentExecutions: EMBEDDER_RESERVED_CONCURRENCY }),
    loggingConfig: { logGroup: logGroup.logGroupName },
  });
  fn.cfnOptions.condition = hasImage;
  fn.node.addDependency(logGroup);
  fn.node.addDependency(role);

  // The broker, and only the broker, calls the function: one action on one function. (The grant exists with or without the image: an invoke of a function that is not there fails closed.)
  props.broker.addToRolePolicy(new iam.PolicyStatement({
    sid: "InvokeEmbedder",
    actions: ["lambda:InvokeFunction"],
    resources: [stack.formatArn({ service: "lambda", resource: "function", resourceName: functionName, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
  }));
  return { imageUri, hasImage, role, logGroup, function: fn };
}
