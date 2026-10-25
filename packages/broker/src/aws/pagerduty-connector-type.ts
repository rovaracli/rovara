import { nativeConnectionCheck, nativeConnectorType } from "../connectors/native/runtime.js";
import { PAGERDUTY_SPEC } from "../connectors/native/pagerduty.js";

/** Plan 4 Task 15: PagerDuty, read natively in the broker through an org connection's REST API key; one scope per service set. */
export const pagerdutyConnectorType = nativeConnectorType(PAGERDUTY_SPEC);

/** The org connection check for a PagerDuty connection (`OrgConnectionStoreInput.checks.pagerduty`). */
export const pagerdutyConnectionCheck = nativeConnectionCheck(PAGERDUTY_SPEC, "pagerduty");
