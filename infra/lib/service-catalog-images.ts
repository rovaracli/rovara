// Test services, TS19 (design test-services.md, sections 2.5, 5.3 and 10): the registry side of the image catalog.
//
// For a named environment, ONLY when the stack parameter `TestServicesEnabled` (switch `tx`) is "1", this creates in the control plane's stack:
//   - one ECR repository per catalog repository (`rovara-catalog/<env>/svc/<name>`: postgres 15, 16 and 17 share one) with IMMUTABLE tags, scan on push and KMS encryption with a key of its own (or the customer's, Enterprise:
//     `kmsKeyArn`);
//   - a lifecycle policy: untagged images expire after a day (an image that a manifest list references cannot be expired before the list, so a multi-platform image's platform manifests stay with it), and a count
//     BACKSTOP of tagged images. Tags are the first 32 hex digits of the digest; the catalog pins DIGESTS, so a tag is only a handle and no run ever starts from one.
// With `tx` off every resource is conditional on the switch and none exists: nothing is created, nothing costs anything, and today's flow is untouched. The repositories and the key are RETAINED if the switch is turned off again
// or the stack is deleted (an image a saved environment or a pinned revision still names must stay pullable).
//
// What is deliberately NOT here:
//   - no grant for any role. A worker pulls through the instance role's existing ECR read grant (ec2-workers.ts is untouched), and the operator who runs `scripts/catalog-build.ts` pushes with the operator's own credentials.
//     A push cannot change what a pinned digest means: the catalog names images by digest, the build signs the catalog, and the signature is what a consumer checks;
//   - nothing in the broker's environment (the Lambda environment is at its 4 KB budget).
//
// ENTERPRISE NOTES
//   - With `kmsKeyArn` the repositories are encrypted with the customer's key, which must be in this account and region. CloudFormation's deploy role creates the repository, so the customer's key policy must let that role
//     create the grant ECR uses (kms:CreateGrant, kms:DescribeKey), as for any ECR repository encrypted with a customer key.
//   - An Enterprise install fills these repositories from the signed bundle (the bundle image names are `svc-<id>`, see `catalogBundleImageName` in contracts) or serves the same digests from its own registry; the digest check
//     is `checkCatalogMirror` / `resolveCatalogImage` in contracts.
import { Aws, CfnCondition, CfnResource, Fn, RemovalPolicy, Stack, Token, aws_ecr as ecr, aws_kms as kms, type CfnParameter } from "aws-cdk-lib";
import { Construct } from "constructs";
import { catalogRepositoryName } from "@agentx/contracts";

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

export interface ServiceCatalogImagesProps {
  /** The named environment (`staging`, `prod`). */
  readonly env: string;
  /** The catalog's repositories (`svc/postgres`, ...), from `catalogRepositories(catalog)`. */
  readonly repositories: readonly string[];
  /** The `TestServicesEnabled` parameter (switch `tx`): every resource here exists only when it is "1". */
  readonly testServicesEnabled: CfnParameter;
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
  readonly condition: CfnCondition;

  constructor(scope: Construct, id: string, props: ServiceCatalogImagesProps) {
    super(scope, id);
    const stack = Stack.of(this);
    if (props.repositories.length === 0) throw new Error("service catalog images: the catalog names no repository");
    const names = props.repositories.map((repository) => catalogRepositoryName(props.env, repository));
    if (new Set(names).size !== names.length) throw new Error("service catalog images: a repository is listed once");
    this.condition = new CfnCondition(this, "Enabled", { expression: Fn.conditionEquals(props.testServicesEnabled.valueAsString, "1") });

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
      });
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

    // Everything above exists only while the switch is on.
    for (const child of this.node.findAll()) {
      if (CfnResource.isCfnResource(child)) child.cfnOptions.condition = this.condition;
    }
  }

  /** The ARN of a catalog repository in this install's account and region. */
  static repositoryArn(env: string, repository: string): string {
    return `arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/${catalogRepositoryName(env, repository)}`;
  }
}
