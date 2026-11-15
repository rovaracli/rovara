// The person's last step-up, as Rovara Code put it in their access token (lane ID part 2, plan v3.2 7.2 change 2): `step_up_at` (epoch
// seconds) and `step_up_amr` (how: a one-time emailed code, a passkey Code owns, or the company's own re-authentication). A round trip
// through Slack, Google or GitHub never sets them. A refresh carries them over unchanged, so the age is always the step-up's own.
//
// Cloud reads the claims from the access token it holds for the session. That token came from Code's token endpoint on Cloud's own
// back channel (client secret, PKCE) and lives sealed in Cloud's store; the browser never sees or sends it, so nothing a request carries
// can set these claims. Code checks the same claims itself on its own sensitive routes; this check guards Cloud's own data.
export const STEP_UP_METHODS = Object.freeze(["email_code", "passkey", "company_reauth"] as const);
export type StepUpMethod = (typeof STEP_UP_METHODS)[number];
/** Code's window when a company sets none (DEVELOPER_STEP_UP_WINDOW_SECONDS); a company's may only be shorter. */
export const STEP_UP_WINDOW_SECONDS = 600;
/** A step-up time this far ahead of Cloud's clock still reads; further ahead, it does not. */
export const STEP_UP_SKEW_SECONDS = 30;
/** The `acr_values` word that asks Code for a step-up at sign-in (OpenID Connect Core 3.1.2.1). */
export const STEP_UP_ACR = "step-up";

export interface StepUp { at: number; method: StepUpMethod }

/** The step-up claims of a token, or undefined when it carries none or carries any that do not read (as Code's own `stepUpOf`). */
export function stepUpClaim(accessToken: string): StepUp | undefined {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/u.test(parts[1]!)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const at = (payload as Record<string, unknown>)["step_up_at"];
  const method = (payload as Record<string, unknown>)["step_up_amr"];
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0 || at > 8_640_000_000_000) return undefined;
  if (typeof method !== "string" || !(STEP_UP_METHODS as readonly string[]).includes(method)) return undefined;
  return { at, method: method as StepUpMethod };
}

/** The token's step-up when it is at most `windowSeconds` old (and never older than Code's own window), else undefined. */
export function freshStepUp(accessToken: string, nowMs: number, windowSeconds: number): StepUp | undefined {
  const claim = stepUpClaim(accessToken);
  if (claim === undefined || !Number.isSafeInteger(windowSeconds) || windowSeconds < 0) return undefined;
  const now = Math.floor(nowMs / 1000);
  if (claim.at > now + STEP_UP_SKEW_SECONDS) return undefined;
  return now - claim.at <= Math.min(windowSeconds, STEP_UP_WINDOW_SECONDS) ? claim : undefined;
}
