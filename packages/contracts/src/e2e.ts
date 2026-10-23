import { z } from "zod";

export const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const id = (max = 120) => z.string().trim().min(1).max(max);

export const positiveInt = z.number().int().positive();

export const E2E_PROJECT_CHECK_ID = "project-e2e" as const;

export const E2EQualifiedRoundSchema = z.object({ candidateDigest: digest, contractDigest: digest, policyDigest: digest, bundleDigest: digest,
  executionPlanDigest: digest, roundId: z.string().uuid(), groupRunIds: z.array(z.string().uuid()).min(1).max(4),
  admissionSha256: digest, evidenceSha256: digest }).strict();

export const E2EFailedRoundSchema = z.object({ status: z.literal("FAILED"), candidateDigest: digest, roundId: z.string().uuid(),
  groupRunIds: z.array(z.string().uuid()).min(1).max(4), admissionSha256: digest, evidenceSha256: digest }).strict();

/** Bounded notifier display cache. It is never qualification or action authority. */
export const E2EWorkflowDisplayRefSchema = z.object({ schemaVersion: z.literal(1), key: z.string().regex(/^private\/[^/]+\/[^/]+\/workflow-e2e-display\/[a-f0-9]{64}\.json$/),
  sha256: digest, byteLength: positiveInt.max(262_144), candidateDigest: digest, roundId: z.string().uuid(), groupRunIds: z.array(z.string().uuid()).min(1).max(4), admissionSha256: digest, evidenceSha256: digest }).strict();

export const E2EWorkflowProgressSchema = z.object({ contractDigest: digest, policyDigest: digest, bundleDigest: digest, executionPlanDigest: digest, required: z.boolean(), currentRoundId: z.string().uuid().optional(), currentGroupRunIds: z.array(z.string().uuid()).max(12), resultRefs: z.array(id(200)).max(64), qualifiedRound: E2EQualifiedRoundSchema.optional(), failedRound: E2EFailedRoundSchema.optional(), displayRef: E2EWorkflowDisplayRefSchema.optional() }).strict();
