// Test services, TS19 (design test-services.md, sections 2.5, 5.3 and 10): the registry side of the image catalog.
//
// For a named environment this creates in the control plane's stack:
//   - one ECR repository per catalog repository (`rovara-catalog/<env>/svc/<name>`: postgres 15, 16 and 17 share one) with IMMUTABLE tags, scan on push and KMS encryption with a key of its own (or the customer's, Enterprise:
//     `kmsKeyArn`);
//   - a lifecycle policy: untagged images expire after a day (an image that a manifest list references cannot be expired before the list, so a multi-platform image's platform manifests stay with it), and a count
//     BACKSTOP of tagged images. Tags are the first 32 hex digits of the digest; the catalog pins DIGESTS, so a tag is only a handle and no run ever starts from one.
//
// These resources are UNCONDITIONAL: they do not depend on the `TestServicesEnabled` switch (`tx`). The repositories have fixed names and are RETAINED, so a condition would break the deploy when the switch goes on,
// off and on again (the retained repository still exists, and CloudFormation cannot create a second one of that name) and would orphan a retained KMS key at every re-enable. An empty repository is inert and costs
// nothing; the key costs its monthly fee. Everything that USES them (the build's pushes, the worker's pulls, the helper launcher) stays behind the switch in the tasks that wire it. The repositories and the key are
// RETAINED if the stack is deleted (an image a saved environment or a pinned revision still names must stay pullable).
//
// What is deliberately NOT here:
//   - no grant for any role. A worker on a NAMED environment has NO pull grant on these repositories today: ec2-workers.ts gives the ECR read grant to the legacy role only, and worker-settings.ts grants one repository.
//     The grant is deferred to the wiring task (the worker's start or the service runner, TS17): `ecr:BatchGetImage` and `ecr:GetDownloadUrlForLayer` on `repository/rovara-catalog/<env>/svc/*`, plus the key if it is
//     the customer's. The operator who runs `scripts/catalog-build.ts` pushes with the operator's own credentials. A push cannot change what a pinned digest means: the catalog names images by digest, the build signs
//     the catalog, and the signature is what a consumer checks;
//   - nothing in the broker's environment (the Lambda environment is at its 4 KB budget).
//
// ENTERPRISE NOTES
//   - With `kmsKeyArn` the repositories are encrypted with the customer's key, which must be in this account and region. CloudFormation's deploy role creates the repository, so the customer's key policy must let that role
//     create the grant ECR uses (kms:CreateGrant, kms:DescribeKey), as for any ECR repository encrypted with a customer key.
//   - An Enterprise install fills these repositories from the signed bundle (the bundle image names are `svc-<id>`, see `catalogBundleImageName` in contracts) or serves the same digests from its own registry; the digest check
//     is `checkCatalogMirror` / `resolveCatalogImage` in contracts. ANY path that fills a repository from the bundle MUST TAG each image (the tag is the first 32 hex digits of its digest, as the build tags it): the lifecycle
//     policy expires UNTAGGED images after one day, and an image pushed by digest alone would vanish.
import { Aws, RemovalPolicy, Stack, Token, aws_ecr as ecr, aws_iam as iam, aws_kms as kms } from "aws-cdk-lib";
import { Construct } from "constructs";
import { catalogRepositoryName } from "@rovara-code/contracts";

/** The metadata `retention.ts` reads: the resource stays plain `Retain` where the aspect would make it `RetainExceptOnCreate`. */
const KEEP_ON_ROLLBACK_METADATA = "agentx:retain-on-create-rollback";

/** Tagged images kept per repository beyond which the oldest expire. Large on purpose: a retired digest may still be pinned by a saved environment or an older revision. */
export const SERVICE_CATALOG_KEEP_TAGGED = 60;
export const SERVICE_CATALOG_UNTAGGED_DAYS = 1;

/** The lifecycle policy every catalog repository gets. */
export function serviceCatalogLifecyclePolicy(): { rules: Array<Record<string, unknown>> } {
  return {
    rules: [
      { rulePriority: 1, description: "Untagged images expire", selection: { tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: SERVICE_CATALOG_UNTAGGED_DAYS }, action: { type: "expire" } },
      { rulePriority: 2, description: `Backstop: keep at most ${String(SERVICE_CATALOG_KEEP_TAGGED)} tagged images`, selection: { tagStatus: "tagged", tagPatternList: ["*"], countType: "imageCountMoreThan", countNumber: SERVICE_CATALOG_KEEP_TAGGED }, action: { type: "expire" } },
    ],
  };
}

/**
 * The key policy: administration WITHOUT use, and use only through ECR. As the saved environment images key (saved-env-images.ts): the account root may administer the key but is given no Decrypt, Encrypt or
 * GenerateDataKey, and `kms:CreateAlias` stands in for `kms:Create*` (which would include kms:CreateGrant); an IAM principal of the account (the deploy role that creates the repositories, through its own
 * `kms:*`) may create the grant ECR uses only when the call comes through ECR (`kms:ViaService`) and the grant is for an AWS resource (`kms:GrantIsForAWSResource`), and may describe the key only through ECR.
 * Nobody can use the key directly. Nobody can schedule its deletion either (as the saved environment images key): the key is therefore marked to keep it when a first create rolls back (see the metadata below).
 */
