// Setup and test health SH22 (design setup-test-health.md, sections 5.1 and 5.2): where a saved environment image lives and who may touch it.
//
// One ECR repository per org AND project: `rovara-env/<env>/o<hash of the org>/p<hash of the org and the project>`. The names are one-way hashes (no org or project name in a registry listing), and a
// project's repository can never be another project's, in the same org or another. Access is by SESSIONS the broker mints: the broker assumes one of three fixed-name roles with an inline session policy
// that names ONE repository, so a bug that builds the wrong repository name still cannot reach another project's image (the same shape as the Team record's vector sessions).
//
// Pure: no clock, no network, no Node module. The infrastructure (infra/lib/saved-env-images.ts), the broker (broker/src/test-env/saved-env-session.ts) and the worker (worker/src/saved-env/build.ts) all
// use these functions, so a name is never built two ways.
//
// What an image holds: only `/rovara/seed` (the repositories at the proved commits with their dependency folders and warm caches) and `/rovara/manifest.json`. It is built `FROM scratch`: it holds no
// operating system, and nothing in it is ever run. The worker copies the seed out of it.
import { z } from "zod";
import { SavedEnvManifestSchema, ImageDigestSchema, SAVED_ENV_KEEP_MAX, SAVED_ENV_KEEP_MIN } from "./saved-env.js";
import { sha256Hex } from "./web-hash.js";

/** The first segment of every saved-environment repository, and the prefix of the repository creation template. */
export const SAVED_ENV_REPOSITORY_ROOT = "rovara-env";
/** Where the repositories are inside the image, and where the manifest is. The worker copies `SEED` out and reads `MANIFEST`. */
export const SAVED_ENV_IMAGE_SEED_PATH = "/rovara/seed";
export const SAVED_ENV_IMAGE_MANIFEST_PATH = "/rovara/manifest.json";
/** Image labels (read without running anything: `docker image inspect`). */
export const SAVED_ENV_LABEL_KEY = "io.rovara.saved-env.key";
export const SAVED_ENV_LABEL_REVISION = "io.rovara.saved-env.revision";
export const SAVED_ENV_LABEL_PROVE = "io.rovara.saved-env.prove";
/**
 * The age ceiling: an image is deleted this long after it was pushed (the 7 day rebuild rule makes an older image stale anyway). ECR's lifecycle cannot express it next to "keep the newest N" (a rule on tagged images
 * with an age never matches once a count rule has them), so it is ENFORCED BY THE BROKER'S MANAGE WALK (SH24), not by the lifecycle policy.
 */
export const SAVED_ENV_IMAGE_CEILING_DAYS = 30;
/** Untagged images (a failed push) are deleted after this long. */
export const SAVED_ENV_UNTAGGED_DAYS = 1;
/**
 * How long each session lives. A push of a large seed can take most of an hour (the chained-role maximum is 3,600 seconds); a pull and the broker's own manage and scan calls are short. The worker also refuses a
 * login with under a minute left, so a session near its end is never used to start a push.
 */
export const SAVED_ENV_PUSH_SESSION_SECONDS = 3_600;
export const SAVED_ENV_PULL_SESSION_SECONDS = 1_800;
export const SAVED_ENV_MANAGE_SESSION_SECONDS = 900;

const EnvName = z.string().regex(/^[a-z][a-z0-9-]{0,19}$/u, "an environment name");
const IdText = z.string().min(1).max(200).regex(/^[^\p{Cc}\p{Cf}]+$/u, "an id has no control characters");

/** The prefix of every repository of one environment: `rovara-env/<env>`. */
export function savedEnvRepositoryPrefix(env: string): string {
  return `${SAVED_ENV_REPOSITORY_ROOT}/${EnvName.parse(env)}`;
}

const REPOSITORY_NAME = /^rovara-env\/[a-z][a-z0-9-]{0,19}\/o[a-f0-9]{32}\/p[a-f0-9]{32}$/u;

/**
 * The repository of one project: the org and the project are each a hash, and the project's hash covers its org, so two orgs that use the same project id still get two repositories. Throws on an
 * environment name or an id that is not text (a name is never built from something unchecked).
 */
export function savedEnvRepositoryName(input: { env: string; orgId: string; projectId: string }): string {
  const org = IdText.parse(input.orgId);
  const project = IdText.parse(input.projectId);
  const orgHash = sha256Hex(`rovara.saved-env.org\u0000${org}`).slice(0, 32);
  const projectHash = sha256Hex(`rovara.saved-env.project\u0000${org}\u0000${project}`).slice(0, 32);
  return `${savedEnvRepositoryPrefix(input.env)}/o${orgHash}/p${projectHash}`;
}

/** Whether `name` is exactly the shape `savedEnvRepositoryName` makes (no wildcard, no policy variable, no extra segment). */
export function isSavedEnvRepositoryName(name: string): boolean {
  return REPOSITORY_NAME.test(name);
}

