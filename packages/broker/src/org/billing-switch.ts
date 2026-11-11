// Billing (lane srv/trial-reads, decision 91): the install switch `bl`. Leaf module (no broker imports). A packed broker setting that reaches the broker as BILLING_ENABLED, on only when it is
// exactly "1". Off (the default; the stack parameter that would set it is not wired yet) every billing path, `/v1/app/org/billing` and `/v1/app/org/billing/invoices`, answers "not found" like any
// unknown path. The trial read (`GET /v1/app/trial`) does not need it.
import { BROKER_SETTINGS } from "@agentx/cloud-contracts";
import { liveInteractionFlagOn } from "@rovara-code/contracts";

/** Whether the billing routes exist in this environment. Anything but exactly "1" (unset, empty, "true", " 1") is off. */
export const billingEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.billing.variable]);
