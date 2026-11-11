import { z } from "zod";
import { forwardReader, NeedsConfirmationSchema } from "@rovara-code/contracts";
// RULING Q16: read the existing agent/version-gate and session-share answers without changing their strict server schemas.
export const PendingConfirmationReaderSchema = forwardReader(NeedsConfirmationSchema.extend({ status: z.enum(["NEEDS_CONFIRMATION", "NEEDS_OWNER_APPROVAL"]), code: NeedsConfirmationSchema.shape.code.optional(), confirmUrl: z.string().max(2048).optional() }));
export const PendingAdminApprovalReaderSchema = forwardReader(z.object({ status: z.literal("NEEDS_ADMIN_APPROVAL"), spendRequestId: z.string().min(1).max(200), message: z.string().min(1).max(2000) }));
export const ApiErrorResponseReaderSchema = z.looseObject({ error: z.looseObject({ code: z.string(), message: z.string(), signInUrl: z.string().optional(), confirmUrl: z.string().optional() }) });
