// Proof and evidence B4: the gate in front of video and traces (design 3.4). A trace or a video of a browser session can hold session tokens, cookies and anything on screen, and scrubbing cannot be made
// reliable, so they are kept only when the secrets in them are worthless: the accounts are run-scoped (made for the round and revoked after it), the data is synthetic, the tier lets the provisioner delete,
// and the company has switched the less-safe option on. Every condition must hold; the first one that does not names the reason, in the design's order. Pure and browser-safe.
//
// Two checkpoints use it. At ADMISSION the broker asks `evaluateMediaGate` and sets the capture policy's `video` and `traces` from the answer (so an executor is never asked to record what may not be kept).
// At PUBLICATION the evidence pack asks again with the revocation proof (`revocationConfirmed`), and a file whose gate is not whole is deleted, not just hidden.
import { provisionerIsRunScoped, type TestEnvAccount } from "./test-environment.js";
import type { EVIDENCE_WITHHELD_REASONS } from "./evidence.js";

export type MediaKind = "video" | "trace";
export type MediaWithheldReason = Extract<(typeof EVIDENCE_WITHHELD_REASONS)[number], "account_not_run_scoped" | "tier_not_allowed" | "data_not_synthetic" | "company_setting_off" | "revocation_not_confirmed">;

export interface MediaGateInput {
  /** What the approved environment asks to capture. */
  capture: { video: boolean; traces: boolean };
  tier: "sandbox" | "preview" | "shared";
  /** The approved environment's accounts, by provisioner. */
  accounts: ReadonlyArray<Pick<TestEnvAccount, "provisioner" | "profileId">>;
  /** The run's data, as the data guard reports it. Anything but "synthetic" refuses. */
  data: "synthetic" | "unknown" | "real";
  /** The company's less-safe settings (a second person, a fresh sign-in), per kind. */
  companyAllows: { video: boolean; trace: boolean };
  /** Only at publication: the broker's own proof that the accounts were revoked and a login then failed. Absent at admission. */
  revocationConfirmed?: boolean | undefined;
}

export interface MediaGateResult {
  /** Per kind: may it be captured (admission) or kept (publication). */
  allowed: Record<MediaKind, boolean>;
  /** The reason a kind that was asked for is refused: the first failing condition. */
  reasons: Partial<Record<MediaKind, MediaWithheldReason>>;
  /** The tier rule on its own, for the evidence pack's `media.tierAllowed`. */
  tierAllowed: boolean;
}

/** Provisioners that DELETE the account they made (a Cognito test user, the customer's own hook). `seed_command` accounts only die with the sandbox, so they do not make a shared tier safe. */
const DELETING = new Set<TestEnvAccount["provisioner"]>(["cognito_test_pool", "http_hook"]);

/**
 * Tier 1 (sandbox) and tier 2 (preview) always pass this rule: the app and its data are the round's own and are destroyed with it. Tier 3 (shared) passes only when every account is made by a provisioner
 * that deletes it, because the shared environment outlives the round.
 */
export function mediaTierAllowed(tier: MediaGateInput["tier"], accounts: MediaGateInput["accounts"]): boolean {
  if (tier === "sandbox" || tier === "preview") return true;
  return accounts.length > 0 && accounts.every((account) => DELETING.has(account.provisioner));
}

export function evaluateMediaGate(input: MediaGateInput): MediaGateResult {
  const runScoped = input.accounts.length > 0 && input.accounts.every((account) => provisionerIsRunScoped(account.provisioner));
  const tierAllowed = mediaTierAllowed(input.tier, input.accounts);
  const allowed: Record<MediaKind, boolean> = { video: false, trace: false };
  const reasons: MediaGateResult["reasons"] = {};
  for (const kind of ["video", "trace"] as const) {
    const asked = kind === "video" ? input.capture.video : input.capture.traces;
    if (!asked) continue;
    // The first failing condition names the reason, in the design's order.
    const reason: MediaWithheldReason | undefined = !runScoped ? "account_not_run_scoped"
      : !tierAllowed ? "tier_not_allowed"
        : input.data !== "synthetic" ? "data_not_synthetic"
          : !input.companyAllows[kind] ? "company_setting_off"
            : input.revocationConfirmed === false ? "revocation_not_confirmed"
              : undefined;
    if (reason === undefined) allowed[kind] = true; else reasons[kind] = reason;
  }
  return { allowed, reasons, tierAllowed };
}
