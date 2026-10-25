import { nativeConnectionCheck, nativeConnectorType } from "../connectors/native/runtime.js";
import { VERCEL_SPEC } from "../connectors/native/vercel.js";

/** Plan 4 Task 15: Vercel, read natively in the broker through an org connection's access token; one scope per project. */
export const vercelConnectorType = nativeConnectorType(VERCEL_SPEC);

/** The org connection check for a Vercel connection (`OrgConnectionStoreInput.checks.vercel`). */
export const vercelConnectionCheck = nativeConnectionCheck(VERCEL_SPEC, "vercel");
