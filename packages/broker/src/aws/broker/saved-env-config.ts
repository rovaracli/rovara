// The environment the saved-environment registry's config is read from (a small module of its own: the company image mirror function uses it too and must not pull the whole broker into its bundle).
import { awsPartitionOf } from "../broker-environment.js";

const ACCOUNT = /^[0-9]{12}$/u;
const KMS_KEY_ARN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key\/(?:mrk-[0-9a-f]{32}|[0-9a-f-]{36})$/u;

/** The environment the registry's config is read from. Undefined (with the missing name logged) when the install cannot run it. */
export function savedEnvConfigOf(env: NodeJS.ProcessEnv): { env: string; scope: { partition: string; region: string; account: string }; kmsKeyArn: string } | undefined {
  const name = env["AGENTX_ENV"];
  const region = env["AWS_REGION"];
  const account = env["AGENTX_ACCOUNT_ID"];
  const kmsKeyArn = env["SAVED_ENV_KMS_KEY_ARN"];
  const missing = [["AGENTX_ENV", name !== undefined && name !== ""], ["AWS_REGION", region !== undefined && region !== ""], ["AGENTX_ACCOUNT_ID", account !== undefined && ACCOUNT.test(account)], ["SAVED_ENV_KMS_KEY_ARN", kmsKeyArn !== undefined && KMS_KEY_ARN.test(kmsKeyArn)]]
    .filter(([, present]) => present !== true).map(([variable]) => variable);
  if (missing.length > 0) {
    console.log(JSON.stringify({ component: "broker", event: "saved_env.not_installed", missing }));
    return undefined;
  }
  return { env: name!, scope: { partition: awsPartitionOf(region!), region: region!, account: account! }, kmsKeyArn: kmsKeyArn! };
}
