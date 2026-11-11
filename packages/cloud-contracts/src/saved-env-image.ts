// Cloud's own text of the saved environment image names that differ from Rovara Code's (convergence W0-3, r8): a company-approved image's mirror repository (rovara-env/<env>/o<org>/c<image>) is accepted beside a saved environment's, and the repository policy knows the mirror's role. Owed upstream: see owed-upstream.json.
import { z } from "zod";
import { ImageDigestSchema, SAVED_ENV_MANAGE_ACTIONS, SAVED_ENV_PULL_ACTIONS, SAVED_ENV_PUSH_ACTIONS, isSavedEnvRepositoryName, savedEnvRepositoryPrefix, type SavedEnvAccountScope, type SessionPolicyJson } from "@rovara-code/contracts";


const EnvName = z.string().regex(/^[a-z][a-z0-9-]{0,19}$/u, "an environment name");

/**
 * A company-approved image's mirror repository has the SAME prefix and org segment as a saved environment's, and its own last segment: `rovara-env/<env>/o<org hash>/c<image hash>` (company-image-mirror.ts). The two shapes
 * are told apart by IAM: the mirror's own role reaches `o?{32}/c?{32}` only, and a project repository's `p<hex>` segment never matches a `/c`.
 */
const COMPANY_IMAGE_REPOSITORY_NAME = /^rovara-env\/[a-z][a-z0-9-]{0,19}\/o[a-f0-9]{32}\/c[a-f0-9]{32}$/u;
export function isCompanyImageRepositoryName(name: string): boolean {
  return COMPANY_IMAGE_REPOSITORY_NAME.test(name);
}
/** The IAM resource pattern of every mirror repository of an environment (`?` is exactly one character, so the two hashes are exactly 32 characters and nothing can sit between them). */
export function companyImageRepositoriesArn(scope: SavedEnvAccountScope, env: string): string {
  return `arn:${scope.partition}:ecr:${scope.region}:${scope.account}:repository/${savedEnvRepositoryPrefix(env)}/o${"?".repeat(32)}/c${"?".repeat(32)}`;
}
/**
 * The role the company image mirror function assumes: push, read back and delete on mirror repositories (`o?/c?`) and nothing else. It is NOT the push or manage role: those reach every saved environment's repositories.
 * Named `img-` like the other image roles, so the deploy boundary names all of them with the one `img-*` ARN (fixedNameRoleLookupStatement) and the boundary does not grow.
 */
export const companyImageMirrorRoleName = (env: string): string => `agentx-${EnvName.parse(env)}-img-mirror`;

/** The ARN of one repository (or of `rovara-env/<env>/*` when given the prefix and a `*`). Refuses anything but a name this module makes, so a `*`, a `?` or a policy variable cannot get in. */
export function savedEnvRepositoryArn(scope: SavedEnvAccountScope, repositoryName: string): string {
  if (!isSavedEnvRepositoryName(repositoryName) && !isCompanyImageRepositoryName(repositoryName)) throw new Error("not a saved environment or company image repository name");
  return `arn:${scope.partition}:ecr:${scope.region}:${scope.account}:repository/${repositoryName}`;
}
/** Registry-wide: ECR cannot scope the token call to a repository. What the token may DO is set by the session policy below. */
const TOKEN_ACTION = "ecr:GetAuthorizationToken";

function sessionPolicy(scope: SavedEnvAccountScope, repositoryName: string, actions: readonly string[], tokenSid: string, sid: string, withToken: boolean): SessionPolicyJson {
  const statement: Array<Record<string, unknown>> = [];
  if (withToken) statement.push({ Sid: tokenSid, Effect: "Allow", Action: TOKEN_ACTION, Resource: "*" });
  statement.push({ Sid: sid, Effect: "Allow", Action: [...actions], Resource: savedEnvRepositoryArn(scope, repositoryName) });
  return { Version: "2012-10-17", Statement: statement };
}

/** What a push session may do: get a registry token, and push to ONE repository. It cannot pull another repository, delete, or change the repository's policy. */
export const savedEnvPushSessionPolicy = (scope: SavedEnvAccountScope, repositoryName: string): SessionPolicyJson => sessionPolicy(scope, repositoryName, SAVED_ENV_PUSH_ACTIONS, "RegistryToken", "PushToThisRepository", true);
/** What a pull session may do: get a registry token, and read ONE repository. IAM cannot pin a digest; the worker pulls `repository@digest` and checks it (worker/src/saved-env/use.ts). */
export const savedEnvPullSessionPolicy = (scope: SavedEnvAccountScope, repositoryName: string): SessionPolicyJson => sessionPolicy(scope, repositoryName, SAVED_ENV_PULL_ACTIONS, "RegistryToken", "PullFromThisRepository", true);
/** What a scan session may do: start a basic scan of ONE repository's images and read the findings. No token, no push, no pull. */
export const savedEnvScanSessionPolicy = (scope: SavedEnvAccountScope, repositoryName: string): SessionPolicyJson => sessionPolicy(scope, repositoryName, ["ecr:StartImageScan", "ecr:DescribeImageScanFindings"], "", "ScanThisRepository", false);
/** What the mirror's session may do: push, read back and delete in ONE mirror repository, and look at its settings (the template check). No registry token (the mirror uses the registry API, not a login), no scan, no other repository. */
export const COMPANY_IMAGE_MIRROR_ACTIONS = [
  "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages",
  // Create-on-push, as for a saved environment's push.
  "ecr:CreateRepository", "ecr:TagResource",
  // The template check before and after the push, and the revoke's delete.
  "ecr:DescribeRepositories", "ecr:GetRepositoryPolicy", "ecr:BatchDeleteImage", "ecr:DeleteRepository",
] as const;
export const companyImageMirrorSessionPolicy = (scope: SavedEnvAccountScope, repositoryName: string): SessionPolicyJson => sessionPolicy(scope, repositoryName, COMPANY_IMAGE_MIRROR_ACTIONS, "", "MirrorThisRepository", false);
/** What a manage session may do: list, describe and delete the images of ONE repository, and delete the repository. No token, no push, no pull. */
export const savedEnvManageSessionPolicy = (scope: SavedEnvAccountScope, repositoryName: string): SessionPolicyJson => sessionPolicy(scope, repositoryName, SAVED_ENV_MANAGE_ACTIONS, "", "ManageThisRepository", false);

