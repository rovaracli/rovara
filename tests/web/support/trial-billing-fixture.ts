// Fixtures for the trial and billing screens, built from the API doc (briefs/trial-billing-api.md, section 10). Shared by the jsdom tests and the Chromium journeys (which feed them through page.route).
export const ADMIN_ID = "a".repeat(64), MAYA_ID = "b".repeat(64), SAM_ID = "c".repeat(64);
type Json = Record<string, unknown>;

export function models(over: Json = {}): Json { return { kind: "models", unit: "usd", refresh: "monthly", period: { month: "2026-11" }, granted: 500, used: 200, held: 0, left: 300, state: "ok", source: "rovara", ...over }; }
export function machine(over: Json = {}): Json { return { kind: "machine", unit: "hours", refresh: "monthly", period: { month: "2026-11" }, granted: 20, used: 4, left: 16, state: "ok", ...over }; }
export function options(over: { stop?: Json; autoBill?: Json; ownKey?: Json } = {}): Json[] {
 return [
  { id: "stop", available: false, unavailableReason: "not_built_yet", summary: "Running tasks pause after their current step. Nothing is deleted.", ...over.stop },
  { id: "auto_bill", available: false, unavailableReason: "billing_not_available", summary: "Keep working and be billed for usage, up to your monthly limit.", ...over.autoBill },
  { id: "own_key", available: true, unavailableReason: null, summary: "Connect your company's own AI provider key.", next: { href: "/app/admin/models" }, ...over.ownKey },
 ];
}
export function trial(over: Json = {}): Json {
 return { phase: "active", plan: "trial", allowances: [models(), machine()], you: { member: { limitUsd: 29, spentUsd: 3.1, committedUsd: 4 }, hitLimit: false, canChoose: false }, ends: { when: "monthly_refresh", text: "Rovara pays for models until the allowance is renewed next month." }, choices: null, ...over };
}
const oneTime = { refresh: "never", period: null };
/** Fixture 1: active, models ok (40% used). */
export const active = (): Json => trial();
/** Fixture 2: models low (85% used), the choices shown to an admin. */
export const nearEnd = (): Json => trial({ allowances: [models({ ...oneTime, used: 42.5, granted: 50, left: 7.5, state: "low" }), machine({ ...oneTime, used: 2, granted: 10, left: 8 })], ends: { when: "allowance_used", text: "Rovara pays for models until the allowance is used up." }, you: { member: null, hitLimit: false, canChoose: true }, choices: { audience: "admins", decided: null, options: options() } });
/** Fixture 3: used up on an active company, a member who hit the limit. */
export const usedUp = (): Json => trial({ allowances: [models({ used: 500, left: 0, state: "used_up" }), machine()], you: { member: { limitUsd: 29, spentUsd: 29, committedUsd: 29 }, hitLimit: true, canChoose: false }, choices: { audience: "you", decided: null, options: options() } });
/** Fixture 4: ended (target), one-time allowance. `canChoose` picks owner vs member. */
export const ended = (canChoose: boolean, over: { options?: Json[]; decided?: Json | null } = {}): Json => trial({ phase: "ended", allowances: [models({ ...oneTime, used: 50, granted: 50, left: 0, state: "used_up" }), machine({ ...oneTime, used: 10, granted: 10, left: 0, state: "used_up" })], ends: { when: "allowance_used", text: "The trial allowance is used up." }, you: { member: null, hitLimit: !canChoose, canChoose }, choices: { audience: canChoose ? "admins" : "you", decided: over.decided ?? null, options: over.options ?? options() } });
export const stopped = (canChoose: boolean): Json => trial({ ...(ended(canChoose)), phase: "stopped", choices: { audience: canChoose ? "admins" : "you", decided: { choice: "stop", by: { id: ADMIN_ID, name: "Priya" }, at: "2026-11-10T10:00:00.000Z" }, options: options() } });

export function invoice(n: number, over: Json = {}): Json {
 return { invoiceId: `inv_${String(n)}`, number: `RV-2026-${String(n).padStart(4, "0")}`, period: { start: "2026-10-01", end: "2026-10-31" }, status: "paid", currency: "USD", totalMinor: 12345, issuedAt: `2026-11-0${String(Math.min(n, 9))}T10:00:00.000Z`, dueAt: null, paidAt: "2026-11-03T10:00:00.000Z", lines: [{ kind: "models", description: "Rovara-provided models, October", quantity: 123.45, unit: "usd_at_cost", amountMinor: 12345 }], hostedUrl: `https://invoices.example/i/${String(n)}`, pdfUrl: `https://invoices.example/pdf/${String(n)}.pdf`, ...over };
}
export function billing(over: Json = {}): Json {
 return { available: true, provider: { configured: true }, plan: "trial", phase: "active", autoBill: { enabled: false, available: false, unavailableReason: "no_payment_method", monthlyCeilingUsd: 500 }, paymentMethod: null, billingContact: null, pastDue: null, invoices: { count: 0, latest: null }, portal: { available: false }, lastEventAt: null, ...over };
}
export const card = (over: Json = {}): Json => ({ kind: "card", brand: "visa", last4: "4242", expMonth: 12, expYear: 2028, status: "valid", updatedAt: "2026-11-01T10:00:00.000Z", ...over });
/** Fixture 5: billed, with a masked card, a paid and an open invoice. */
export const billed = (): Json => billing({ plan: "team", phase: "billed", autoBill: { enabled: true, available: true, unavailableReason: null, monthlyCeilingUsd: 500 }, paymentMethod: card(), billingContact: { email: "billing@acme.example" }, portal: { available: true }, invoices: { count: 2, latest: invoice(2, { status: "open", paidAt: null, dueAt: "2026-11-20T10:00:00.000Z" }) } });
export const pastDue = (): Json => billing({ ...billed(), phase: "past_due", paymentMethod: card({ status: "failed" }), pastDue: { since: "2026-11-09T10:00:00.000Z", amountMinor: 12345, currency: "USD", retryAt: "2026-11-12T10:00:00.000Z", workPausesAt: "2026-11-14T10:00:00.000Z" } });
/** Fixture 7: what the server answers until a provider is chosen. */
export const unavailable = (): Json => billing({ available: false, provider: { configured: false }, autoBill: { enabled: false, available: false, unavailableReason: "billing_not_available", monthlyCeilingUsd: 500 } });
export const invoicePage = (from: number, count: number, next?: string): Json => ({ invoices: Array.from({ length: count }, (_, index) => invoice(from + index)), ...(next === undefined ? {} : { next }) });
export const members = (): Json => ({ members: [{ developerId: ADMIN_ID, name: "Priya", role: "owner" }, { developerId: MAYA_ID, name: "Maya", role: "admin" }, { developerId: SAM_ID, name: "Sam", role: "member" }] });
export const refusal = (code: string, message: string): { status: number; body: unknown } => ({ status: code === "NOT_FOUND" ? 404 : code === "CHANGE_STALE" || code === "IDEMPOTENCY_CONFLICT" ? 409 : code === "CONFIG_INVALID" ? 400 : 403, body: { error: { code, message } } });
