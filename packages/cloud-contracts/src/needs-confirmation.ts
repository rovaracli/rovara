import { z } from "zod";
export const CHANGE_TEXT_MAX = 300;

/**
 * What a take-over or a company-wide share answers (HTTP 202) when the caller isn't signed in freshly enough to decide it: a link to open
 * in a browser. It is the shape of Plan 3's own pending-change routes, so CLI and MCP clients print the link and never say the sign-in ended.
 */
/** Shared confirmation metadata; absent on ordinary two-person confirmations. */
export const SoleOwnerConfirmationSchema = z.object({
  available:z.boolean(),availableAt:z.string().datetime().nullable(),
  reasonCode:z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u).optional(),
}).strict();
