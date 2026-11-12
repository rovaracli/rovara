import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const ProjectSetupCallbackClaimsSchema = z.object({
  domain: z.literal("PROJECT_SETUP"), setupExecutionId: z.string().uuid(), subjectId: z.string().uuid(),
  transportCorrelationId: z.string().uuid(), operationId: z.string().uuid(), approvalRevision: z.number().int().positive(),
  fence: z.number().int().positive(), expiresAt: z.number().int().positive(), actions: z.array(z.enum(["result", "read-execution", "write-evidence"])).min(1).max(3),
}).strict();
export type ProjectSetupCallbackClaims = z.infer<typeof ProjectSetupCallbackClaimsSchema>;

export function issueProjectSetupCapability(key: string, claims: ProjectSetupCallbackClaims): string {
  const body = Buffer.from(JSON.stringify(ProjectSetupCallbackClaimsSchema.parse(claims))).toString("base64url");
  return `project-setup-v1.${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

/** `key`: one key, or the keys a token may verify with (current first, then the previous one inside its rotation window; signing-key-secrets.ts). */
export function verifyProjectSetupCapability(key: string | readonly string[], token: string, nowSeconds = Math.floor(Date.now() / 1_000)): ProjectSetupCallbackClaims | undefined {
  const [version, body, signature, extra] = token.split(".");
  if (version !== "project-setup-v1" || !body || !signature || extra !== undefined) return undefined;
  const actual = Buffer.from(signature, "base64url");
  const matches = (typeof key === "string" ? [key] : key).some((candidate) => {
    const expected = createHmac("sha256", candidate).update(body).digest();
    return actual.byteLength === expected.byteLength && timingSafeEqual(expected, actual);
  });
  if (!matches) return undefined;
  try {
    const parsed = ProjectSetupCallbackClaimsSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown);
    return parsed.success && parsed.data.expiresAt > nowSeconds ? parsed.data : undefined;
  } catch { return undefined; }
}