/** The fixed names of the three roles the broker assumes. Fixed, so the broker builds their ARNs from the environment alone and the deploy role can look them up before they exist. */
/** What the names of the broker-assumed roles start with (the boundary names them with a trailing `*`). */
export const savedEnvRolePrefix = (env: string): string => `agentx-${EnvName.parse(env)}-img-`;
export const savedEnvPushRoleName = (env: string): string => `agentx-${EnvName.parse(env)}-img-push`;
export const savedEnvPullRoleName = (env: string): string => `agentx-${EnvName.parse(env)}-img-pull`;
export const savedEnvManageRoleName = (env: string): string => `agentx-${EnvName.parse(env)}-img-manage`;
/** The role ECR assumes to create a repository from the creation template. Fixed too, so Enterprise can name it in its own key policy BEFORE the install is deployed (the ARN is `arn:<partition>:iam::<account>:role/agentx/<env>/<this name>`). */
export const savedEnvCreateRoleName = (env: string): string => `agentx-${EnvName.parse(env)}-img-create`;

export interface SavedEnvAccountScope { partition: string; region: string; account: string }

/** The ARN of one repository (or of `rovara-env/<env>/*` when given the prefix and a `*`). Refuses anything but a name this module makes, so a `*`, a `?` or a policy variable cannot get in. */
export function savedEnvRepositoryArn(scope: SavedEnvAccountScope, repositoryName: string): string {
  if (!isSavedEnvRepositoryName(repositoryName)) throw new Error("not a saved environment repository name");
  return `arn:${scope.partition}:ecr:${scope.region}:${scope.account}:repository/${repositoryName}`;
}

/** Every repository of the environment (for the ROLES' own policies; a session narrows it to one). */
export function savedEnvRepositoriesArn(scope: SavedEnvAccountScope, env: string): string {
  return `arn:${scope.partition}:ecr:${scope.region}:${scope.account}:repository/${savedEnvRepositoryPrefix(env)}/*`;
}

export const SAVED_ENV_PUSH_ACTIONS = [
  "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages",
  // Create-on-push: the first push makes the repository from the registry's creation template (immutable tags, KMS, lifecycle, repository policy).
  "ecr:CreateRepository", "ecr:TagResource",
  // A basic scan after each push (the registry-wide scan-on-push setting is off by default): the broker starts it in a push-role session of its own (SH24).
  "ecr:StartImageScan", "ecr:DescribeImageScanFindings",
] as const;
export const SAVED_ENV_PULL_ACTIONS = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"] as const;
// GetRepositoryPolicy and DescribeRepositories are how the broker checks a repository is the one the creation template made (encryption, key, immutable tags, policy) before it mints a push or pull login.
export const SAVED_ENV_MANAGE_ACTIONS = ["ecr:DescribeRepositories", "ecr:GetRepositoryPolicy", "ecr:DescribeImages", "ecr:ListImages", "ecr:BatchDeleteImage", "ecr:DeleteRepository"] as const;
/** Registry-wide: ECR cannot scope the token call to a repository. What the token may DO is set by the session policy below. */
const TOKEN_ACTION = "ecr:GetAuthorizationToken";

export interface SessionPolicyJson { Version: "2012-10-17"; Statement: Array<Record<string, unknown>> }

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
/** What a manage session may do: list, describe and delete the images of ONE repository, and delete the repository. No token, no push, no pull. */
export const savedEnvManageSessionPolicy = (scope: SavedEnvAccountScope, repositoryName: string): SessionPolicyJson => sessionPolicy(scope, repositoryName, SAVED_ENV_MANAGE_ACTIONS, "", "ManageThisRepository", false);

/**
 * The repository policy every saved-environment repository is created with (from the registry's creation template). It DENIES the data actions to every principal except the push and pull roles, so a
 * broad grant elsewhere in the account (the worker role's `ecr:BatchGetImage`, an administrator's) cannot read an image; the account's administrators keep the control actions (delete, lifecycle, policy).
 * Only the push role may write.
 */
export function savedEnvRepositoryPolicy(input: { pushRoleArn: string; pullRoleArn: string; manageRoleArn: string }): { Version: "2012-10-17"; Statement: Array<Record<string, unknown>> } {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "OnlyTheRolesMayRead", Effect: "Deny", Principal: "*",
        Action: [...SAVED_ENV_PULL_ACTIONS, "ecr:BatchCheckLayerAvailability"],
        Condition: { ArnNotEquals: { "aws:PrincipalArn": [input.pushRoleArn, input.pullRoleArn] } },
      },
      {
        Sid: "OnlyThePushRoleMayWrite", Effect: "Deny", Principal: "*",
        Action: ["ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"],
        Condition: { ArnNotEquals: { "aws:PrincipalArn": input.pushRoleArn } },
      },
      {
        // Deleting images and the repository is the manage role's; a lifecycle expiry is ECR's own action and is not an IAM principal's.
        Sid: "OnlyTheManageRoleMayDeleteImages", Effect: "Deny", Principal: "*",
        Action: ["ecr:BatchDeleteImage"],
        Condition: { ArnNotEquals: { "aws:PrincipalArn": [input.manageRoleArn] } },
      },
    ],
  };
}

