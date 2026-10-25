import { nativeConnectionCheck, nativeConnectorType } from "../connectors/native/runtime.js";
import { SENTRY_SPEC } from "../connectors/native/sentry.js";

/** Plan 4 Task 13: Sentry, read natively in the broker through an org connection's auth token; one scope per project. */
export const sentryConnectorType = nativeConnectorType(SENTRY_SPEC);

/** The org connection check for a Sentry connection (`OrgConnectionStoreInput.checks.sentry`). */
export const sentryConnectionCheck = nativeConnectionCheck(SENTRY_SPEC, "sentry");
