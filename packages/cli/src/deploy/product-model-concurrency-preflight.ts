// TE-F1e (fix round 1, from 89's staging read): the product model egress function reserves Lambda concurrency (stack parameter ProductModelEgressReservedConcurrency, default 20). AWS refuses a reservation that
// would leave the account's unreserved concurrency under 100 (Lambda quotas: "Lambda reserves 100 units of concurrency for functions that don't have reserved concurrency"), and a new account often has a quota of
// 10, so a deploy would fail at CREATE time, which no template diff or change set shows. This read-only preflight refuses first, with a fixed reason. Staging (quota 1,000, 12 reserved elsewhere) takes 20.
import { GetAccountSettingsCommand, GetFunctionConcurrencyCommand } from "@aws-sdk/client-lambda";

/** The template's default for ProductModelEgressReservedConcurrency (infra/lib/product-model-egress.ts PRODUCT_MODEL_EGRESS_RESERVED_CONCURRENCY; a contract test holds the two equal). */
export const PRODUCT_MODEL_EGRESS_DEFAULT_RESERVED_CONCURRENCY = 20;
/** Lambda's floor of unreserved concurrency an account must keep. */
export const LAMBDA_UNRESERVED_FLOOR = 100;
export const PRODUCT_MODEL_CONCURRENCY_REFUSAL =
  "The account's Lambda concurrency quota cannot take the product model egress function's reserved concurrency while keeping 100 unreserved. Ask AWS to raise the account's concurrent executions quota, or deploy with --no-reserved-concurrency.";

export type ProductModelConcurrencyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const whole = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/**
 * `unreserved`: the account's UnreservedConcurrentExecutions now. `alreadyReservedByFunction`: the function's own current reservation (0 when it does not exist yet), which an update gives back before it reserves
 * the new figure. Refuses when what stays unreserved after the reservation is under the floor, or when a number cannot be read.
 */
export function productModelConcurrencyPreflight(input: { readonly unreserved: number; readonly reservation: number; readonly alreadyReservedByFunction: number }): ProductModelConcurrencyResult {
  if (!whole(input.unreserved) || !whole(input.reservation) || !whole(input.alreadyReservedByFunction)) return { ok: false, reason: PRODUCT_MODEL_CONCURRENCY_REFUSAL };
  const left = input.unreserved + input.alreadyReservedByFunction - input.reservation;
  return left >= LAMBDA_UNRESERVED_FLOOR ? { ok: true } : { ok: false, reason: PRODUCT_MODEL_CONCURRENCY_REFUSAL };
}

interface LambdaReader { send(command: GetAccountSettingsCommand | GetFunctionConcurrencyCommand): Promise<unknown> }

/** Two read-only calls: GetAccountSettings and the function's GetFunctionConcurrency (a function that does not exist yet reserves 0). */
export async function readLambdaConcurrency(lambda: LambdaReader, functionName: string): Promise<{ readonly unreserved: number; readonly alreadyReservedByFunction: number }> {
  const settings = (await lambda.send(new GetAccountSettingsCommand({}))) as { AccountLimit?: { UnreservedConcurrentExecutions?: number } };
  let own = 0;
  try {
    own = ((await lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: functionName }))) as { ReservedConcurrentExecutions?: number }).ReservedConcurrentExecutions ?? 0;
  } catch (error) {
    if (!(error instanceof Error && error.name === "ResourceNotFoundException")) throw error;
  }
  return { unreserved: settings.AccountLimit?.UnreservedConcurrentExecutions ?? Number.NaN, alreadyReservedByFunction: own };
}
