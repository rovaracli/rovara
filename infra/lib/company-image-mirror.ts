// Company-approved test-service images (switch `pj`), 0.5.15: the mirror function. When a company admin approves an image, the broker starts this function (an asynchronous invoke), and it copies the approved image from its
// source registry into a private repository of THIS install's own registry, by digest (packages/broker/src/test-env/company-image-mirror.ts). The worker then pulls only from the install's registry, as it does for catalog
// images, so no worker egress rule changes.
//
// What this adds, and nothing else:
//   - one Lambda function (900 seconds, 1 GB: a copy streams its layers in 8 MiB parts and holds one part at a time) with its own role;
//   - the role may write the state table's `COMPANY_IMAGE_MIRROR#*` partitions only (IAM limits a writer by partition key), and assume the saved-environment PUSH and MANAGE roles (it pushes and verifies through sessions whose policy names
//     ONE repository, as the broker does); it has no ECR permission of its own, no secret, no bucket and no KMS right (the repository's key is used by ECR on its behalf, through the creation template's role);
//   - the push and manage roles trust this function's role too (saved-env-images.ts `extraAssumers`), and the broker may invoke the function (`grantInvoke`).
// The repositories, the creation template, the key and the three roles are the saved environment images' own (saved-env-images.ts): a mirror repository is `rovara-env/<env>/o<org hash>/p<image hash>`, so the template's
// immutable tags, KMS encryption and repository policy apply to it, and the policy keeps every principal but the roles from reading or writing it. The function reaches the public internet only for the registries the
// broker's allowlist names (a Lambda outside a VPC; the broker's own digest lookup already makes the same kind of call).
import { Duration, aws_iam as iam, type aws_dynamodb as dynamodb, type aws_lambda_nodejs as lambdaNodejs } from "aws-cdk-lib";
import { Construct } from "constructs";
import { packagedFunction } from "./control-plane.js";

export interface CompanyImageMirrorProps {
  readonly env: string;
  readonly account: string;
  readonly state: dynamodb.Table;
}

export class CompanyImageMirror extends Construct {
  readonly function: lambdaNodejs.NodejsFunction;
  /** The function's role as a principal, for the push and manage roles' trust (created before them, so the trust can name it). */
  readonly principal: iam.IPrincipal;

  constructor(scope: Construct, id: string, props: CompanyImageMirrorProps) {
    super(scope, id);
    this.function = packagedFunction(this, "Function", "packages/broker/src/aws/company-image-mirror-handler.ts", {
      STATE_TABLE_NAME: props.state.tableName,
      AGENTX_ENV: props.env,
      AGENTX_ACCOUNT_ID: props.account,
    }, Duration.seconds(900), [], 1024);
    this.principal = new iam.ArnPrincipal(this.function.role!.roleArn);
    // The mirror's own partitions of the state table, and no other (the sort key cannot be narrowed here, so the partition is the boundary).
    this.function.addToRolePolicy(new iam.PolicyStatement({
      sid: "MirrorStateRows",
      actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
      resources: [props.state.tableArn],
      conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["COMPANY_IMAGE_MIRROR#*"] } },
    }));
  }

  /** The push and manage roles, once they exist: the function may assume exactly those two. */
  allowAssume(roles: readonly iam.IRole[]): void {
    this.function.addToRolePolicy(new iam.PolicyStatement({ sid: "AssumeTheImageRoles", actions: ["sts:AssumeRole"], resources: roles.map((role) => role.roleArn) }));
  }
}