/**
 * The repository policy every saved-environment repository is created with (from the registry's creation template). It DENIES the data actions to every principal except the push and pull roles, so a
 * broad grant elsewhere in the account (the worker role's `ecr:BatchGetImage`, an administrator's) cannot read an image; the account's administrators keep the control actions (delete, lifecycle, policy).
 * Only the push role may write.
 */
export function savedEnvRepositoryPolicy(input: { pushRoleArn: string; pullRoleArn: string; manageRoleArn: string; /** The company image mirror's own role: it reads, writes and deletes in mirror repositories, and its IAM policy reaches no other. */ mirrorRoleArn?: string }): { Version: "2012-10-17"; Statement: Array<Record<string, unknown>> } {
  const mirror = input.mirrorRoleArn === undefined ? [] : [input.mirrorRoleArn];
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "OnlyTheRolesMayRead", Effect: "Deny", Principal: "*",
        Action: [...SAVED_ENV_PULL_ACTIONS, "ecr:BatchCheckLayerAvailability"],
        Condition: { ArnNotEquals: { "aws:PrincipalArn": [input.pushRoleArn, input.pullRoleArn, ...mirror] } },
      },
      {
        Sid: "OnlyThePushRoleMayWrite", Effect: "Deny", Principal: "*",
        Action: ["ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"],
        Condition: { ArnNotEquals: { "aws:PrincipalArn": mirror.length === 0 ? input.pushRoleArn : [input.pushRoleArn, ...mirror] } },
      },
      {
        // Deleting images and the repository is the manage role's; a lifecycle expiry is ECR's own action and is not an IAM principal's.
        Sid: "OnlyTheManageRoleMayDeleteImages", Effect: "Deny", Principal: "*",
        Action: ["ecr:BatchDeleteImage"],
        Condition: { ArnNotEquals: { "aws:PrincipalArn": [input.manageRoleArn, ...mirror] } },
      },
    ],
  };
}

// ---- what the worker gets and returns

const REGISTRY_HOST = /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/u;

/** A registry login for ONE repository, short-lived. The worker uses it for one push or one pull and then forgets it. It is never logged and never in an image. */
export const SavedEnvRegistryAuthSchema = z.object({
  registry: z.string().regex(REGISTRY_HOST, "an ECR registry host"),
  repository: z.string().refine((name) => isSavedEnvRepositoryName(name) || isCompanyImageRepositoryName(name), "a saved environment or company image repository name"),
  username: z.literal("AWS"),
  password: z.string().min(16).max(8192),
  expiresAt: z.string().datetime(),
}).strict();
export type SavedEnvRegistryAuth = z.infer<typeof SavedEnvRegistryAuthSchema>;

/**
 * The prepare invocation's `savedEnv`: WHICH image to pull and the revision this task is pinned to (the worker refuses an image of another revision). It carries NO credential: an invocation is stored (outbox, stream,
 * queue, dead-letter queue), and a pull login must not be. The worker asks the broker for the login at pull time (`SAVED_ENV_LOGIN_PATH`), with the preparation's own grant, and never writes it down.
 */
export const PrepareSavedEnvSchema = z.object({
  repository: z.string().refine((name) => isSavedEnvRepositoryName(name) || isCompanyImageRepositoryName(name), "a saved environment or company image repository name"),
  digest: ImageDigestSchema,
  /** The test environment revision the image was built at. */
  testEnvRevision: z.number().int().min(1),
  environmentKey: z.string().regex(/^[a-f0-9]{64}$/u),
  taskTestEnvRevision: z.number().int().min(1),
}).strict();
export type PrepareSavedEnv = z.infer<typeof PrepareSavedEnvSchema>;

/** What a use works from: the invocation's reference and a login the worker just obtained. Never stored. */
export const SavedEnvUseSchema = z.object({
  repository: z.string().refine((name) => isSavedEnvRepositoryName(name) || isCompanyImageRepositoryName(name), "a saved environment or company image repository name"),
  digest: ImageDigestSchema,
  testEnvRevision: z.number().int().min(1),
  environmentKey: z.string().regex(/^[a-f0-9]{64}$/u),
  auth: SavedEnvRegistryAuthSchema,
}).strict().refine((use) => use.auth.repository === use.repository, "the login is for another repository");
export type SavedEnvUse = z.infer<typeof SavedEnvUseSchema>;