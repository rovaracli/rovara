import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { EnvironmentNameSchema, SlackTeamIdSchema, agentXError } from "@rovara-code/contracts";
import { slackDirectory } from "../developer/slack-directory.js";
import { createTaskPersonProofHandler } from "./task-person-proof-handler.js";

export interface TaskPersonProofLambdaContext {
  getRemainingTimeInMillis(): number;
}

const UNAVAILABLE = () => agentXError("SLACK_UNAVAILABLE", "task person identity proof is unavailable");
const ACCOUNT_ID = /^[0-9]{12}$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-[0-9]$/;

/**
 * The one secret this function may read: this environment's own Slack secret (`agentx/<env>/slack`, with Secrets Manager's random suffix) in this account and region.
 * Built from what the stack sets (`AGENTX_ENV`, `AGENTX_ACCOUNT_ID`) and the region Lambda runs in, never from the ARN the stack gives, so a mis-set ARN names no other secret.
 */
function expectedSecretArn(env: string, account: string, region: string): RegExp {
  // Every part was matched against a fixed alphabet (lowercase letters, digits and hyphens) before this, so none carries a character that means anything in a pattern.
  return new RegExp(`^arn:aws:secretsmanager:${region}:${account}:secret:agentx/${env}/slack-[A-Za-z0-9]+$`);
}

function botTokenFromSecret(secretString: string): string {
  let value: unknown;
  try {
    value = JSON.parse(secretString) as unknown;
  } catch {
    throw UNAVAILABLE();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw UNAVAILABLE();
  const token = (value as Record<string, unknown>).botToken;
  if (typeof token !== "string" || !/^xoxb-\S+$/.test(token)) throw UNAVAILABLE();
  return token;
}

/** Dedicated Lambda runtime for the task person proof (every named environment). Credentials are read once per proof invocation and never cached across invocations. */
export async function handler(event: unknown, context: TaskPersonProofLambdaContext) {
  const env = process.env;
  const teamId = env.SLACK_TEAM_ID;
  const secretArn = env.SLACK_SECRET_ARN;
  const named = EnvironmentNameSchema.safeParse(env.AGENTX_ENV);
  const account = env.AGENTX_ACCOUNT_ID;
  const region = env.AWS_REGION;
  if (!named.success || account === undefined || !ACCOUNT_ID.test(account) || region === undefined || !REGION.test(region)
    || teamId === undefined || !SlackTeamIdSchema.safeParse(teamId).success
    || secretArn === undefined || !expectedSecretArn(named.data, account, region).test(secretArn)) throw UNAVAILABLE();

  const secrets = new SecretsManagerClient({ region, maxAttempts: 1 });
  const proof = createTaskPersonProofHandler({
    expectedTeamId: teamId,
    now: () => Date.now(),
    remainingTimeMs: () => context.getRemainingTimeInMillis(),
    async readProof(request, admission) {
      let credential: Promise<string> | undefined;
      const botToken = async (): Promise<string> => {
        if (admission.abortSignal.aborted || Date.now() >= admission.deadlineAt) throw UNAVAILABLE();
        credential ??= secrets.send(new GetSecretValueCommand({ SecretId: secretArn }), { abortSignal: admission.abortSignal }).then((reply) => {
          if (admission.abortSignal.aborted || Date.now() >= admission.deadlineAt || typeof reply.SecretString !== "string") throw UNAVAILABLE();
          return botTokenFromSecret(reply.SecretString);
        });
        return credential;
      };
      const directory = slackDirectory({
        teamId,
        botToken,
        fetch,
        now: () => Date.now(),
        maxCallsPerRequest: 100,
        maxInfoCallsPerRequest: 1,
      });
      return directory.taskDispatchPersonProof(request, {
        deadlineAt: admission.deadlineAt,
        slackCallsLimit: admission.slackCallsLimit,
        abortSignal: admission.abortSignal,
      });
    },
  });
  return proof(event);
}
