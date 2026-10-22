import { nativeConnectionCheck, nativeConnectorType } from "../connectors/native/runtime.js";
import { DATADOG_SPEC } from "../connectors/native/datadog.js";

/** Plan 4 Task 14: Datadog, read natively in the broker through an org connection's API and application keys; one scope per tag set. */
export const datadogConnectorType = nativeConnectorType(DATADOG_SPEC);

/** The org connection check for a Datadog connection (`OrgConnectionStoreInput.checks.datadog`). */
export const datadogConnectionCheck = nativeConnectionCheck(DATADOG_SPEC, "datadog");