/**
 * The lifecycle policy: untagged images go after a day, and the newest `keep` images stay. Immutable tags make a tag unmovable, so the newest `keep` are exactly the last builds. There is NO age rule here:
 * ECR evaluates rules in priority order and a later rule on tagged images never sees what a count rule keeps. The 30 day ceiling is the broker's manage walk (SH24), `SAVED_ENV_IMAGE_CEILING_DAYS`.
 */
export function savedEnvLifecyclePolicy(keep: number): { rules: Array<Record<string, unknown>> } {
  const count = z.number().int().min(SAVED_ENV_KEEP_MIN).max(SAVED_ENV_KEEP_MAX).parse(keep);
  return {
    rules: [
      { rulePriority: 1, description: "Untagged images expire", selection: { tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: SAVED_ENV_UNTAGGED_DAYS }, action: { type: "expire" } },
      { rulePriority: 2, description: `Keep the last ${String(count)} images`, selection: { tagStatus: "tagged", tagPatternList: ["*"], countType: "imageCountMoreThan", countNumber: count }, action: { type: "expire" } },
    ],
  };
}

// ---- what the worker gets and returns

const REGISTRY_HOST = /^\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/u;

/** A registry login for ONE repository, short-lived. The worker uses it for one push or one pull and then forgets it. It is never logged and never in an image. */
export const SavedEnvRegistryAuthSchema = z.object({
  registry: z.string().regex(REGISTRY_HOST, "an ECR registry host"),
  repository: z.string().refine(isSavedEnvRepositoryName, "a saved environment repository name"),
  username: z.literal("AWS"),
  password: z.string().min(16).max(8192),
  expiresAt: z.string().datetime(),
}).strict();
export type SavedEnvRegistryAuth = z.infer<typeof SavedEnvRegistryAuthSchema>;

/**
 * What a task's preparation is told when the project has a saved environment it may use (SH23; the prepare payload carries it, SH25): the repository, the image DIGEST (never a tag), the revision and the key
 * the broker expects the image to say, and a pull login for that one repository. The worker checks the pulled image says the same before it uses anything in it.
 */
export const SavedEnvUseSchema = z.object({
  repository: z.string().refine(isSavedEnvRepositoryName, "a saved environment repository name"),
  digest: ImageDigestSchema,
  /** The test environment revision the image was built at. */
  testEnvRevision: z.number().int().min(1),
  environmentKey: z.string().regex(/^[a-f0-9]{64}$/u),
  auth: SavedEnvRegistryAuthSchema,
}).strict().refine((use) => use.auth.repository === use.repository, "the login is for another repository");
export type SavedEnvUse = z.infer<typeof SavedEnvUseSchema>;

/** The steps a use can fail at; the evidence says "fresh setup (saved environment failed at <step>)" and the registry marks the image stale. */
export const SAVED_ENV_USE_STEPS = ["input", "revision", "pull", "inspect", "extract", "layout", "manifest", "links", "git", "copy", "fetch"] as const;
export type SavedEnvUseStep = (typeof SAVED_ENV_USE_STEPS)[number];

/** What is written into the image as `/rovara/manifest.json`: the manifest without the digest (an image cannot hold its own digest). The broker keeps the full manifest. */
export const SavedEnvImageManifestSchema = SavedEnvManifestSchema.omit({ imageDigest: true });
export type SavedEnvImageManifest = z.infer<typeof SavedEnvImageManifestSchema>;

export const SAVED_ENV_BUILD_FAILURES = [
  /** The Prove run did not pass, or it was not for the approved environment. */
  "not_proved",
  /** The environment is not the approved revision. */
  "not_approved",
  /** The Prove sandbox was not a new one (it shares an id or a workspace with a task or the setup agent). */
  "not_fresh",
  /** A repository is not at the head of its default branch. */
  "not_default_branch",
  /** A secret was found in what would go into the image. Nothing was built. */
  "secrets_found",
  "unsafe_tree",
  "no_push_session",
  "build_failed",
  "push_failed",
  "digest_mismatch",
  "base_not_pinned",
  "prove_failed",
  "fresh_sandbox_failed",
] as const;
export type SavedEnvBuildFailure = (typeof SAVED_ENV_BUILD_FAILURES)[number];

export const SavedEnvBuildResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), repository: z.string().refine(isSavedEnvRepositoryName), tag: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u), imageDigest: ImageDigestSchema, manifest: SavedEnvManifestSchema }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(SAVED_ENV_BUILD_FAILURES), step: z.string().max(40).optional() }).strict(),
]);
export type SavedEnvBuildResult = z.infer<typeof SavedEnvBuildResultSchema>;
