// Test services, slice 1: the AWS account this broker is running in, from the Lambda's OWN invocation context (`invokedFunctionArn`), for the catalog's trust decision (contracts catalog-trust.ts). It is never read from a
// setting, an environment variable or a request: the only writer is the Lambda handler, with the context the Lambda runtime gave it. Until the first invocation the account is unknown, and an unknown account trusts nothing
// from the staging-only key list.
import { accountIdOfArn } from "@rovara-code/contracts";

let account: string | undefined;

/** Notes the account of the function's own ARN. Anything that does not hold an account id leaves what was noted. */
export function noteInvokedFunctionArn(arn: unknown): void {
  const found = typeof arn === "string" ? accountIdOfArn(arn) : undefined;
  if (found !== undefined) account = found;
}

/** The account noted from the function's own ARN, or undefined before the first invocation. */
export const lambdaAccountId = (): string | undefined => account;

/** For tests only: forgets what was noted. */
export function forgetInvokedFunctionArn(): void {
  account = undefined;
}
