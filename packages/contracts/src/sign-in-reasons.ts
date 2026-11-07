// UX1 (platform UX "one connected experience", slice 1): why a browser sign-in ended without signing the person in. The sign-in server
// sends the browser to `/app/signed-out?reason=<one of these>`; the web app turns each into a sentence and a next step. A fixed list, so
// nothing from a provider or an error reaches the address bar.
export const SIGNED_OUT_REASONS = [
  /** The person signed out, or their sign-in ended. */
  "ended",
  /** An admin removed them from the company. */
  "removed",
  /** Something went wrong on Rovara's side. */
  "failed",
  /** They cancelled at the sign-in provider. */
  "cancelled",
  /** The provider (or the company's sign-in rules) refused this account. */
  "refused",
  /** A new person with no company who did not ask to create one (OWNER DECISION 5: nothing is created silently). */
  "no_account",
  /** The sign-in provider could not be reached. */
  "unavailable",
  /** That sign-in method cannot create or join a company here (Slack or company sign-in on Rovara Cloud). */
  "method_unavailable",
] as const;
export type SignedOutReason = (typeof SIGNED_OUT_REASONS)[number];
export const isSignedOutReason = (value: string | null | undefined): value is SignedOutReason =>
  value !== null && value !== undefined && (SIGNED_OUT_REASONS as readonly string[]).includes(value);
