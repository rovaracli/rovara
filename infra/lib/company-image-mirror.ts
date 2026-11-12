// Company-approved test-service images (switch `pj`), 0.5.15: the mirror function. When a company admin approves an image, the broker starts this function (an asynchronous invoke), and it copies the approved image from its source registry into a private repository of THIS install's own registry, by digest (packages/broker/src/test-env/company-image-mirror.ts). The worker then pulls only from the install's registry, as it does for catalog images, so no worker egress rule changes.
//
// What this adds, and nothing else:
//   - one Lambda function (900 seconds, 1 GB: a copy streams its layers in 8 MiB parts and holds one part at a time) with its own role;
//   - the function's role may write the state table's `COMPANY_IMAGE_MIRROR#*` partitions only (IAM limits a writer by partition key), and assume ONE role: the MIRROR role below. It has no ECR permission of its own, no secret, no bucket and no KMS right;
//   - the MIRROR role (`agentx-<env>-img-cmirror`), trusted by the function's role alone. Its IAM policy covers `repository/rovara-env/<env>/o?{32}/c?{32}` and nothing else: push, read back, the template check, and delete. A project's saved environment repository ends in `p<hash>`, which that
//     pattern never matches, so the function that parses untrusted internet bytes cannot push into or delete any saved environment, whatever its code does. It is NOT the saved environment push or manage role, which reach all of them. The function assumes it with a session policy that names one repository;
//   - the broker may invoke the function (`grantInvoke`).
// The repositories, the creation template, the key and the other roles are the saved environment images' own (saved-env-images.ts); the template's repository policy names this role too. The function reaches the public internet only for the registries the broker's allowlist names (a Lambda outside a VPC).
import { Duration, aws_iam as iam, type aws_dynamodb as dynamodb, type aws_lambda as lambda, type aws_lambda_nodejs as lambdaNodejs } from "aws-cdk-lib";
import { Construct } from "constructs";
import { COMPANY_IMAGE_MIRROR_ACTIONS, companyImageMirrorFunctionName, companyImageMirrorRoleName, companyImageRepositoriesArn } from "@agentx/cloud-contracts";
import { packagedFunction } from "./control-plane.js";

export interface CompanyImageMirrorProps {
  readonly env: string;
  readonly account: string;
  readonly region: string;
  readonly partition: string;
  readonly state: dynamodb.Table;
}

export class CompanyImageMirror extends Construct {
  readonly function: lambdaNodejs.NodejsFunction;
  /** The mirror role: the only role the function assumes, and the only one the template's repository policy lets in beside the push and pull roles. */
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: CompanyImageMirrorProps) {
    super(scope, id);
    this.function = packagedFunction(this, "Function", "packages/broker/src/aws/company-image-mirror-handler.ts", {
      STATE_TABLE_NAME: props.state.tableName,
      AGENTX_ENV: props.env,
      AGENTX_ACCOUNT_ID: props.account,
    }, Duration.seconds(900), [], 1024);
    // A fixed name, so the broker derives it (companyImageMirrorFunctionName) instead of being given the generated one.
    (this.function.node.defaultChild as lambda.CfnFunction).functionName = companyImageMirrorFunctionName(props.env);
    // The mirror's own partitions of the state table, and no other (the sort key cannot be narrowed here, so the partition is the boundary).
    this.function.addToRolePolicy(new iam.PolicyStatement({
      sid: "MirrorStateRows",
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
      resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["COMPANY_IMAGE_MIRROR#*"] } },
    }));
    this.role = new iam.Role(this, "MirrorRole", {
      roleName: companyImageMirrorRoleName(props.env),
      description: "Rovara company images: the mirror function assumes this with a one-repository session policy to copy an approved image into a mirror repository, check it and delete it",
      assumedBy: new iam.ArnPrincipal(this.function.role!.roleArn),
      maxSessionDuration: Duration.seconds(3_600),
    });
    // Mirror repositories only: `o` and `c` followed by exactly 32 characters each (`?`). No project's repository (`p<hash>`) matches. No registry token: the mirror uses the registry API.
    this.role.addToPolicy(new iam.PolicyStatement({
      sid: "MirrorRepositoriesOnly",
      actions: [...COMPANY_IMAGE_MIRROR_ACTIONS],
      resources: [companyImageRepositoriesArn({ partition: props.partition, region: props.region, account: props.account }, props.env)],
    }));
    this.function.addToRolePolicy(new iam.PolicyStatement({ sid: "AssumeTheMirrorRole", actions: ["sts:AssumeRole"], resources: [this.role.roleArn] }));
  }
}
