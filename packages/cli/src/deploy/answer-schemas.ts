// Validation building blocks shared by every place that reads or writes deploy-shaped answers:
// `DeployAnswersSchema` (commands.ts, the `agentx deploy` answers file) and `InitAnswersSchema`
// (../init/install-state.ts, `agentx init`'s own saved answers), plus `agentx init`'s prompts
// themselves where they validate the same shapes fresh from a person typing them in. Living here,
// instead of inside commands.ts, means neither the init nor the deploy side owns the other's
// validation: both import the same regex or schema object, so a region, account, identity, models,
// images or alert-email answer is refused (or accepted) identically wherever it is checked.
import { z } from "zod";
import { agentXError, MODEL_PROVIDERS, SECRET_ARN_MAX_LENGTH, SECRET_ARN_PATTERN, type KeyedModelProvider } from "@agentx/contracts";

/** Shared with `runInitExport`'s own `--region`/`--account` validation, so both commands refuse the
 * same malformed values the same way. */
export const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;
export const ACCOUNT_PATTERN = /^\d{12}$/;

/** Shared between `InitAnswersSchema` (../init/install-state.js, parsing a GitHub account already
 * stored) and `agentx init`'s own `--github-account` prompt and flag validation, so a GitHub
 * organization or user name is accepted or refused identically wherever it is checked. */
export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export const IdentityAnswersSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("cognito") }).strict(),
  z
    .object({
      mode: z.literal("oidc"),
      issuer: z.string().url(),
      audience: z.string().min(1),
      adminClaim: z.string().min(1).optional(),
      adminValues: z.array(z.string().min(1)).min(1).optional(),
      clientId: z.string().min(1).optional(),
    })
    .strict(),
]);

/** The hosted Rovara cloud's sign-in settings (ruling R46): Google is optional (email code only without it);
 * the hosted-domain prefix defaults to rovara-<env> in the template. Stored beside `cloud: true`. */
export const CloudSignInAnswersSchema = z.object({
  googleClientId: z.string().min(1).max(256).optional(),
  googleClientSecretArn: z.string().max(SECRET_ARN_MAX_LENGTH).regex(SECRET_ARN_PATTERN).optional(),
  domainPrefix: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/).optional(),
  /** Sign up and sign in with GitHub (Task 22): the GitHub OAuth app's client id and the secret holding its client secret. Optional, and together. */
  githubClientId: z.string().min(1).max(256).optional(),
  githubClientSecretArn: z.string().max(SECRET_ARN_MAX_LENGTH).regex(SECRET_ARN_PATTERN).optional(),
}).strict();
export type CloudSignInAnswers = z.infer<typeof CloudSignInAnswersSchema>;

/** Said wherever the prebuilt-templates engine would be used for a cloud environment (R45): the release's templates are synthesized without the cloud switch. */
export const CLOUD_NEEDS_CDK_MESSAGE = "the hosted Rovara cloud (cloud: true) must be synthesized from source; use --engine cdk --source <checkout of the release tag>, not the prebuilt templates";

const ModelProviderSchema = z.enum(MODEL_PROVIDERS);
/** A direct provider's key: only the ARN of the secret holding it (spec 054). */
const DirectKeySchema = z.object({ secretArn: z.string().max(SECRET_ARN_MAX_LENGTH).regex(SECRET_ARN_PATTERN) }).strict();
export const ModelsAnswersSchema = z.object({
  orchestrator: z.string().min(1), classifier: z.string().min(1), worker: z.string().min(1),
  providers: z.object({ orchestrator: ModelProviderSchema.optional(), classifier: ModelProviderSchema.optional(), worker: ModelProviderSchema.optional() }).strict().optional(),
  openRouter: z.object({
    secretArn: z.string().regex(SECRET_ARN_PATTERN),
    providers: z.array(z.string().regex(/^[a-z0-9][a-z0-9_/-]{0,79}$/)).min(1).optional(),
  }).strict().optional(),
  anthropic: DirectKeySchema.optional(),
  openai: DirectKeySchema.optional(),
}).strict();

/** The providers whose key the answers hold an ARN for, and that ARN. OpenRouter's lives under openRouter. */
export const DIRECT_PROVIDERS = ["anthropic", "openai"] as const;
export type DirectProvider = (typeof DIRECT_PROVIDERS)[number];
export function providerSecretArn(models: ModelsAnswers, provider: KeyedModelProvider): string | undefined {
  return provider === "openrouter" ? models.openRouter?.secretArn : models[provider]?.secretArn;
}
export type ModelsAnswers = z.infer<typeof ModelsAnswersSchema>;

export const ImagesAnswersSchema = z.object({ worker: z.string().min(1).optional(), slack: z.string().min(1).optional() }).strict();

/** The one email check an alert-by-email answer goes through, whether it is being parsed back out of
 * install answers already stored in SSM or validated fresh at the `agentx init` prompt: both call
 * this schema rather than each keeping their own regex that could quietly drift apart. */
export const AlertEmailSchema = z.email();

/**
 * The audit ledger's lock profile (the control plane's AuditLockProfile parameter). `production`: records are locked in
 * compliance mode for 3 years. `trial`: governance mode for 1 day. An install can move from trial to production and never back.
 */
export const AuditLockProfileSchema = z.enum(["production", "trial"]);
export type AuditLockProfileAnswer = z.infer<typeof AuditLockProfileSchema>;

/** What the CLI says when a move from production to trial is asked for (the ledger's records are locked for 3 years). */
export const AUDIT_LOCK_DOWNGRADE_MESSAGE = "audit ledger: an install in production mode can't go back to trial; its records are locked for 3 years";

/**
 * Refuses a move of the audit ledger's lock profile from production to trial, before CloudFormation runs. This states
 * the operator's intent early and clearly; it is not the only guard. S3 itself refuses to delete an object version
 * locked in compliance mode and refuses to shorten or relax that lock, so going back to trial could never loosen the
 * records already written under production. It would only make new records weaker, which is what this refuses.
 */
export function assertAuditLockNotLowered(deployed: string | undefined, requested: string | undefined): void {
  if (deployed === "production" && requested === "trial") throw agentXError("CONFIG_INVALID", AUDIT_LOCK_DOWNGRADE_MESSAGE);
}

/** The largest monthly budget, in whole US dollars, that init and `config set` accept. The template
 * itself allows up to 9,999,999; one cap here means the CLI never accepts a budget it later refuses. */
export const MAX_BUDGET_USD = 1_000_000;

/** FR-047: the monthly budget init offers; absent means none. */
export const BudgetAnswersSchema = z.object({ monthlyUsd: z.number().int().min(1).max(MAX_BUDGET_USD), scope: z.enum(["tag", "account"]) }).strict();
