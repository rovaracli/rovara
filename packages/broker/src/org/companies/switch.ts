// Company memberships (srv/company-memberships, decision 91): the install switch `cw`. Leaf module (no broker imports). A packed broker setting that reaches the broker as COMPANY_SWITCHER_ENABLED, on only when it is
// exactly "1". Off (the default; the stack parameter that would set it is not wired yet): `/v1/app/companies` answers "not found" like any unknown path, a session's chosen company is not read (everyone is in their
// primary company, as before), and `x-rovara-company` is neither checked nor echoed.
import { BROKER_SETTINGS } from "@agentx/cloud-contracts";
import { liveInteractionFlagOn } from "@rovara-code/contracts";

/** Whether the company switcher's server side is on. Anything but exactly "1" (unset, empty, "true", " 1") is off. */
export const companySwitcherEnabled = (env: Record<string, string | undefined> = process.env): boolean => liveInteractionFlagOn(env[BROKER_SETTINGS.companySwitcher.variable]);