export function serviceCatalogKeyPolicy(): iam.PolicyDocument {
  return new iam.PolicyDocument({
    statements: [
      new iam.PolicyStatement({
        sid: "AdminWithoutUse",
        principals: [new iam.AccountRootPrincipal()],
        actions: ["kms:CreateAlias", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Get*", "kms:TagResource", "kms:UntagResource", "kms:CancelKeyDeletion"],
        resources: ["*"],
      }),
      // Two statements, not one: kms:GrantIsForAWSResource is a condition key of the grant actions only (CreateGrant, ListGrants, RevokeGrant); a DescribeKey request does not carry it, so a Bool condition on it
      // would never match DescribeKey. Each action gets exactly the conditions that apply to it: both go through ECR only, and the grant is for an AWS resource.
      new iam.PolicyStatement({
        sid: "GrantOnlyThroughEcr",
        principals: [new iam.AccountRootPrincipal()],
        actions: ["kms:CreateGrant"],
        resources: ["*"],
        conditions: { StringEquals: { "kms:ViaService": `ecr.${Aws.REGION}.amazonaws.com` }, Bool: { "kms:GrantIsForAWSResource": "true" } },
      }),
      new iam.PolicyStatement({
        sid: "DescribeOnlyThroughEcr",
        principals: [new iam.AccountRootPrincipal()],
        actions: ["kms:DescribeKey"],
        resources: ["*"],
        conditions: { StringEquals: { "kms:ViaService": `ecr.${Aws.REGION}.amazonaws.com` } },
      }),
    ],
  });
}

export interface ServiceCatalogImagesProps {
  /** The named environment (`staging`, `prod`). */
  readonly env: string;
  /** The catalog's repositories (`svc/postgres`, ...), from `catalogRepositories(catalog)`. */
  readonly repositories: readonly string[];
  /** Enterprise: the customer's own key, in this account and region. Absent: this construct makes the key. */
  readonly kmsKeyArn?: string;
}

/** Called by the control plane for a named environment. */
export function attachServiceCatalogImages(scope: Construct, props: ServiceCatalogImagesProps): ServiceCatalogImages {
  return new ServiceCatalogImages(scope, "ServiceCatalogImages", props);
}

export class ServiceCatalogImages extends Construct {
  readonly repositories: ecr.CfnRepository[] = [];
  readonly key: kms.Key | undefined;

  constructor(scope: Construct, id: string, props: ServiceCatalogImagesProps) {
    super(scope, id);
    const stack = Stack.of(this);
    if (props.repositories.length === 0) throw new Error("service catalog images: the catalog names no repository");
    const names = props.repositories.map((repository) => catalogRepositoryName(props.env, repository));
    if (new Set(names).size !== names.length) throw new Error("service catalog images: a repository is listed once");

    let kmsKey: string;
    if (props.kmsKeyArn !== undefined) {
      const parsed = /^arn:aws[a-z-]*:kms:([a-z0-9-]+):(\d{12}):key\/[0-9a-f-]{36}$/u.exec(props.kmsKeyArn);
      if (parsed === null) throw new Error("service catalog images: kmsKeyArn must be a KMS key ARN (not an alias)");
      if ((!Token.isUnresolved(stack.region) && parsed[1] !== stack.region) || (!Token.isUnresolved(stack.account) && parsed[2] !== stack.account)) throw new Error("service catalog images: kmsKeyArn must be a key in this install's own account and region");
      this.key = undefined;
      kmsKey = props.kmsKeyArn;
    } else {
      this.key = new kms.Key(this, "ImagesKey", {
        description: "Rovara test service catalog images: encrypts the catalog repositories",
        enableKeyRotation: true,
        removalPolicy: RemovalPolicy.RETAIN,
        policy: serviceCatalogKeyPolicy(),
      });
      // The key policy lets nobody schedule a deletion, so a rolled-back first create could not delete the key and the stack would be stuck in ROLLBACK_FAILED: keep it (the audit ledger vault key, the saved
      // environment images key and the Slack action key do the same). The repositories are empty on a first create and stay RetainExceptOnCreate, so a retry can create them again.
      (this.key.node.defaultChild as kms.CfnKey).addMetadata(KEEP_ON_ROLLBACK_METADATA, true);
      kmsKey = this.key.keyArn;
    }

    const lifecyclePolicyText = JSON.stringify(serviceCatalogLifecyclePolicy());
    for (const repository of props.repositories) {
      const repositoryName = catalogRepositoryName(props.env, repository);
      const logicalSuffix = repository.replace(/[^A-Za-z0-9]/gu, "");
      const created = new ecr.CfnRepository(this, `Repository${logicalSuffix}`, {
        repositoryName,
        imageTagMutability: "IMMUTABLE",
        imageScanningConfiguration: { scanOnPush: true },
        encryptionConfiguration: { encryptionType: "KMS", kmsKey },
        lifecyclePolicy: { lifecyclePolicyText },
        tags: [{ key: "agentx:env", value: props.env }, { key: "rovara:purpose", value: "service-catalog-image" }],
      });
      created.applyRemovalPolicy(RemovalPolicy.RETAIN);
      this.repositories.push(created);
    }
  }

  /** The ARN of a catalog repository in this install's account and region. */
  static repositoryArn(env: string, repository: string): string {
    return `arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/${catalogRepositoryName(env, repository)}`;
  }
}
